import { createHash } from "node:crypto";
import { z } from "zod";
import type { NarrationAudio } from "./narration-audio-contract.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const KokoroWordTimestampSchema = z.object({
  word: z.string().min(1),
  start_time: z.number().finite().nonnegative(),
  end_time: z.number().finite().nonnegative(),
}).passthrough();

export type KokoroWordTimestamp = z.infer<
  typeof KokoroWordTimestampSchema
>;

export const NarrationWordSchema = z.object({
  tokenIndex: z.number().int().nonnegative(),
  index: z.number().int().nonnegative().optional(),
  word: z.string().min(1),
  text: z.string().min(1).optional(),
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().nonnegative(),
  startSample: z.number().int().nonnegative(),
  endSampleExclusive: z.number().int().nonnegative(),
}).strict();

export type NarrationWord = z.infer<
  typeof NarrationWordSchema
>;

export const NarrationWordAlignmentSchema = z.object({
  version: z.literal(1),
  jobId: z.string().trim().min(1),
  audioSha256: HashSchema,
  scriptHash: HashSchema,
  sampleRate: z.number().int().positive(),
  sampleFrames: z.number().int().positive(),
  words: z.array(NarrationWordSchema).min(1),
  alignmentHash: HashSchema,
}).strict();

export type NarrationWordAlignment = z.infer<
  typeof NarrationWordAlignmentSchema
>;

export interface CreateNarrationWordAlignmentOptions {
  scriptText: string;
  audio: NarrationAudio;
  timestamps: KokoroWordTimestamp[];
}

function sha256(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

export function tokenizeNarrationScript(text: string): string[] {
  return text.match(/[\p{L}\p{N}'’_-]+|[^\s\p{L}\p{N}'’_-]/gu) ?? [];
}

export const tokenizeNarration = tokenizeNarrationScript;

export function createNarrationWordAlignment(
  options: CreateNarrationWordAlignmentOptions,
): NarrationWordAlignment {
  if (!options.scriptText.trim()) {
    throw new Error("Narration script text is required");
  }

  const tokens = tokenizeNarrationScript(options.scriptText);

  if (tokens.length !== options.timestamps.length) {
    throw new Error("Narration token coverage mismatch");
  }

  const words: NarrationWord[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const t = options.timestamps[index]!;

    if (t.word !== token) {
      throw new Error("Narration token mismatch");
    }

    let startSample = Math.round(t.start_time * options.audio.sampleRate);
    let endSampleExclusive = Math.round(t.end_time * options.audio.sampleRate);

    if (
      t.start_time < 0 ||
      t.end_time < t.start_time ||
      t.end_time > options.audio.durationSeconds + 1e-4 ||
      endSampleExclusive > options.audio.sampleFrames
    ) {
      throw new Error("Invalid narration sample bounds");
    }

    if (words.length > 0) {
      let curLimit = startSample;
      for (let p = words.length - 1; p >= 0; p--) {
        const item = words[p]!;
        if (item.endSampleExclusive > curLimit) {
          item.endSampleExclusive = curLimit;
          item.endSeconds = item.endSampleExclusive / options.audio.sampleRate;
          if (item.startSample >= curLimit) {
            item.startSample = Math.max(0, curLimit - 1);
            item.startSeconds = item.startSample / options.audio.sampleRate;
          }
          curLimit = item.startSample;
        } else {
          break;
        }
      }
      const prev = words[words.length - 1]!;
      if (startSample < prev.endSampleExclusive) {
        startSample = prev.endSampleExclusive;
      }
      if (endSampleExclusive <= startSample) {
        endSampleExclusive = startSample + 1;
      }
    } else {
      if (endSampleExclusive <= startSample) {
        endSampleExclusive = startSample + 1;
      }
    }

    words.push({
      tokenIndex: index,
      index,
      word: token,
      text: token,
      startSeconds: startSample / options.audio.sampleRate,
      endSeconds: endSampleExclusive / options.audio.sampleRate,
      startSample,
      endSampleExclusive,
    });
  }

  const scriptHash = sha256(options.scriptText);

  const payload = {
    version: 1 as const,
    jobId: options.audio.jobId,
    audioSha256: options.audio.sha256,
    scriptHash,
    sampleRate: options.audio.sampleRate,
    sampleFrames: options.audio.sampleFrames,
    words,
  };

  const normalized = NarrationWordAlignmentSchema.omit({
    alignmentHash: true,
  }).parse(payload);

  return NarrationWordAlignmentSchema.parse({
    ...normalized,
    alignmentHash: sha256(JSON.stringify(normalized)),
  });
}

export function verifyNarrationWordAlignment(
  input: unknown,
  audio: NarrationAudio,
): NarrationWordAlignment {
  const alignment = NarrationWordAlignmentSchema.parse(input);

  if (alignment.jobId !== audio.jobId) {
    throw new Error("Narration alignment job mismatch");
  }

  if (alignment.audioSha256 !== audio.sha256) {
    throw new Error("Narration alignment audio hash mismatch");
  }

  if (alignment.sampleRate !== audio.sampleRate) {
    throw new Error("Narration alignment sample rate mismatch");
  }

  if (alignment.sampleFrames !== audio.sampleFrames) {
    throw new Error("Narration alignment sample frames mismatch");
  }

  const { alignmentHash, ...payload } = alignment;

  if (alignmentHash !== sha256(JSON.stringify(payload))) {
    throw new Error("Narration alignment integrity mismatch");
  }

  let previousEnd = 0;
  for (const [index, word] of alignment.words.entries()) {
    const wordIdx = word.index ?? word.tokenIndex;
    if (
      wordIdx !== index ||
      word.startSample < previousEnd ||
      word.endSampleExclusive < word.startSample ||
      word.endSampleExclusive > audio.sampleFrames
    ) {
      throw new Error(`Narration alignment invalid bounds at token ${index}`);
    }
    previousEnd = word.endSampleExclusive;
  }

  return alignment;
}
