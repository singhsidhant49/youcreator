import { mkdir, readFile, writeFile } from "node:fs/promises";

import type {
  KokoroCaptionedTtsProvider,
} from "./kokoro-captioned-tts-provider.js";

import {
  type CaptionedNarrationCheckpoint,
  type CaptionedNarrationRequestIdentity,
  CaptionedNarrationAttemptSchema,
  createCaptionedNarrationRequestIdentity,
} from "./captioned-narration-contract.js";

import {
  type PersistedCaptionedNarrationResult,
  PersistentCaptionedNarrationStore,
} from "./persistent-captioned-narration.js";

export interface CaptionedNarrationServiceOptions {
  provider: KokoroCaptionedTtsProvider;
  store: PersistentCaptionedNarrationStore;
  jobDirectory(jobId: string): string;
  defaultVoice?: string;
  defaultSpeed?: number;
  providerId?: string;
  endpointVersion?: string;
}

export interface CaptionedSpeechGenerationRequest {
  jobId: string;
  input: string;
  voice?: string;
  speed?: number;
  providerId?: string;
  endpointVersion?: string;
}

export class CaptionedNarrationService {
  constructor(
    private readonly options: CaptionedNarrationServiceOptions,
  ) {}

  async generate(
    request: CaptionedSpeechGenerationRequest,
  ): Promise<PersistedCaptionedNarrationResult> {
    if (!request.jobId.trim() || !request.input.trim()) {
      throw new Error("Captioned narration requires job ID and text");
    }

    const requestIdentity: CaptionedNarrationRequestIdentity =
      createCaptionedNarrationRequestIdentity({
        jobId: request.jobId,
        input: request.input,
        voice: request.voice ?? this.options.defaultVoice,
        speed: request.speed ?? this.options.defaultSpeed,
        providerId: request.providerId ?? this.options.providerId,
        endpointVersion:
          request.endpointVersion ?? this.options.endpointVersion,
      });

    const paths = this.options.store.getPaths(request.jobId);

    let existing: PersistedCaptionedNarrationResult | null = null;

    try {
      existing = await this.options.store.load(request.jobId);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Persisted captioned narration missing"
      ) {
        throw error;
      }
    }

    if (existing) {
      let attemptJson: unknown;

      try {
        attemptJson = JSON.parse(
          await readFile(paths.attemptPath, "utf8"),
        );
      } catch {
        throw new Error(
          "Captioned narration exists without verified generation attempt",
        );
      }

      const attempt = CaptionedNarrationAttemptSchema.parse(attemptJson);

      if (attempt.requestHash !== requestIdentity.requestHash) {
        throw new Error(
          "Captioned narration request identity mismatch",
        );
      }

      if (
        existing.manifest.request.requestHash !==
        requestIdentity.requestHash
      ) {
        throw new Error(
          "Captioned narration request identity mismatch",
        );
      }

      return existing;
    }

    await mkdir(paths.directory, {
      recursive: true,
    });

    // Write attempt claim create-only. If an earlier attempt is already running
    // or crashed/timed out, refuse to repeat synthesis automatically.
    try {
      await writeFile(
        paths.attemptPath,
        JSON.stringify({
          version: 1,
          jobId: request.jobId,
          requestHash: requestIdentity.requestHash,
          state: "started",
        }),
        { flag: "wx" },
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        throw new Error(
          "Captioned narration attempt already exists; manual recovery required",
        );
      }

      throw error;
    }

    const synthesisResult = await this.options.provider.synthesize({
      jobId: request.jobId,
      input: requestIdentity.scriptText,
      voice: requestIdentity.voice,
      speed: requestIdentity.speed,
    });

    return this.options.store.save(
      requestIdentity,
      synthesisResult.audioBytes,
      synthesisResult.alignment,
    );
  }

  async load(
    jobId: string,
  ): Promise<PersistedCaptionedNarrationResult> {
    return this.options.store.load(jobId);
  }

  async validate(
    jobId: string,
    expectedManifestHash: string,
  ): Promise<boolean> {
    return this.options.store.validate(jobId, expectedManifestHash);
  }

  async getCheckpoint(
    jobId: string,
  ): Promise<CaptionedNarrationCheckpoint> {
    const result = await this.options.store.load(jobId);
    return result.checkpoint;
  }
}
