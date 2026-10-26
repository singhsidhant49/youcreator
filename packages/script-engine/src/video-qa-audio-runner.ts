import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  decodeMp4Audio,
} from "./remotion-encoded-media-acceptance.js";

import {
  PersistedRemotionVideoSchema,
  type PersistedRemotionVideo,
} from "./persistent-remotion-video.js";

import {
  analyzeVideoQaAudio,
  type AudioQaOptions,
  type AudioQaReport,
  type AudioWordTiming,
} from "./video-qa-audio-analyzer.js";

export interface AudioQaDecoderPort {
  decode(
    videoPath: string,
  ): Promise<Buffer>;
}

export interface RunVideoAudioQaInput {
  videoPath: string;
  record: PersistedRemotionVideo;
  options?: AudioQaOptions;
  words?: readonly AudioWordTiming[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}

export async function runVideoAudioQa(
  input: RunVideoAudioQaInput,
  decoder: AudioQaDecoderPort = {
    decode: decodeMp4Audio,
  },
): Promise<AudioQaReport> {
  const record =
    PersistedRemotionVideoSchema.parse(
      input.record,
    );

  if (!path.isAbsolute(input.videoPath)) {
    throw new Error(
      "M8 audio QA requires absolute video path",
    );
  }

  // Verify the published MP4 bytes before decoding.
  const before = await readFile(
    input.videoPath,
  );

  if (
    before.length !== record.videoBytes ||
    sha256(before) !== record.videoSha256
  ) {
    throw new Error(
      "M8 audio QA MP4 integrity mismatch",
    );
  }

  const pcm = await decoder.decode(
    input.videoPath,
  );

  // Existing M7 decoder outputs 16kHz mono PCM16.
  const report = analyzeVideoQaAudio(
    pcm,
    16000,
    {
      ...input.options,
      words: input.words ?? input.options?.words,
    },
  );

  // Fail if MP4 bytes changed during extraction.
  const after = await readFile(
    input.videoPath,
  );

  if (
    after.length !== record.videoBytes ||
    sha256(after) !== record.videoSha256
  ) {
    throw new Error(
      "M8 audio QA video changed during decoding",
    );
  }

  return report;
}
