export interface DurationCalibrationOptions {
  voice?: string;
  speed?: number;
  targetDurationSeconds?: number;
}

/**
 * Returns calibrated words per minute for a given requested video duration and speech speed.
 * Kokoro at speed 0.9 speaks short sentences (<45s) at ~142 WPM, medium videos (45-90s)
 * at ~138-140 WPM, and longer videos (>=120s) at ~135 WPM due to paragraph cadence.
 */
export function getCalibratedWpm(
  targetDurationSeconds: number,
  speed: number = 0.9,
): number {
  const baseSpeedRatio = speed / 0.9;
  let baseRateAtPointNine: number;

  if (targetDurationSeconds <= 35) {
    baseRateAtPointNine = 142.5;
  } else if (targetDurationSeconds <= 50) {
    baseRateAtPointNine = 140.0;
  } else if (targetDurationSeconds <= 90) {
    baseRateAtPointNine = 138.0;
  } else {
    baseRateAtPointNine = 135.0;
  }

  return Math.round(baseRateAtPointNine * baseSpeedRatio * 10) / 10;
}

/**
 * Counts genuine spoken words, excluding isolated punctuation marks.
 */
export function countSpokenWords(text: string): number {
  return text
    .trim()
    .split(/\s+/u)
    .filter((token) => /[a-zA-Z0-9]/u.test(token))
    .length;
}

/**
 * Calculates the calibrated target word count for a target duration and speed.
 */
export function calculateCalibratedTargetWords(
  durationSeconds: number,
  speed: number = 0.9,
): number {
  const wpm = getCalibratedWpm(durationSeconds, speed);
  return Math.round((durationSeconds / 60) * wpm);
}

/**
 * Estimates spoken duration in seconds given text and calibration options.
 */
export function estimateCalibratedSpokenDuration(
  text: string,
  options: DurationCalibrationOptions = {},
): {
  wordCount: number;
  estimatedDurationSeconds: number;
  calibratedWpm: number;
} {
  const wordCount = countSpokenWords(text);
  const targetDuration = options.targetDurationSeconds ?? (wordCount / 135) * 60;
  const speed = options.speed ?? 0.9;
  const calibratedWpm = getCalibratedWpm(targetDuration, speed);

  const estimatedDurationSeconds = (wordCount / calibratedWpm) * 60;

  return {
    wordCount,
    estimatedDurationSeconds: Math.round(estimatedDurationSeconds * 100) / 100,
    calibratedWpm,
  };
}

/**
 * Verifies if duration is within standard policy tolerance.
 * Standard tolerance: +/- 10% (0.10).
 */
export function isDurationWithinTolerance(
  actualDurationSeconds: number,
  targetDurationSeconds: number,
  toleranceRatio: number = 0.10,
): {
  withinTolerance: boolean;
  deviationSeconds: number;
  deviationRatio: number;
  minAllowedSeconds: number;
  maxAllowedSeconds: number;
} {
  const deviationSeconds = actualDurationSeconds - targetDurationSeconds;
  const deviationRatio = Math.abs(deviationSeconds) / targetDurationSeconds;
  const minAllowedSeconds = targetDurationSeconds * (1 - toleranceRatio);
  const maxAllowedSeconds = targetDurationSeconds * (1 + toleranceRatio);

  return {
    withinTolerance: deviationRatio <= toleranceRatio,
    deviationSeconds: Math.round(deviationSeconds * 100) / 100,
    deviationRatio: Math.round(deviationRatio * 1000) / 1000,
    minAllowedSeconds: Math.round(minAllowedSeconds * 100) / 100,
    maxAllowedSeconds: Math.round(maxAllowedSeconds * 100) / 100,
  };
}

/**
 * Calculates the exact word delta needed to bring an actual spoken narration
 * into target duration, using the empirical speaking rate measured from the audio.
 */
export function calculateCorrectionWordDelta(
  actualDurationSeconds: number,
  targetDurationSeconds: number,
  currentWordCount: number,
): {
  measuredWpm: number;
  wordDelta: number;
  recommendedNewWordCount: number;
} {
  if (actualDurationSeconds <= 0) {
    throw new Error("actualDurationSeconds must be positive");
  }

  const measuredWpm = (currentWordCount / actualDurationSeconds) * 60;
  const durationDeltaSeconds = targetDurationSeconds - actualDurationSeconds;
  const rawWordDelta = (durationDeltaSeconds / 60) * measuredWpm;
  const wordDelta = Math.round(rawWordDelta);
  const recommendedNewWordCount = Math.max(10, currentWordCount + wordDelta);

  return {
    measuredWpm: Math.round(measuredWpm * 10) / 10,
    wordDelta,
    recommendedNewWordCount,
  };
}
