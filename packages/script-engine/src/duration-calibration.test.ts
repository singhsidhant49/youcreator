import { describe, expect, it } from "vitest";
import {
  calculateCalibratedTargetWords,
  calculateCorrectionWordDelta,
  countSpokenWords,
  estimateCalibratedSpokenDuration,
  getCalibratedWpm,
  isDurationWithinTolerance,
} from "./duration-calibration.js";

describe("Duration Calibration & Short-Form Reliability", () => {
  it("calibrates WPM correctly across 30s, 45s, 60s, 120s, and 300s", () => {
    // 30s: ~142.5 WPM at speed 0.9
    expect(getCalibratedWpm(30, 0.9)).toBe(142.5);
    // 45s: 140 WPM at speed 0.9
    expect(getCalibratedWpm(45, 0.9)).toBe(140.0);
    // 60s: 138 WPM at speed 0.9
    expect(getCalibratedWpm(60, 0.9)).toBe(138.0);
    // 120s: 135 WPM at speed 0.9
    expect(getCalibratedWpm(120, 0.9)).toBe(135.0);
    // 300s: 135 WPM at speed 0.9
    expect(getCalibratedWpm(300, 0.9)).toBe(135.0);
  });

  it("calculates calibrated target words for all canonical tiers", () => {
    // 30s -> 71 words
    expect(calculateCalibratedTargetWords(30, 0.9)).toBe(71);
    // 45s -> 105 words
    expect(calculateCalibratedTargetWords(45, 0.9)).toBe(105);
    // 60s -> 138 words
    expect(calculateCalibratedTargetWords(60, 0.9)).toBe(138);
    // 120s -> 270 words
    expect(calculateCalibratedTargetWords(120, 0.9)).toBe(270);
    // 300s -> 675 words
    expect(calculateCalibratedTargetWords(300, 0.9)).toBe(675);
  });

  it("counts spoken words excluding isolated punctuation tokens", () => {
    const raw = "How does a satellite stay powered ? The answer is : sunlight !";
    expect(countSpokenWords(raw)).toBe(10);
  });

  it("estimates calibrated spoken duration accurately", () => {
    // 71 words for 30s target at 142.5 WPM
    const words71 = Array(71).fill("word").join(" ");
    const est = estimateCalibratedSpokenDuration(words71, {
      targetDurationSeconds: 30,
      speed: 0.9,
    });
    expect(est.wordCount).toBe(71);
    // 71 / 142.5 * 60 = 29.89s (which is 99.6% of 30s, perfectly within +/-10%)
    expect(est.estimatedDurationSeconds).toBeCloseTo(29.89, 1);
  });

  it("evaluates tolerance bounds strictly for +/- 10%", () => {
    // 30s target: bounds are 27.0s - 33.0s
    expect(isDurationWithinTolerance(24.4, 30, 0.10).withinTolerance).toBe(false);
    expect(isDurationWithinTolerance(24.4, 30, 0.10).deviationRatio).toBeCloseTo(0.187, 2);

    expect(isDurationWithinTolerance(27.5, 30, 0.10).withinTolerance).toBe(true);
    expect(isDurationWithinTolerance(32.8, 30, 0.10).withinTolerance).toBe(true);
    expect(isDurationWithinTolerance(33.5, 30, 0.10).withinTolerance).toBe(false);
  });

  it("calculates accurate correction word delta from empirical audio duration", () => {
    // For 30s target where 58 words yielded 24.4s audio:
    // Empirical WPM = (58 / 24.4) * 60 = 142.6 WPM
    // Duration deficit = 30.0 - 24.4 = 5.6s
    // Required delta = (5.6 / 60) * 142.6 = +13.3 words -> 13 words
    // Recommended new word count = 58 + 13 = 71 words
    const correction = calculateCorrectionWordDelta(24.4, 30.0, 58);
    expect(correction.measuredWpm).toBeCloseTo(142.6, 1);
    expect(correction.wordDelta).toBe(13);
    expect(correction.recommendedNewWordCount).toBe(71);
  });

  it("calculates downward correction word delta when audio runs too long", () => {
    // For 30s target where 85 words yielded 36.0s audio:
    // Empirical WPM = (85 / 36.0) * 60 = 141.7 WPM
    // Duration surplus = 30 - 36 = -6.0s
    // Required delta = (-6.0 / 60) * 141.7 = -14.17 words -> -14 words
    // Recommended new word count = 85 - 14 = 71 words
    const correction = calculateCorrectionWordDelta(36.0, 30.0, 85);
    expect(correction.wordDelta).toBe(-14);
    expect(correction.recommendedNewWordCount).toBe(71);
  });
});
