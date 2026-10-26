import { createHash } from "node:crypto";
import { z } from "zod";

import {
  NarrationAudioSchema,
  type NarrationAudio,
} from "./narration-audio-contract.js";

import {
  NarrationWordAlignmentSchema,
  tokenizeNarrationScript,
  type NarrationWordAlignment,
} from "./narration-alignment-contract.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const CaptionedNarrationRequestIdentitySchema = z.object({
  version: z.literal(1),
  jobId: z.string().trim().min(1),
  scriptText: z.string().trim().min(1),
  voice: z.string().trim().min(1),
  speed: z.number().positive().finite(),
  providerId: z.string().trim().min(1),
  endpointVersion: z.string().trim().min(1),
  requestHash: HashSchema,
}).strict();

export type CaptionedNarrationRequestIdentity = z.infer<
  typeof CaptionedNarrationRequestIdentitySchema
>;

export const CaptionedNarrationAttemptSchema = z.object({
  version: z.literal(1),
  jobId: z.string().trim().min(1),
  requestHash: HashSchema,
  state: z.literal("started"),
  startedAt: z.string().datetime().optional(),
}).strict();

export type CaptionedNarrationAttempt = z.infer<
  typeof CaptionedNarrationAttemptSchema
>;

export const CaptionedNarrationManifestSchema = z.object({
  version: z.literal(1),
  jobId: z.string().trim().min(1),
  request: CaptionedNarrationRequestIdentitySchema,
  audio: NarrationAudioSchema,
  alignment: NarrationWordAlignmentSchema,
  audioSha256: HashSchema,
  alignmentHash: HashSchema,
  manifestHash: HashSchema,
}).strict();

export type CaptionedNarrationManifest = z.infer<
  typeof CaptionedNarrationManifestSchema
>;

export const CaptionedNarrationCheckpointSchema = z.object({
  version: z.literal(1),
  jobId: z.string().trim().min(1),
  manifestPath: z.string().trim().min(1),
  audioPath: z.string().trim().min(1),
  alignmentPath: z.string().trim().min(1),
  manifestHash: HashSchema,
  requestHash: HashSchema,
  audioSha256: HashSchema,
  alignmentHash: HashSchema,
  durationSeconds: z.number().positive(),
  wordCount: z.number().int().nonnegative(),
}).strict();

export type CaptionedNarrationCheckpoint = z.infer<
  typeof CaptionedNarrationCheckpointSchema
>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CreateCaptionedNarrationRequestIdentityInput {
  jobId: string;
  input: string;
  voice?: string;
  speed?: number;
  providerId?: string;
  endpointVersion?: string;
}

export function createCaptionedNarrationRequestIdentity(
  input: CreateCaptionedNarrationRequestIdentityInput,
): CaptionedNarrationRequestIdentity {
  const jobId = input.jobId.trim();
  const scriptText = input.input.trim();

  if (!jobId || !scriptText) {
    throw new Error("Captioned narration requires job ID and text");
  }

  const voice = (input.voice ?? "af_bella").trim();
  if (!voice) {
    throw new Error("Captioned narration requires a valid voice");
  }

  const speed = input.speed ?? 0.9;
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new Error("Captioned narration speed must be positive and finite");
  }

  const providerId = (input.providerId ?? "kokoro-captioned-tts-v1").trim();
  if (!providerId) {
    throw new Error("Captioned narration requires a valid providerId");
  }

  const endpointVersion = (
    input.endpointVersion ?? "dev-captioned-speech-v1"
  ).trim();
  if (!endpointVersion) {
    throw new Error("Captioned narration requires a valid endpointVersion");
  }

  const payload = {
    version: 1 as const,
    jobId,
    scriptText,
    voice,
    speed,
    providerId,
    endpointVersion,
  };

  return CaptionedNarrationRequestIdentitySchema.parse({
    ...payload,
    requestHash: sha256(JSON.stringify(payload)),
  });
}

export function verifyCaptionedNarrationRequestIdentity(
  input: unknown,
): CaptionedNarrationRequestIdentity {
  const parsed = CaptionedNarrationRequestIdentitySchema.parse(input);
  const { requestHash, ...payload } = parsed;

  if (sha256(JSON.stringify(payload)) !== requestHash) {
    throw new Error("Captioned narration request identity hash mismatch");
  }

  return parsed;
}

