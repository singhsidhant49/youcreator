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
  AudioAlignedVisualPackageSchema,
  type AudioAlignedVisualPackage,
} from "./audio-aligned-visual-reconstruction.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const PersistedAudioAlignedVisualRecordSchema =
  z.object({
    version: z.literal(1),
    jobId: z.string().min(1),

    m5VisualPackageHash: HashSchema,
    framePlanHash: HashSchema,
    audioSha256: HashSchema,

    visualPackageHash: HashSchema,
    audioAlignedVisualHash: HashSchema,

    visual: AudioAlignedVisualPackageSchema,

    recordHash: HashSchema,
  }).strict();

export type PersistedAudioAlignedVisualRecord =
  z.infer<
    typeof PersistedAudioAlignedVisualRecordSchema
  >;

export const AudioAlignedVisualCheckpointSchema =
  z.object({
    version: z.literal(1),
    jobId: z.string().min(1),

    artifactPath: z.string().min(1),

    recordHash: HashSchema,
    audioAlignedVisualHash: HashSchema,

    m5VisualPackageHash: HashSchema,
    framePlanHash: HashSchema,
    audioSha256: HashSchema,

    visualPackageHash: HashSchema,
    totalFrames: z.number().int().positive(),
    shotCount: z.number().int().positive(),
  }).strict();

export type AudioAlignedVisualCheckpoint =
  z.infer<typeof AudioAlignedVisualCheckpointSchema>;

export interface AudioAlignedVisualReconstructionPort {
  reconstruct(
    jobId: string,
  ): Promise<AudioAlignedVisualPackage>;
}

export interface PersistentAudioAlignedVisualOptions {
  jobDirectory(jobId: string): string;

  /**
   * Must reload and verify M3/M4/M5/M6 inputs
   * before reconstructing the visual package.
   *
   * No TTS generation or media acquisition is
   * permitted inside this callback.
   */
  reconstruction: AudioAlignedVisualReconstructionPort;
}

export interface PersistedAudioAlignedVisualResult {
  reused: boolean;
  artifactPath: string;
  record: PersistedAudioAlignedVisualRecord;
  checkpoint: AudioAlignedVisualCheckpoint;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function hashJobId(jobId: string): string {
  return createHash("sha256")
    .update(jobId)
    .digest("hex");
}

function recordPayload(
  record: PersistedAudioAlignedVisualRecord,
) {
  return {
    version: record.version,
    jobId: record.jobId,

    m5VisualPackageHash:
      record.m5VisualPackageHash,

    framePlanHash:
      record.framePlanHash,

    audioSha256:
      record.audioSha256,

    visualPackageHash:
      record.visualPackageHash,

    audioAlignedVisualHash:
      record.audioAlignedVisualHash,

    visual: record.visual,
  };
}

function createRecord(
  jobId: string,
  input: AudioAlignedVisualPackage,
): PersistedAudioAlignedVisualRecord {
  const visual =
    AudioAlignedVisualPackageSchema.parse(input);

  if (visual.jobId !== jobId) {
    throw new Error(
      "Persisted M6 visual job identity mismatch",
    );
  }

  const payload = {
    version: 1 as const,
    jobId,

    m5VisualPackageHash:
      visual.m5VisualPackageHash,

    framePlanHash:
      visual.framePlanHash,

    audioSha256:
      visual.audioSha256,

    visualPackageHash:
      visual.visual.visualPackageHash,

    audioAlignedVisualHash:
      visual.audioAlignedVisualHash,

    visual,
  };

  return PersistedAudioAlignedVisualRecordSchema.parse({
    ...payload,
    recordHash: hash(payload),
  });
}

export function verifyPersistedAudioAlignedVisualRecord(
  candidate: unknown,
  expectedJobId: string,
): PersistedAudioAlignedVisualRecord {
  const record =
    PersistedAudioAlignedVisualRecordSchema.parse(
      candidate,
    );

  if (
    record.jobId !== expectedJobId ||
    record.visual.jobId !== expectedJobId ||
    record.visual.visual.jobId !== expectedJobId
  ) {
    throw new Error(
      "Persisted M6 visual job identity mismatch",
    );
  }

  const {
    audioAlignedVisualHash: _outerHash,
    ...outerPayload
  } = record.visual;

  const {
    visualPackageHash: _innerHash,
    ...innerPayload
  } = record.visual.visual;

  if (
    record.m5VisualPackageHash !==
      record.visual.m5VisualPackageHash ||
    record.framePlanHash !==
      record.visual.framePlanHash ||
    record.audioSha256 !==
      record.visual.audioSha256 ||
    record.visualPackageHash !==
      record.visual.visual.visualPackageHash ||
    record.audioAlignedVisualHash !==
      record.visual.audioAlignedVisualHash ||
    record.recordHash !== hash(recordPayload(record)) ||
    record.audioAlignedVisualHash !==
      hash(outerPayload) ||
    record.visualPackageHash !==
      hash(innerPayload)
  ) {
    throw new Error(
      "Persisted M6 visual integrity mismatch",
    );
  }

  return record;
}

export function getPersistedAudioAlignedVisualPath(
  jobDirectory: string,
  jobId: string,
): string {
  if (!path.isAbsolute(jobDirectory)) {
    throw new Error(
      "M6 visual job directory must be absolute",
    );
  }

  if (!jobId.trim()) {
    throw new Error(
      "M6 visual job ID is required",
    );
  }

  return path.join(
    jobDirectory,
    "audio-aligned-visual",
    hashJobId(jobId),
    "audio-aligned-visual.json",
  );
}

async function readExisting(
  artifactPath: string,
  jobId: string,
): Promise<PersistedAudioAlignedVisualRecord | null> {
  let contents: string;

  try {
    contents = await readFile(artifactPath, "utf8");
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code ===
      "ENOENT"
    ) {
      return null;
    }

    throw error;
  }

