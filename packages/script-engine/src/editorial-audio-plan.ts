import { createHash } from "node:crypto";
import { z } from "zod";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const SpeechIntervalSchema = z.object({
  startFrame: z.number().int().nonnegative(),
  endFrameExclusive: z.number().int().positive(),
}).strict();

export const MusicAssetSchema = z.object({
  assetId: z.string().min(1),
  sha256: Hash,
  durationSeconds: z.number().positive(),
  licenseId: z.string().min(1),
  commercialUseVerified: z.literal(true),
  attributionRequired: z.boolean(),
}).strict();

export type SpeechInterval = z.infer<typeof SpeechIntervalSchema>;
export type MusicAsset = z.infer<typeof MusicAssetSchema>;

export const EditorialAudioInputSchema = z.object({
  version: z.literal(1),
  profile: z.enum([
    "explainer",
    "documentary",
    "story",
  ]),
  fps: z.number().int().positive(),
  totalFrames: z.number().int().positive(),
  narrationSha256: Hash,
  speechIntervals: z.array(SpeechIntervalSchema),
  music: MusicAssetSchema.nullable(),
}).strict();

export type EditorialAudioInput =
  z.infer<typeof EditorialAudioInputSchema>;

export const EditorialAudioPlanSchema =
  EditorialAudioInputSchema.extend({
    musicEnabled: z.boolean(),
    narrationGainDb: z.number().finite(),
    musicBaseGainDb: z.number().finite(),
    duckingReductionDb: z.number().nonnegative(),
    attackFrames: z.number().int().positive(),
    releaseFrames: z.number().int().positive(),
    fadeInFrames: z.number().int().nonnegative(),
    fadeOutFrames: z.number().int().nonnegative(),
    planHash: Hash,
  }).strict();

export type EditorialAudioPlan =
  z.infer<typeof EditorialAudioPlanSchema>;

const PROFILE_AUDIO = {
  explainer: {
    musicBaseGainDb: -24,
    duckingReductionDb: 7,
    attackSeconds: 0.12,
    releaseSeconds: 0.35,
  },
  documentary: {
    musicBaseGainDb: -22,
    duckingReductionDb: 9,
    attackSeconds: 0.16,
    releaseSeconds: 0.5,
  },
  story: {
    musicBaseGainDb: -20,
    duckingReductionDb: 10,
    attackSeconds: 0.18,
    releaseSeconds: 0.65,
  },
} as const;

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function createEditorialAudioPlan(
  candidate: EditorialAudioInput,
): EditorialAudioPlan {
  const input =
    EditorialAudioInputSchema.parse(candidate);

  let previousEnd = 0;

  for (const interval of input.speechIntervals) {
    if (
      interval.startFrame < previousEnd ||
      interval.endFrameExclusive <= interval.startFrame ||
      interval.endFrameExclusive > input.totalFrames
    ) {
      throw new Error(
        "M10.4 invalid speech timing intervals",
      );
    }

    previousEnd = interval.endFrameExclusive;
  }

  const preset = PROFILE_AUDIO[input.profile];

  const payload = {
    ...input,
    musicEnabled: input.music !== null,
    narrationGainDb: 0,
    musicBaseGainDb: preset.musicBaseGainDb,
    duckingReductionDb:
      preset.duckingReductionDb,
    attackFrames: Math.max(
      1,
      Math.round(
        preset.attackSeconds * input.fps,
      ),
    ),
    releaseFrames: Math.max(
      1,
      Math.round(
        preset.releaseSeconds * input.fps,
      ),
    ),
    fadeInFrames: input.music
      ? Math.min(
          Math.round(input.fps * 0.6),
          Math.floor(input.totalFrames / 2),
        )
      : 0,
    fadeOutFrames: input.music
      ? Math.min(
          Math.round(input.fps * 0.8),
          Math.floor(input.totalFrames / 2),
        )
      : 0,
  };

  return EditorialAudioPlanSchema.parse({
    ...payload,
    planHash: sha256(payload),
  });
}

