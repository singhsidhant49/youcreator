import { createHash } from "node:crypto";
import { z } from "zod";

import {
  RemotionCompositionSchema,
  type RemotionComposition,
} from "./remotion-composition-contract.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Frame = z.number().int().safe().nonnegative();

export const CaptionWordSchema = z.object({
  index: Frame,
  text: z.string().min(1),
  startFrame: Frame,
  endFrameExclusive: Frame,
}).strict();

export const CaptionCueSchema = z.object({
  cueIndex: Frame,
  startFrame: Frame,
  endFrameExclusive: Frame,
  words: z.array(CaptionWordSchema).min(1),
}).strict();

export const RemotionCaptionPlanSchema = z.object({
  version: z.literal(1),
  compositionHash: Hash,
  fps: z.number().int().positive(),
  totalFrames: z.number().int().positive(),
  cues: z.array(CaptionCueSchema),
  captionPlanHash: Hash,
}).strict();

export type RemotionCaptionPlan = z.infer<
  typeof RemotionCaptionPlanSchema
>;

export type CaptionCue = z.infer<
  typeof CaptionCueSchema
>;

export interface CaptionPlanOptions {
  maxWordsPerCue?: number;
  maxCharactersPerCue?: number;
  maxGapFrames?: number;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function ceilDiv(
  numerator: bigint,
  denominator: bigint,
): bigint {
  return (
    numerator + denominator - 1n
  ) / denominator;
}

/**
 * Start = floor(sample * fps / sampleRate)
 * End   = ceil(sample * fps / sampleRate)
 *
 * This represents every word's sample interval
 * without dropping either endpoint.
 */
export function sampleIntervalToFrames(
  startSample: number,
  endSampleExclusive: number,
  sampleRate: number,
  fps: number,
  totalFrames: number,
) {
  if (
    ![
      startSample,
      endSampleExclusive,
      sampleRate,
      fps,
      totalFrames,
    ].every(Number.isSafeInteger) ||
    startSample < 0 ||
    endSampleExclusive <= startSample ||
    sampleRate <= 0 ||
    fps <= 0 ||
    totalFrames <= 0
  ) {
    throw new Error(
      "Invalid caption sample interval",
    );
  }

  const rate = BigInt(sampleRate);
  const framesPerSecond = BigInt(fps);

  const start = (
    BigInt(startSample) * framesPerSecond
  ) / rate;

  const end = ceilDiv(
    BigInt(endSampleExclusive) *
      framesPerSecond,
    rate,
  );

  const startFrame = Number(start);
  const endFrameExclusive = Number(end);

  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrameExclusive) ||
    startFrame >= totalFrames ||
    endFrameExclusive > totalFrames
  ) {
    throw new Error(
      "Caption frame interval exceeds video",
    );
  }

  return {
    startFrame,
    endFrameExclusive,
  };
}

