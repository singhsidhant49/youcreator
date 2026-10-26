import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  KokoroTtsProvider,
  type KokoroSpeechRequest,
} from "./kokoro-tts-provider.js";

import {
  PersistentNarrationAudioStore,
  getPersistedNarrationPaths,
} from "./persistent-narration-audio.js";

export interface KokoroNarrationServiceOptions {
  provider: KokoroTtsProvider;
  store: PersistentNarrationAudioStore;
  jobDirectory(jobId: string): string;
}

function sha256(text: string): string {
  return createHash("sha256")
    .update(text)
    .digest("hex");
}

export class KokoroNarrationService {
  constructor(
    private readonly options:
      KokoroNarrationServiceOptions,
  ) {}

  async generate(
    jobId: string,
    request: KokoroSpeechRequest,
  ) {
    if (!jobId.trim() || !request.input.trim()) {
      throw new Error(
        "Narration job and text are required",
      );
    }

    const paths = getPersistedNarrationPaths(
      this.options.jobDirectory(jobId),
      jobId,
    );

    const attemptPath = path.join(
      paths.directory,
      "generation-attempt.json",
    );

    // This fingerprint is useful for diagnostics,
    // not yet a complete immutable TTS specification.
    // Production must also bind voice, speed and model.
    const requestHash = sha256(
      JSON.stringify(request),
    );

    // Check existing persistence first.
    // A completed, verified result can be reused.
    let existing;

    try {
      existing = await this.options.store.load(
        jobId,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !==
          "Persisted narration missing"
      ) {
        throw error;
      }
    }

    if (existing) {
      let attempt;

      try {
        attempt = JSON.parse(
          await readFile(attemptPath, "utf8"),
        ) as {
          requestHash?: string;
        };
      } catch {
        throw new Error(
          "Narration exists without verified generation attempt",
        );
      }

      if (attempt.requestHash !== requestHash) {
        throw new Error(
          "Narration request identity mismatch",
        );
      }

      return existing;
    }

    await mkdir(paths.directory, {
      recursive: true,
    });

    // Atomic, create-only claim. If an earlier
    // request crashed or timed out, don't repeat it.
    try {
      await writeFile(
        attemptPath,
        JSON.stringify({
          version: 1,
          jobId,
          requestHash,
          state: "started",
        }),
        { flag: "wx" },
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "EEXIST"
      ) {
        throw new Error(
          "Narration attempt already exists; manual recovery required",
        );
      }

      throw error;
    }

    // No automatic retry after this point.
    //
    // If Kokoro returns successfully but persistence
    // fails, the attempt marker remains to prevent
    // accidental duplicate synthesis.
    const result =
      await this.options.provider.synthesize(
        jobId,
        request,
      );

    return this.options.store.save(
      jobId,
      result.bytes,
    );
  }
}