export function createCaptionedNarrationManifest(input: {
  jobId: string;
  request: CaptionedNarrationRequestIdentity;
  audio: NarrationAudio;
  alignment: NarrationWordAlignment;
}): CaptionedNarrationManifest {
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new Error("Captioned narration manifest requires job ID");
  }

  if (input.request.jobId !== jobId) {
    throw new Error("Captioned narration request job mismatch");
  }

  if (input.audio.jobId !== jobId) {
    throw new Error("Captioned narration audio job mismatch");
  }

  if (input.alignment.jobId !== jobId) {
    throw new Error("Captioned narration alignment job mismatch");
  }

  if (input.audio.sha256 !== input.alignment.audioSha256) {
    throw new Error(
      "Captioned narration audio SHA-256 does not match alignment audioSha256",
    );
  }

  const expectedTokens = tokenizeNarrationScript(input.request.scriptText);
  if (expectedTokens.length !== input.alignment.words.length) {
    throw new Error(
      "Captioned narration token count mismatch",
    );
  }

  for (let i = 0; i < expectedTokens.length; i++) {
    if (expectedTokens[i] !== input.alignment.words[i]?.word) {
      throw new Error(
        "Captioned narration token drift mismatch",
      );
    }
  }

  const payload = {
    version: 1 as const,
    jobId,
    request: input.request,
    audio: input.audio,
    alignment: input.alignment,
    audioSha256: input.audio.sha256,
    alignmentHash: input.alignment.alignmentHash,
  };

  return CaptionedNarrationManifestSchema.parse({
    ...payload,
    manifestHash: sha256(JSON.stringify(payload)),
  });
}

export function verifyCaptionedNarrationManifest(
  input: unknown,
  expectedJobId?: string,
): CaptionedNarrationManifest {
  const manifest = CaptionedNarrationManifestSchema.parse(input);

  if (expectedJobId && manifest.jobId !== expectedJobId) {
    throw new Error("Captioned narration manifest job mismatch");
  }

  if (manifest.request.jobId !== manifest.jobId) {
    throw new Error("Captioned narration request job mismatch");
  }

  if (manifest.audio.jobId !== manifest.jobId) {
    throw new Error("Captioned narration audio job mismatch");
  }

  if (manifest.alignment.jobId !== manifest.jobId) {
    throw new Error("Captioned narration alignment job mismatch");
  }

  const { manifestHash, ...payload } = manifest;

  if (sha256(JSON.stringify(payload)) !== manifestHash) {
    throw new Error("Captioned narration manifest integrity mismatch");
  }

  verifyCaptionedNarrationRequestIdentity(manifest.request);

  if (manifest.audioSha256 !== manifest.audio.sha256) {
    throw new Error("Captioned narration audio SHA-256 mismatch");
  }

  if (manifest.alignment.audioSha256 !== manifest.audio.sha256) {
    throw new Error("Captioned narration alignment audioSha256 mismatch");
  }

  if (manifest.alignmentHash !== manifest.alignment.alignmentHash) {
    throw new Error("Captioned narration alignment hash mismatch");
  }

  const expectedTokens = tokenizeNarrationScript(manifest.request.scriptText);
  if (expectedTokens.length !== manifest.alignment.words.length) {
    throw new Error("Captioned narration token count mismatch");
  }

  for (let i = 0; i < expectedTokens.length; i++) {
    if (expectedTokens[i] !== manifest.alignment.words[i]?.word) {
      throw new Error("Captioned narration token drift mismatch");
    }
  }

  return manifest;
}

export function createCaptionedNarrationCheckpoint(
  paths: {
    manifestPath: string;
    audioPath: string;
    alignmentPath: string;
  },
  manifest: CaptionedNarrationManifest,
): CaptionedNarrationCheckpoint {
  return CaptionedNarrationCheckpointSchema.parse({
    version: 1,
    jobId: manifest.jobId,
    manifestPath: paths.manifestPath,
    audioPath: paths.audioPath,
    alignmentPath: paths.alignmentPath,
    manifestHash: manifest.manifestHash,
    requestHash: manifest.request.requestHash,
    audioSha256: manifest.audioSha256,
    alignmentHash: manifest.alignmentHash,
    durationSeconds: manifest.audio.durationSeconds,
    wordCount: manifest.alignment.words.length,
  });
}