export function createRemotionCaptionPlan(
  input: RemotionComposition,
  options: CaptionPlanOptions = {},
): RemotionCaptionPlan {
  const composition =
    RemotionCompositionSchema.parse(input);

  const maxWords =
    options.maxWordsPerCue ?? 5;

  const maxCharacters =
    options.maxCharactersPerCue ?? 36;

  const maxGap =
    options.maxGapFrames ?? 9;

  if (
    ![maxWords, maxCharacters, maxGap]
      .every(Number.isSafeInteger) ||
    maxWords < 1 ||
    maxCharacters < 1 ||
    maxGap < 0
  ) {
    throw new Error(
      "Invalid caption grouping options",
    );
  }

  const words = composition.words.map(
    (word) => {
      const frames = sampleIntervalToFrames(
        word.startSample,
        word.endSampleExclusive,
        composition.audio.sampleRate,
        composition.fps,
        composition.totalFrames,
      );

      return {
        index: word.index ?? word.tokenIndex,
        text: word.text ?? word.word,
        ...frames,
      };
    },
  );

  const cues: CaptionCue[] = [];
  let current: CaptionCue | undefined;

  function flush() {
    if (!current) return;

    cues.push({
      ...current,
      cueIndex: cues.length,
    });

    current = undefined;
  }

  for (const word of words) {
    if (!current) {
      current = {
        cueIndex: cues.length,
        startFrame: word.startFrame,
        endFrameExclusive:
          word.endFrameExclusive,
        words: [word],
      };

      continue;
    }

    const candidateLength = [
      ...current.words.map((w) => w.text),
      word.text,
    ].join(" ").length;

    const gap =
      word.startFrame -
      current.words[
        current.words.length - 1
      ]!.endFrameExclusive;

    const isClosingPunctuation =
      /^[,.;:!?%)\]\}]+$/u.test(word.text.trim());

    const shouldSplit =
      !isClosingPunctuation &&
      (current.words.length >= maxWords ||
        candidateLength > maxCharacters ||
        gap > maxGap ||
        /[.!?]$/.test(
          current.words[
            current.words.length - 1
          ]!.text,
        ));

    if (shouldSplit) {
      flush();

      current = {
        cueIndex: cues.length,
        startFrame: word.startFrame,
        endFrameExclusive:
          word.endFrameExclusive,
        words: [word],
      };
    } else {
      current.words.push(word);

      current.endFrameExclusive = Math.max(
        current.endFrameExclusive,
        word.endFrameExclusive,
      );
    }
  }

  flush();

  // Attach or merge any punctuation-only cues to neighboring spoken cues
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const isPunctuationOnly = cue.words.every((w) =>
      /^[,.;:!?%)\]\}]+$/u.test(w.text.trim()),
    );

    if (isPunctuationOnly) {
      if (i > 0) {
        const prev = cues[i - 1]!;
        prev.words.push(...cue.words);
        prev.endFrameExclusive = Math.max(
          prev.endFrameExclusive,
          cue.endFrameExclusive,
        );
        cues.splice(i, 1);
        i--;
      } else if (cues.length > 1) {
        const next = cues[1]!;
        next.words.unshift(...cue.words);
        next.startFrame = Math.min(
          next.startFrame,
          cue.startFrame,
        );
        cues.splice(0, 1);
        i--;
      }
    }
  }

  for (let i = 0; i < cues.length; i++) {
    cues[i]!.cueIndex = i;
  }

  // A cue must never overlap the next cue.
  // Adjacent highlighted words may share a frame;
  // the caption renderer selects one active word.
  for (let i = 0; i < cues.length - 1; i++) {
    const currentCue = cues[i]!;
    const nextCue = cues[i + 1]!;

    currentCue.endFrameExclusive = Math.min(
      currentCue.endFrameExclusive,
      nextCue.startFrame,
    );

    if (
      currentCue.endFrameExclusive <=
      currentCue.startFrame
    ) {
      throw new Error(
        "Caption cue collapsed after grouping",
      );
    }
  }

  // Ensure all words within every cue are strictly bounded within [cue.startFrame, cue.endFrameExclusive]
  for (const cue of cues) {
    let limit = cue.endFrameExclusive;
    for (let w = cue.words.length - 1; w >= 0; w--) {
      const word = cue.words[w]!;
      if (word.endFrameExclusive > limit) {
        word.endFrameExclusive = limit;
      }
      if (word.startFrame >= word.endFrameExclusive) {
        word.startFrame = Math.max(cue.startFrame, word.endFrameExclusive - 1);
      }
      limit = word.startFrame;
    }
  }

  const payload = {
    version: 1 as const,
    compositionHash:
      composition.compositionHash,
    fps: composition.fps,
    totalFrames: composition.totalFrames,
    cues,
  };

  return RemotionCaptionPlanSchema.parse({
    ...payload,
    captionPlanHash: hash(payload),
  });
}

export function verifyRemotionCaptionPlan(
  candidate: unknown,
  composition: RemotionComposition,
  options: CaptionPlanOptions = {},
): RemotionCaptionPlan {
  const saved =
    RemotionCaptionPlanSchema.parse(candidate);

  const canonical =
    createRemotionCaptionPlan(
      composition,
      options,
    );

  if (
    JSON.stringify(saved) !==
    JSON.stringify(canonical)
  ) {
    throw new Error(
      "M7 caption plan reconstruction mismatch",
    );
  }

  return saved;
}