  return verifyPersistedAudioAlignedVisualRecord(
    JSON.parse(contents),
    jobId,
  );
}

/**
 * Publishes immutable JSON with a create-only
 * hard link, never replacing an existing record.
 */
async function publishCreateOnly(
  artifactPath: string,
  record: PersistedAudioAlignedVisualRecord,
): Promise<void> {
  const directory = path.dirname(artifactPath);

  await mkdir(directory, { recursive: true });

  const temporary = path.join(
    directory,
    `.audio-aligned-visual.${randomUUID()}.tmp`,
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

function createCheckpoint(
  artifactPath: string,
  record: PersistedAudioAlignedVisualRecord,
): AudioAlignedVisualCheckpoint {
  return AudioAlignedVisualCheckpointSchema.parse({
    version: 1,
    jobId: record.jobId,

    artifactPath,

    recordHash: record.recordHash,

    audioAlignedVisualHash:
      record.audioAlignedVisualHash,

    m5VisualPackageHash:
      record.m5VisualPackageHash,

    framePlanHash:
      record.framePlanHash,

    audioSha256:
      record.audioSha256,

    visualPackageHash:
      record.visualPackageHash,

    totalFrames:
      record.visual.visual.totalFrames,

    shotCount:
      record.visual.visual.shotCount,
  });
}

export class PersistentAudioAlignedVisualStore {
  constructor(
    private readonly options:
      PersistentAudioAlignedVisualOptions,
  ) {}

  private path(jobId: string): string {
    return getPersistedAudioAlignedVisualPath(
      this.options.jobDirectory(jobId),
      jobId,
    );
  }

  /**
   * Existing artifacts are independently rebuilt
   * against currently verified upstream inputs.
   */
  async run(
    jobId: string,
  ): Promise<PersistedAudioAlignedVisualResult> {
    const artifactPath = this.path(jobId);
    const existing = await readExisting(
      artifactPath,
      jobId,
    );

    const canonical =
      await this.options.reconstruction.reconstruct(
        jobId,
      );

    const expected = createRecord(
      jobId,
      canonical,
    );

    if (existing) {
      if (
        existing.recordHash !== expected.recordHash
      ) {
        throw new Error(
          "Persisted M6 visual is no longer canonical",
        );
      }

      return {
        reused: true,
        artifactPath,
        record: existing,
        checkpoint: createCheckpoint(
          artifactPath,
          existing,
        ),
      };
    }

    await publishCreateOnly(
      artifactPath,
      expected,
    );

    // Always inspect the published artifact.
    // Another writer may have won a race.
    const published = await readExisting(
      artifactPath,
      jobId,
    );

    if (!published) {
      throw new Error(
        "M6 visual publication missing",
      );
    }

    if (
      published.recordHash !== expected.recordHash
    ) {
      throw new Error(
        "Conflicting M6 visual publication",
      );
    }

    return {
      reused: false,
      artifactPath,
      record: published,
      checkpoint: createCheckpoint(
        artifactPath,
        published,
      ),
    };
  }

  async load(
    jobId: string,
  ): Promise<PersistedAudioAlignedVisualResult> {
    const artifactPath = this.path(jobId);

    const record = await readExisting(
      artifactPath,
      jobId,
    );

    if (!record) {
      throw new Error(
        "Persisted M6 visual missing",
      );
    }

    return {
      reused: true,
      artifactPath,
      record,
      checkpoint: createCheckpoint(
        artifactPath,
        record,
      ),
    };
  }

  /**
   * M1 checkpoint reuse validation.
   *
   * A valid hash on disk is insufficient.
   * Current upstream media rights, image bytes,
   * audio identity and M3/M5 packages must be
   * reverified through the reconstruction port.
   */
  async validate(
    jobId: string,
    checkpoint: AudioAlignedVisualCheckpoint,
  ): Promise<boolean> {
    try {
      const parsed =
        AudioAlignedVisualCheckpointSchema.parse(
          checkpoint,
        );

      if (
        parsed.jobId !== jobId ||
        parsed.artifactPath !== this.path(jobId)
      ) {
        return false;
      }

      const existing = await this.load(jobId);

      const canonical =
        await this.options.reconstruction.reconstruct(
          jobId,
        );

      const expected = createRecord(
        jobId,
        canonical,
      );

      if (
        existing.record.recordHash !==
          expected.recordHash
      ) {
        return false;
      }

      return (
        JSON.stringify(parsed) ===
        JSON.stringify(existing.checkpoint)
      );
    } catch {
      return false;
    }
  }
}
