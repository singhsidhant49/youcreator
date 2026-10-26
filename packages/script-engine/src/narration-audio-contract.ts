import { createHash } from "node:crypto";
import { z } from "zod";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const NarrationAudioSchema = z.object({
  version: z.literal(1),

  jobId: z.string().trim().min(1),

  format: z.literal("wav_pcm_s16le"),

  sha256: HashSchema,

  bytes: z.number().int().positive(),

  sampleRate: z.number().int().positive(),
  channels: z.literal(1),
  bitsPerSample: z.literal(16),

  sampleFrames: z.number().int().positive(),

  durationSeconds: z.number().finite().positive(),

  audioHash: HashSchema,
}).strict();

export type NarrationAudio = z.infer<
  typeof NarrationAudioSchema
>;

export interface ParsedPcmWav {
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
  sampleFrames: number;
  durationSeconds: number;
}

function sha256(
  value: Buffer | string,
): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function assertRange(
  bytes: Buffer,
  offset: number,
  length: number,
): void {
  if (
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  ) {
    throw new Error(
      "Truncated WAV audio",
    );
  }
}

/**
 * Read canonical mono, signed 16-bit PCM WAV.
 *
 * Supports normal RIFF chunks, including optional
 * metadata chunks, but requires:
 *
 * - RIFF/WAVE
 * - PCM format 1
 * - mono
 * - 16-bit samples
 * - aligned data chunk
 * - exactly one fmt and one data chunk
 *
 * The complete container length must agree with
 * its RIFF header.
 */
export function parsePcmWav(
  bytes: Buffer,
): ParsedPcmWav {
  if (bytes.length < 44) {
    throw new Error(
      "Invalid or truncated WAV header",
    );
  }

  if (
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(
      "Unsupported WAV container",
    );
  }

  const riffLength =
    bytes.readUInt32LE(4) + 8;

  if (riffLength !== bytes.length) {
    throw new Error(
      "WAV RIFF length mismatch",
    );
  }

  let offset = 12;

  let sampleRate: number | undefined;
  let blockAlign: number | undefined;
  let dataBytes: number | undefined;

  let foundFmt = false;
  let foundData = false;

  while (offset < bytes.length) {
    assertRange(bytes, offset, 8);

    const chunkId =
      bytes.toString(
        "ascii",
        offset,
        offset + 4,
      );

    const chunkLength =
      bytes.readUInt32LE(offset + 4);

    const chunkStart = offset + 8;

    assertRange(
      bytes,
      chunkStart,
      chunkLength,
    );

    if (chunkId === "fmt ") {
      if (foundFmt) {
        throw new Error(
          "Duplicate WAV format chunk",
        );
      }

      foundFmt = true;

      if (chunkLength !== 16) {
        throw new Error(
          "Unsupported WAV format chunk",
        );
      }

      const encoding =
        bytes.readUInt16LE(chunkStart);

      const channels =
        bytes.readUInt16LE(chunkStart + 2);

      const rate =
        bytes.readUInt32LE(chunkStart + 4);

      const byteRate =
        bytes.readUInt32LE(chunkStart + 8);

      const alignment =
        bytes.readUInt16LE(chunkStart + 12);

      const bits =
        bytes.readUInt16LE(chunkStart + 14);

      if (
        encoding !== 1 ||
        channels !== 1 ||
        bits !== 16
      ) {
        throw new Error(
          "Only mono PCM16 WAV is supported",
        );
      }

      if (
        !Number.isSafeInteger(rate) ||
        rate < 8000 ||
        rate > 192000
      ) {
        throw new Error(
          "Invalid WAV sample rate",
        );
      }

      if (
        alignment !== 2 ||
        byteRate !== rate * 2
      ) {
        throw new Error(
          "WAV format metadata mismatch",
        );
      }

      sampleRate = rate;
      blockAlign = alignment;
    }

    if (chunkId === "data") {
      if (foundData) {
        throw new Error(
          "Duplicate WAV data chunk",
        );
      }

      foundData = true;
      dataBytes = chunkLength;
    }

    offset =
      chunkStart +
      chunkLength +
      (chunkLength % 2);

    if (offset > bytes.length) {
      throw new Error(
        "Truncated WAV chunk padding",
      );
    }
  }

  if (
    !foundFmt ||
    !foundData ||
    sampleRate === undefined ||
    blockAlign === undefined ||
    dataBytes === undefined
  ) {
    throw new Error(
      "Missing WAV format or audio data",
    );
  }

  if (
    dataBytes === 0 ||
    dataBytes % blockAlign !== 0
  ) {
    throw new Error(
      "Invalid WAV sample alignment",
    );
  }

  const sampleFrames =
    dataBytes / blockAlign;

  return {
    sampleRate,
    channels: 1,
    bitsPerSample: 16,
    sampleFrames,
    durationSeconds:
      sampleFrames / sampleRate,
  };
}

export function createNarrationAudio(
  jobId: string,
  bytes: Buffer,
): NarrationAudio {
  const parsed = parsePcmWav(bytes);

  const payload = {
    version: 1 as const,
    jobId,
    format: "wav_pcm_s16le" as const,

    sha256: sha256(bytes),
    bytes: bytes.length,

    ...parsed,
  };

  const normalized =
    NarrationAudioSchema.omit({
      audioHash: true,
    }).parse(payload);

  return NarrationAudioSchema.parse({
    ...normalized,
    audioHash: sha256(
      JSON.stringify(normalized),
    ),
  });
}

export function verifyNarrationAudio(
  input: unknown,
  bytes: Buffer,
): NarrationAudio {
  const audio =
    NarrationAudioSchema.parse(input);

  const expected =
    createNarrationAudio(
      audio.jobId,
      bytes,
    );

  if (
    JSON.stringify(audio) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      "Narration audio integrity mismatch",
    );
  }

  return audio;
}
