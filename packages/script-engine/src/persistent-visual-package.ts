import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  RendererReadyVisualPackageSchema,
  type RendererReadyVisualPackage,
} from "./renderer-ready-visual-package.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const PersistedVisualRecordSchema = z.object({
  version: z.literal(1),

  jobId: z.string().trim().min(1),

  packageHash: HashSchema,

  visual: RendererReadyVisualPackageSchema,

  recordHash: HashSchema,
}).strict();

export type PersistedVisualRecord = z.infer<
  typeof PersistedVisualRecordSchema
>;

export interface VisualPreparationPort {
  prepare(input: {
    jobId: string;
    expected?: {
      visual?: RendererReadyVisualPackage;
    };
  }): Promise<{
    visual: RendererReadyVisualPackage;
  }>;
}

export interface PersistentVisualPackageOptions {
  /**
   * Canonical M1 job directory resolver.
   */
  jobDirectory(jobId: string): string;

  /**
   * Must be backed by the real M3/M4 verification
   * and M5 canonical reconstruction.
   */
  preparation: VisualPreparationPort;
}

export interface PersistedVisualResult {
  reused: boolean;
  artifactPath: string;
  record: PersistedVisualRecord;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function payloadWithoutRecordHash(
  record: PersistedVisualRecord,
) {
  return {
    version: record.version,
    jobId: record.jobId,
    packageHash: record.packageHash,
    visual: record.visual,
  };
}

function createRecord(
  jobId: string,
  visual: RendererReadyVisualPackage,
): PersistedVisualRecord {
  const parsed =
    RendererReadyVisualPackageSchema.parse(visual);

  if (parsed.jobId !== jobId) {
    throw new Error(
      "Persistent visual job identity mismatch",
    );
  }

  const payload = {
    version: 1 as const,
    jobId,
    packageHash: sha256(parsed),
    visual: parsed,
  };

  return PersistedVisualRecordSchema.parse({
    ...payload,
    recordHash: sha256(payload),
  });
}

export function verifyPersistedVisualRecord(
  input: unknown,
  expectedJobId: string,
): PersistedVisualRecord {
  const record =
    PersistedVisualRecordSchema.parse(input);

  if (
    record.jobId !== expectedJobId ||
    record.visual.jobId !== expectedJobId
  ) {
    throw new Error(
      "Persistent visual job identity mismatch",
    );
  }

  if (
    sha256(record.visual) !== record.packageHash ||
    sha256(payloadWithoutRecordHash(record)) !==
      record.recordHash
  ) {
    throw new Error(
      "Persistent visual record integrity mismatch",
    );
  }

  // The visual planner's own package identity
  // is also independently checked.
  const {
    visualPackageHash: _hash,
    ...visualPayload
  } = record.visual;

  if (
    sha256(visualPayload) !==
    record.visual.visualPackageHash
  ) {
    throw new Error(
      "Persistent visual package integrity mismatch",
    );
  }

  return record;
}

/**
 * Uses a job-ID digest so caller-controlled job
 * IDs cannot escape the configured directory.
 */
export function getPersistedVisualPath(
  jobDirectory: string,
  jobId: string,
): string {
  if (!path.isAbsolute(jobDirectory)) {
    throw new Error(
      "Visual job directory must be absolute",
    );
  }

  if (!jobId.trim()) {
    throw new Error("Visual job ID is required");
  }

  return path.join(
    jobDirectory,
    "visual",
    sha256(jobId),
    "renderer-ready.json",
  );
}

async function readExisting(
  artifactPath: string,
  jobId: string,
): Promise<PersistedVisualRecord | null> {
  let contents: string;

  try {
    contents = await readFile(
      artifactPath,
      "utf8",
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code ===
      "ENOENT"
    ) {
      return null;
    }

    throw error;
  }

  // Malformed existing artifacts are never treated
  // as missing, because that could hide tampering.
  return verifyPersistedVisualRecord(
    JSON.parse(contents),
    jobId,
  );
}

/**
 * Atomically publishes a new immutable record.
 *
 * link() is create-only: unlike rename(), it does
 * not replace an existing destination.
 *
 * Every concurrent writer must subsequently verify
 * and accept the same persisted canonical record.
 */
async function publishCreateOnly(
  artifactPath: string,
  record: PersistedVisualRecord,
): Promise<void> {
  const directory = path.dirname(artifactPath);

  await mkdir(directory, {
    recursive: true,
  });

  const temporary = path.join(
    directory,
    `.renderer-ready.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(
      temporary,
      JSON.stringify(record),
      { flag: "wx" },
    );

    try {
      await link(temporary, artifactPath);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !==
        "EEXIST"
      ) {
        throw error;
      }
    }
  } finally {
    await unlink(temporary).catch(
      (error: unknown) => {
        if (
          (error as NodeJS.ErrnoException).code !==
          "ENOENT"
        ) {
          throw error;
        }
      },
    );
  }
}

export class PersistentVisualPackageStore {
  constructor(
    private readonly options:
      PersistentVisualPackageOptions,
  ) {}

  async run(
    jobId: string,
  ): Promise<PersistedVisualResult> {
    if (!jobId.trim()) {
      throw new Error(
        "Persistent visual job ID is required",
      );
    }

    const jobDirectory =
      this.options.jobDirectory(jobId);

    const artifactPath =
      getPersistedVisualPath(
        jobDirectory,
        jobId,
      );

    const existing = await readExisting(
      artifactPath,
      jobId,
    );

    if (existing) {
      // CRITICAL:
      // Do not trust a valid-looking record alone.
      //
      // This invokes current M3/M4 verification,
      // usage-rights checks, asset checks and M5
      // canonical reconstruction.
      const verified =
        await this.options.preparation.prepare({
          jobId,
          expected: {
            visual: existing.visual,
          },
        });

      const canonical = createRecord(
        jobId,
        verified.visual,
      );

      if (
        canonical.recordHash !==
        existing.recordHash
      ) {
        throw new Error(
          "Persisted visual is no longer canonical",
        );
      }

      return {
        reused: true,
        artifactPath,
        record: existing,
      };
    }

    // No saved output exists.
    // The real preparation is verification-only:
    // it cannot resolve new media.
    const prepared =
      await this.options.preparation.prepare({
        jobId,
      });

    const record = createRecord(
      jobId,
      prepared.visual,
    );

    await publishCreateOnly(
      artifactPath,
      record,
    );

    // Read the published artifact, never assume
    // this process won a concurrent publication.
    const published = await readExisting(
      artifactPath,
      jobId,
    );

    if (!published) {
      throw new Error(
        "Persistent visual publication missing",
      );
    }

    if (
      published.recordHash !== record.recordHash
    ) {
      throw new Error(
        "Conflicting persistent visual publication",
      );
    }

    return {
      reused: false,
      artifactPath,
      record: published,
    };
  }

  /**
   * Used by M1 checkpoint validation later.
   *
   * Returns false for failed revalidation rather
   * than trusting the presence of a saved file.
   */
  async validate(
    jobId: string,
    expectedPackageHash: string,
  ): Promise<boolean> {
    try {
      const artifactPath =
        getPersistedVisualPath(
          this.options.jobDirectory(jobId),
          jobId,
        );

      const existing = await readExisting(
        artifactPath,
        jobId,
      );

      if (
        !existing ||
        existing.packageHash !==
          expectedPackageHash
      ) {
        return false;
      }

      const verified =
        await this.options.preparation.prepare({
          jobId,
          expected: {
            visual: existing.visual,
          },
        });

      const canonical = createRecord(
        jobId,
        verified.visual,
      );

      return (
        canonical.recordHash ===
        existing.recordHash
      );
    } catch {
      return false;
    }
  }
}
