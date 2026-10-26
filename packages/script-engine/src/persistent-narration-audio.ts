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
  createNarrationAudio,
  verifyNarrationAudio,
  NarrationAudioSchema,
} from "./narration-audio-contract.js";

const HashSchema = z.string()
  .regex(/^[a-f0-9]{64}$/);

export const PersistedNarrationRecordSchema =
  z.object({
    version: z.literal(1),
    jobId: z.string().trim().min(1),

    audio: NarrationAudioSchema,

    recordHash: HashSchema,
  }).strict();

export type PersistedNarrationRecord =
  z.infer<typeof PersistedNarrationRecordSchema>;

export interface PersistedNarrationPaths {
  directory: string;
  audioPath: string;
  recordPath: string;
}

export interface PersistedNarrationResult {
  reused: boolean;
  paths: PersistedNarrationPaths;
  record: PersistedNarrationRecord;
}

function sha256(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

export function getPersistedNarrationPaths(
  jobDirectory: string,
  jobId: string,
): PersistedNarrationPaths {
  if (!path.isAbsolute(jobDirectory)) {
    throw new Error(
      "Narration job directory must be absolute",
    );
  }

  if (!jobId.trim()) {
    throw new Error(
      "Narration job ID is required",
    );
  }

  const directory = path.join(
    jobDirectory,
    "narration",
    sha256(jobId),
  );

  return {
    directory,
    audioPath: path.join(
      directory,
      "narration.wav",
    ),
    recordPath: path.join(
      directory,
      "narration.json",
    ),
  };
}

function createRecord(
  jobId: string,
  bytes: Buffer,
): PersistedNarrationRecord {
  const audio = createNarrationAudio(
    jobId,
    bytes,
  );

  const payload = {
    version: 1 as const,
    jobId,
    audio,
  };

  return PersistedNarrationRecordSchema.parse({
    ...payload,
    recordHash: sha256(
      JSON.stringify(payload),
    ),
  });
}

export function verifyPersistedNarrationRecord(
  input: unknown,
  jobId: string,
  bytes: Buffer,
): PersistedNarrationRecord {
  const record =
    PersistedNarrationRecordSchema.parse(
      input,
    );

  if (
    record.jobId !== jobId ||
    record.audio.jobId !== jobId
  ) {
    throw new Error(
      "Persisted narration job mismatch",
    );
  }

  const payload = {
    version: record.version,
    jobId: record.jobId,
    audio: record.audio,
  };

  if (
    record.recordHash !==
    sha256(JSON.stringify(payload))
  ) {
    throw new Error(
      "Persisted narration record integrity mismatch",
    );
  }

  verifyNarrationAudio(
    record.audio,
    bytes,
  );

  return record;
}

/**
 * Publish without overwriting an existing file.
 * Temporary files are created in the same directory
 * so hard links remain on the same filesystem.
 */
async function publishCreateOnly(
  destination: string,
  bytes: Buffer,
): Promise<void> {
  const temporary = path.join(
    path.dirname(destination),
    `.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(
      temporary,
      bytes,
      { flag: "wx" },
    );

    try {
      await link(
        temporary,
        destination,
      );
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

async function readPersisted(
  paths: PersistedNarrationPaths,
  jobId: string,
): Promise<PersistedNarrationRecord | null> {
  let audioBytes: Buffer;
  let recordBytes: Buffer;

  try {
    [audioBytes, recordBytes] =
      await Promise.all([
        readFile(paths.audioPath),
        readFile(paths.recordPath),
      ]);
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException).code;

    if (code !== "ENOENT") {
      throw error;
    }

    // Distinguish fully missing persistence from
    // an incomplete publication.
    const { access } =
      await import("node:fs/promises");

    const exists = async (file: string) => {
      try {
        await access(file);
        return true;
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code ===
          "ENOENT"
        ) {
          return false;
        }

        throw e;
      }
    };

    const [audioExists, recordExists] =
      await Promise.all([
        exists(paths.audioPath),
        exists(paths.recordPath),
      ]);

    if (!audioExists && !recordExists) {
      return null;
    }

    throw new Error(
      "Incomplete persisted narration publication",
    );
  }

  return verifyPersistedNarrationRecord(
    JSON.parse(recordBytes.toString("utf8")),
    jobId,
    audioBytes,
  );
}

export class PersistentNarrationAudioStore {
  constructor(
    private readonly jobDirectory:
      (jobId: string) => string,
  ) {}

  async save(
    jobId: string,
    wavBytes: Buffer,
  ): Promise<PersistedNarrationResult> {
    const paths =
      getPersistedNarrationPaths(
        this.jobDirectory(jobId),
        jobId,
      );

    // Reject malformed audio before touching disk.
    const candidate = createRecord(
      jobId,
      wavBytes,
    );

    const existing = await readPersisted(
      paths,
      jobId,
    );

    if (existing) {
      if (
        existing.recordHash !==
        candidate.recordHash
      ) {
        throw new Error(
          "Conflicting persisted narration",
        );
      }

      return {
        reused: true,
        paths,
        record: existing,
      };
    }

    await mkdir(paths.directory, {
      recursive: true,
    });

    await publishCreateOnly(
      paths.audioPath,
      wavBytes,
    );

    await publishCreateOnly(
      paths.recordPath,
      Buffer.from(
        JSON.stringify(candidate),
      ),
    );

    const published = await readPersisted(
      paths,
      jobId,
    );

    if (!published) {
      throw new Error(
        "Narration publication missing",
      );
    }

    if (
      published.recordHash !==
      candidate.recordHash
    ) {
      throw new Error(
        "Conflicting persisted narration",
      );
    }

    return {
      reused: false,
      paths,
      record: published,
    };
  }

  async load(
    jobId: string,
  ): Promise<PersistedNarrationResult> {
    const paths =
      getPersistedNarrationPaths(
        this.jobDirectory(jobId),
        jobId,
      );

    const record = await readPersisted(
      paths,
      jobId,
    );

    if (!record) {
      throw new Error(
        "Persisted narration missing",
      );
    }

    return {
      reused: true,
      paths,
      record,
    };
  }

  async validate(
    jobId: string,
    expectedRecordHash: string,
  ): Promise<boolean> {
    try {
      const result = await this.load(jobId);

      return (
        result.record.recordHash ===
        expectedRecordHash
      );
    } catch {
      return false;
    }
  }
}