export function verifyEditorialAudioPlan(
  candidate: unknown,
): EditorialAudioPlan {
  const saved =
    EditorialAudioPlanSchema.parse(candidate);

  const {
    planHash: _savedHash,
    musicEnabled: _musicEnabled,
    narrationGainDb: _narrationGainDb,
    musicBaseGainDb: _baseGain,
    duckingReductionDb: _ducking,
    attackFrames: _attack,
    releaseFrames: _release,
    fadeInFrames: _fadeIn,
    fadeOutFrames: _fadeOut,
    ...input
  } = saved;

  const expected = createEditorialAudioPlan(input);

  if (
    JSON.stringify(saved) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      "M10.4 audio plan identity mismatch",
    );
  }

  return saved;
}

export function createSpeechIntervalsFromWords(
  words: readonly { startSeconds: number; endSeconds: number }[],
  fps: number,
  totalFrames: number,
  maxGapSeconds = 0.35,
): SpeechInterval[] {
  if (words.length === 0) {
    return [];
  }

  const rawIntervals: SpeechInterval[] = [];

  for (const word of words) {
    const startFrame = Math.max(
      0,
      Math.min(totalFrames - 1, Math.floor(word.startSeconds * fps)),
    );
    const endFrameExclusive = Math.max(
      startFrame + 1,
      Math.min(totalFrames, Math.ceil(word.endSeconds * fps)),
    );

    rawIntervals.push({
      startFrame,
      endFrameExclusive,
    });
  }

  rawIntervals.sort((a, b) => a.startFrame - b.startFrame);

  const maxGapFrames = Math.max(0, Math.round(maxGapSeconds * fps));
  const merged: SpeechInterval[] = [];
  let current = { ...rawIntervals[0]! };

  for (let i = 1; i < rawIntervals.length; i++) {
    const next = rawIntervals[i]!;
    if (next.startFrame <= current.endFrameExclusive + maxGapFrames) {
      current.endFrameExclusive = Math.max(
        current.endFrameExclusive,
        next.endFrameExclusive,
      );
    } else {
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);
  return merged;
}

export interface AudioLoudnessMetrics {
  rmsDbfs: number;
  peakDbfs: number;
}

export function measurePcmAudioLoudness(
  pcmBytes: Buffer,
): AudioLoudnessMetrics {
  if (pcmBytes.length === 0 || pcmBytes.length % 2 !== 0) {
    throw new Error("M10.4 invalid PCM audio bytes");
  }

  const sampleCount = pcmBytes.length / 2;
  let sumSquares = 0;
  let peak = 0;

  for (let i = 0; i < sampleCount; i++) {
    const val = pcmBytes.readInt16LE(i * 2) / 32768;
    const abs = Math.abs(val);
    if (abs > peak) peak = abs;
    sumSquares += val * val;
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  const rmsDbfs = rms === 0 ? -120 : Math.max(-120, 20 * Math.log10(rms));
  const peakDbfs = peak === 0 ? -120 : Math.max(-120, 20 * Math.log10(peak));

  return { rmsDbfs, peakDbfs };
}

export function calibrateEditorialAudioPlan(
  plan: EditorialAudioPlan,
  measurements: {
    narrationRmsDbfs: number;
    musicRmsDbfs?: number;
  },
): EditorialAudioPlan {
  const targetSpeechRms = -18;
  const speechDelta = measurements.narrationRmsDbfs - targetSpeechRms;
  const musicEnergyAdjustment =
    measurements.musicRmsDbfs !== undefined
      ? -16 - measurements.musicRmsDbfs
      : 0;

  const adjustedMusicBaseGainDb = Math.max(
    -36,
    Math.min(-16, plan.musicBaseGainDb + speechDelta + musicEnergyAdjustment),
  );

  const payload = {
    ...plan,
    musicBaseGainDb: adjustedMusicBaseGainDb,
  };

  const { planHash: _, ...rest } = payload;
  return EditorialAudioPlanSchema.parse({
    ...rest,
    planHash: sha256(rest),
  });
}
