import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  createUnifiedVideoQaReport,
  UnifiedVideoQaReportSchema,
  type CreateUnifiedVideoQaInput,
  type UnifiedVideoQaReport,
  type VideoQaReleasePolicy,
} from "./video-qa-release-gate.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const VideoQaRecordSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  videoSha256: Hash,
  compositionHash: Hash,
  report: UnifiedVideoQaReportSchema,
  recordHash: Hash,
}).strict();

export const VideoQaCheckpointSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  videoSha256: Hash,
  compositionHash: Hash,
  reportHash: Hash,
  recordHash: Hash,
  decision: z.enum(["PASS", "REVIEW", "FAIL"]),
}).strict();

export type VideoQaRecord =
  z.infer<typeof VideoQaRecordSchema>;

export type VideoQaCheckpoint =
  z.infer<typeof VideoQaCheckpointSchema>;

/**
 * This port is a trusted production boundary.
 *
 * The implementation MUST independently verify:
 * - persisted MP4 bytes and SHA-256
 * - current M6/M7 dependency identities
 * - media rights and upstream asset integrity
 * - actual decoded frame and audio QA reports
 * - canonical caption/visual-variety reports
 *
 * Never fabricate empty QA findings.
 */
export interface VerifiedVideoQaEvidencePort {
  load(
    jobId: string,
  ): Promise<CreateUnifiedVideoQaInput>;
}

export interface PersistentVideoQaOptions {
  jobDirectory(jobId: string): string;
  evidence: VerifiedVideoQaEvidencePort;
  policy?: VideoQaReleasePolicy;
}

function hash(value: Buffer | string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function jsonHash(value: unknown): string {
  return hash(JSON.stringify(value));
}

function isNotFound(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException)?.code ===
    "ENOENT"
  );
}

export function getVideoQaPaths(
  jobDirectory: string,
  jobId: string,
  policyId?: string,
) {
  if (!path.isAbsolute(jobDirectory) || !jobId.trim()) {
    throw new Error(
      "M8 QA requires absolute job directory and job ID",
    );
  }

  const sub = policyId ? hash(`${jobId}:${policyId}`) : hash(jobId);

  return {
    directory: path.join(
      jobDirectory,
      "video-qa",
      sub,
    ),
    recordPath: path.join(
      jobDirectory,
      "video-qa",
      sub,
      "qa-report.json",
    ),
  };
}

function checkpointFor(
  record: VideoQaRecord,
): VideoQaCheckpoint {
  return {
    version: 1,
    jobId: record.jobId,
    videoSha256: record.videoSha256,
    compositionHash: record.compositionHash,
    reportHash: record.report.reportHash,
    recordHash: record.recordHash,
    decision: record.report.decision,
  };
}

async function publishCreateOnly(
  destination: string,
  bytes: string,
): Promise<void> {
  const temporary = path.join(
    path.dirname(destination),
    `.qa-${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporary, bytes, {
      flag: "wx",
    });

    try {
      await link(temporary, destination);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !==
        "EEXIST"
      ) {
        throw error;
      }
      // A concurrent publisher won. Caller must
      // validate that record independently.
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export class PersistentVideoQaStore {
  constructor(
    private readonly options: PersistentVideoQaOptions,
  ) {}

  private paths(jobId: string) {
    return getVideoQaPaths(
      this.options.jobDirectory(jobId),
      jobId,
      this.options.policy?.policyId,
    );
  }

  private async reconstruct(jobId: string) {
    if (!jobId.trim()) {
      throw new Error("M8 QA job ID required");
    }

    const evidence =
      await this.options.evidence.load(jobId);

    if (evidence.composition.jobId !== jobId) {
      throw new Error(
        "M8 QA evidence job identity mismatch",
      );
    }

    const report = createUnifiedVideoQaReport(
      evidence,
      this.options.policy,
    );

    if (report.jobId !== jobId) {
      throw new Error(
        "M8 QA report job identity mismatch",
      );
    }

    const payload = {
      version: 1 as const,
      jobId,
      videoSha256: report.videoSha256,
      compositionHash: report.compositionHash,
      report,
    };

    return VideoQaRecordSchema.parse({
      ...payload,
      recordHash: jsonHash(payload),
    });
  }

  private async readCommitted(
    jobId: string,
  ): Promise<VideoQaRecord | null> {
    let bytes: Buffer;

    try {
      bytes = await readFile(
        this.paths(jobId).recordPath,
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    const record = VideoQaRecordSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );

    const { recordHash, ...payload } = record;

    if (recordHash !== jsonHash(payload)) {
      throw new Error(
        "M8 QA record integrity mismatch",
      );
    }

    const { reportHash, ...reportPayload } =
      record.report;

    if (
      reportHash !== jsonHash(reportPayload) ||
      record.jobId !== jobId ||
      record.report.jobId !== jobId ||
      record.videoSha256 !==
        record.report.videoSha256 ||
      record.compositionHash !==
        record.report.compositionHash
    ) {
      throw new Error(
        "M8 QA report integrity mismatch",
      );
    }

    return record;
  }

  async run(jobId: string): Promise<{
    reused: boolean;
    record: VideoQaRecord;
    checkpoint: VideoQaCheckpoint;
  }> {
    // Fresh verification is mandatory even on reuse.
    const canonical = await this.reconstruct(jobId);

    const existing = await this.readCommitted(jobId);

    if (existing) {
      if (
        JSON.stringify(existing) !==
        JSON.stringify(canonical)
      ) {
        throw new Error(
          "M8 QA immutable record dependency mismatch",
        );
      }

      return {
        reused: true,
        record: existing,
        checkpoint: checkpointFor(existing),
      };
    }

    const paths = this.paths(jobId);

    await mkdir(paths.directory, {
      recursive: true,
    });

    await publishCreateOnly(
      paths.recordPath,
      JSON.stringify(canonical),
    );

    const committed =
      await this.readCommitted(jobId);

    if (
      !committed ||
      JSON.stringify(committed) !==
        JSON.stringify(canonical)
    ) {
      throw new Error(
        "M8 QA concurrent publication mismatch",
      );
    }

    return {
      reused: false,
      record: committed,
      checkpoint: checkpointFor(committed),
    };
  }

  async load(
    jobId: string,
  ): Promise<VideoQaRecord | null> {
    return this.readCommitted(jobId);
  }

  async validate(
    jobId: string,
    candidate: unknown,
  ): Promise<boolean> {
    const parsed =
      VideoQaCheckpointSchema.safeParse(
        candidate,
      );

    if (
      !parsed.success ||
      parsed.data.jobId !== jobId
    ) {
      return false;
    }

    try {
      const canonical =
        await this.reconstruct(jobId);

      const committed =
        await this.readCommitted(jobId);

      return (
        committed !== null &&
        JSON.stringify(committed) ===
          JSON.stringify(canonical) &&
        JSON.stringify(
          checkpointFor(committed),
        ) === JSON.stringify(parsed.data)
      );
    } catch {
      return false;
    }
  }
}
