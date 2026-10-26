import type {
  EditorialAudioPlan,
} from "./editorial-audio-plan.js";

export function decibelsToLinear(
  decibels: number,
): number {
  return Math.pow(10, decibels / 20);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number): number {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
}

function speechActivity(
  plan: EditorialAudioPlan,
  frame: number,
): number {
  let activity = 0;

  for (const interval of plan.speechIntervals) {
    const before =
      interval.startFrame - frame;
    const after =
      frame - interval.endFrameExclusive + 1;

    if (
      frame >= interval.startFrame &&
      frame < interval.endFrameExclusive
    ) {
      return 1;
    }

    if (
      before > 0 &&
      before <= plan.attackFrames
    ) {
      activity = Math.max(
        activity,
        smoothstep(
          1 - before / plan.attackFrames,
        ),
      );
    }

    if (
      after > 0 &&
      after <= plan.releaseFrames
    ) {
      activity = Math.max(
        activity,
        smoothstep(
          1 - after / plan.releaseFrames,
        ),
      );
    }
  }

  return activity;
}

export function evaluateMusicGain(
  plan: EditorialAudioPlan,
  frame: number,
): number {
  if (!plan.musicEnabled || !plan.music) {
    return 0;
  }

  if (
    !Number.isSafeInteger(frame) ||
    frame < 0 ||
    frame >= plan.totalFrames
  ) {
    throw new Error(
      "M10.4 invalid audio frame",
    );
  }

  const startFade =
    plan.fadeInFrames > 0
      ? smoothstep(
          frame / plan.fadeInFrames,
        )
      : 1;

  const remaining =
    plan.totalFrames - frame - 1;

  const endFade =
    plan.fadeOutFrames > 0
      ? smoothstep(
          remaining / plan.fadeOutFrames,
        )
      : 1;

  const attenuation =
    speechActivity(plan, frame) *
    plan.duckingReductionDb;

  return decibelsToLinear(
    plan.musicBaseGainDb - attenuation,
  ) * Math.min(startFade, endFade);
}
