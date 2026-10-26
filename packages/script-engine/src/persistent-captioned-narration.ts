import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  createNarrationAudio,
  verifyNarrationAudio,
} from "./narration-audio-contract.js";

import {
  verifyNarrationWordAlignment,
  type NarrationWordAlignment,
} from "./narration-alignment-contract.js";

import {
  type CaptionedNarrationCheckpoint,
  type CaptionedNarrationManifest,
  type CaptionedNarrationRequestIdentity,
  createCaptionedNarrationCheckpoint,
  createCaptionedNarrationManifest,
  verifyCaptionedNarrationManifest,
} from "./captioned-narration-contract.js";

export interface PersistedCaptionedNarrationPaths {
  directory: string;
  attemptPath: string;
  audioPath: string;
  alignmentPath: string;
  manifestPath: string;
}

export interface PersistedCaptionedNarrationResult {
  reused: boolean;
  paths: PersistedCaptionedNarrationPaths;
  manifest: CaptionedNarrationManifest;
  audioBytes: Buffer;
  alignment: NarrationWordAlignment;
  checkpoint: CaptionedNarrationCheckpoint;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function getPersistedCaptionedNarrationPaths(
  jobDirectory: string,
  jobId: string,
): PersistedCaptionedNarrationPaths {
  if (!path.isAbsolute(jobDirectory)) {
    throw new Error(
      "Captioned narration job directory must be absolute",
    );
  }

  if (!jobId.trim()) {
    throw new Error("Captioned narration job ID is required");
  }

  const directory = path.join(
    jobDirectory,
    "captioned-narration",
    sha256(jobId),
  );

  return {
    directory,
    attemptPath: path.join(
      directory,
      "generation-attempt.json",
    ),
    audioPath: path.join(directory, "narration.wav"),
    alignmentPath: path.join(directory, "alignment.json"),
    manifestPath: path.join(directory, "manifest.json"),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Publish without overwriting an existing file.
 * Creates a unique temp file on the same filesystem and atomically links it.
 */
async function publishCreateOnly(
  destination: string,
  bytes: Buffer,
): Promise<void> {
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporary, bytes, { flag: "wx" });

    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function readPersisted(
  paths: PersistedCaptionedNarrationPaths,
  jobId: string,
): Promise<PersistedCaptionedNarrationResult | null> {
  const [manifestExists, audioExists, alignmentExists] =
    await Promise.all([
      fileExists(paths.manifestPath),
      fileExists(paths.audioPath),
      fileExists(paths.alignmentPath),
    ]);

  // Nothing exists yet: clean initial state
  if (!manifestExists && !audioExists && !alignmentExists) {
    return null;
  }

  // The manifest is the single immutable final commit marker.
  // If payload exists without manifest, the write was interrupted before commit.
  if (!manifestExists) {
    throw new Error(
      "Incomplete persisted captioned narration publication: commit manifest missing",
    );
  }

  // If manifest exists, all payload files must also exist.
  if (!audioExists || !alignmentExists) {
    throw new Error(
      "Incomplete persisted captioned narration publication: payload missing",
    );
  }

  let manifestBytes: Buffer;
  let audioBytes: Buffer;
  let alignmentBytes: Buffer;

  try {
    [manifestBytes, audioBytes, alignmentBytes] = await Promise.all([
      readFile(paths.manifestPath),
      readFile(paths.audioPath),
      readFile(paths.alignmentPath),
    ]);
  } catch (error) {
    throw new Error(
      `Incomplete persisted captioned narration publication: read failed (${(error as Error).message})`,
    );
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error(
      "Persisted captioned narration manifest corrupted: invalid JSON",
    );
  }

  const manifest = verifyCaptionedNarrationManifest(
    manifestJson,
    jobId,
  );

  verifyNarrationAudio(manifest.audio, audioBytes);

  let alignmentJson: unknown;
  try {
    alignmentJson = JSON.parse(alignmentBytes.toString("utf8"));
  } catch {
    throw new Error(
      "Persisted captioned narration alignment corrupted: invalid JSON",
    );
  }

  const alignment = verifyNarrationWordAlignment(
    alignmentJson,
    manifest.audio,
  );

  if (alignment.alignmentHash !== manifest.alignmentHash) {
    throw new Error(
      "Persisted captioned narration alignment hash mismatch",
    );
  }

  if (manifest.audio.sha256 !== manifest.audioSha256) {
    throw new Error(
      "Persisted captioned narration audio SHA-256 mismatch",
    );
  }

  const checkpoint = createCaptionedNarrationCheckpoint(
    paths,
    manifest,
  );

  return {
    reused: true,
    paths,
    manifest,
    audioBytes,
    alignment,
    checkpoint,
  };
}

export class PersistentCaptionedNarrationStore {
  constructor(
    private readonly jobDirectory: (jobId: string) => string,
  ) {}

  getPaths(jobId: string): PersistedCaptionedNarrationPaths {
    return getPersistedCaptionedNarrationPaths(
      this.jobDirectory(jobId),
      jobId,
    );
  }

  async save(
    request: CaptionedNarrationRequestIdentity,
    audioBytes: Buffer,
    alignment: NarrationWordAlignment,
  ): Promise<PersistedCaptionedNarrationResult> {
    const paths = this.getPaths(request.jobId);

    // Validate audio and alignment before any file operations
    const audio = createNarrationAudio(
      request.jobId,
      audioBytes,
    );

    verifyNarrationWordAlignment(
      alignment,
      audio,
    );

    const candidateManifest = createCaptionedNarrationManifest({
      jobId: request.jobId,
      request,
      audio,
      alignment,
    });

    const existing = await readPersisted(paths, request.jobId);

    if (existing) {
      if (
        existing.manifest.manifestHash !==
        candidateManifest.manifestHash
      ) {
        throw new Error(
          "Conflicting persisted captioned narration",
        );
      }

      return existing;
    }

    await mkdir(paths.directory, {
      recursive: true,
    });

    // Write underlying WAV audio and alignment data create-only
    await publishCreateOnly(paths.audioPath, audioBytes);

    await publishCreateOnly(
      paths.alignmentPath,
      Buffer.from(JSON.stringify(alignment, null, 2)),
    );

    // Write final commit marker manifest
    await publishCreateOnly(
      paths.manifestPath,
      Buffer.from(JSON.stringify(candidateManifest, null, 2)),
    );

    const published = await readPersisted(paths, request.jobId);

    if (!published) {
      throw new Error(
        "Captioned narration publication missing",
      );
    }

    if (
      published.manifest.manifestHash !==
      candidateManifest.manifestHash
    ) {
      throw new Error(
        "Conflicting persisted captioned narration",
      );
    }

    return {
      reused: false,
      paths,
      manifest: published.manifest,
      audioBytes: published.audioBytes,
      alignment: published.alignment,
      checkpoint: published.checkpoint,
    };
  }

  async load(
    jobId: string,
  ): Promise<PersistedCaptionedNarrationResult> {
    const paths = this.getPaths(jobId);
    const result = await readPersisted(paths, jobId);

    if (!result) {
      throw new Error(
        "Persisted captioned narration missing",
      );
    }

    return result;
  }

  async validate(
    jobId: string,
    expectedManifestHash: string,
  ): Promise<boolean> {
    try {
      const result = await this.load(jobId);
      return (
        result.manifest.manifestHash === expectedManifestHash
      );
    } catch {
      return false;
    }
  }
}
