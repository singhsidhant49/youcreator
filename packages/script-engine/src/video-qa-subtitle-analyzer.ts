import { createHash } from "node:crypto";
import { z } from "zod";

import {
  RemotionCompositionSchema,
  type RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  verifyRemotionCaptionPlan,
  type RemotionCaptionPlan,
} from "./remotion-caption-plan.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const SubtitleQaFindingSchema = z.object({
  code: z.enum([
    "CAPTION_TOO_FAST",
    "CAPTION_TOO_SHORT",
    "CAPTION_TOO_LONG",
    "SUBTITLE_SAFE_AREA",
    "SUBTITLE_OVERFLOW",
    "LOW_TEXT_CONTRAST",
    "INVALID_WORD_TIMING",
  ]),
  severity: z.enum(["warning", "error"]),
  cueIndex: z.number().int().nonnegative(),
  startFrame: z.number().int().nonnegative(),
  endFrameExclusive: z.number().int().positive(),
  detail: z.string().min(1),
}).strict();

export const SubtitleQaReportSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  compositionHash: Hash,
  captionPlanHash: Hash,
  cueCount: z.number().int().nonnegative(),
  findings: z.array(SubtitleQaFindingSchema),
  reportHash: Hash,
}).strict();

export type SubtitleQaFinding = z.infer<
  typeof SubtitleQaFindingSchema
>;

export type SubtitleQaReport = z.infer<
  typeof SubtitleQaReportSchema
>;

export interface SubtitleQaPolicy {
  maxCharactersPerSecond?: number;
  minCueDurationSeconds?: number;
  maxCueDurationSeconds?: number;
  allowPunctuationOnlyCues?: boolean;
  minPunctuationCueDurationSeconds?: number;

  safeHorizontalFraction?: number;
  safeBottomFraction?: number;

  fontSizePx?: number;
  lineHeight?: number;
  horizontalPaddingPx?: number;
  verticalPaddingPx?: number;
  wordGapPx?: number;

  maxLines?: number;
  minimumContrastRatio?: number;
}

/**
 * Default presentation mirrors the current
 * M7.4 RemotionCaptions style.
 *
 * These are design-system inputs, not measurements
 * obtained from Chromium.
 */
export const DEFAULT_SUBTITLE_QA_POLICY = {
  maxCharactersPerSecond: 22,
  minCueDurationSeconds: 0.45,
  maxCueDurationSeconds: 7,

  safeHorizontalFraction: 0.07,
  safeBottomFraction: 0.08,

  fontSizePx: 48,
  lineHeight: 1.3,
  horizontalPaddingPx: 25,
  verticalPaddingPx: 13,
  wordGapPx: 13,

  maxLines: 2,
  minimumContrastRatio: 4.5,
} as const;

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function srgb(channel: number): number {
  const x = channel / 255;

  return x <= 0.04045
    ? x / 12.92
    : ((x + 0.055) / 1.055) ** 2.4;
}

function luminance(
  color: readonly [number, number, number],
): number {
  return (
    0.2126 * srgb(color[0]) +
    0.7152 * srgb(color[1]) +
    0.0722 * srgb(color[2])
  );
}

export function contrastRatio(
  foreground: readonly [number, number, number],
  background: readonly [number, number, number],
): number {
  const a = luminance(foreground);
  const b = luminance(background);

  return (
    (Math.max(a, b) + 0.05) /
    (Math.min(a, b) + 0.05)
  );
}

/**
 * Conservative width heuristic.
 *
 * Actual font glyph widths depend on browser,
 * font and shaping. M8 visual screenshot
 * acceptance must verify final pixels.
 */
export function estimateCaptionLines(
  words: readonly string[],
  availableWidth: number,
  fontSize: number,
  wordGap: number,
): number {
  if (
    !Number.isFinite(availableWidth) ||
    availableWidth <= 0 ||
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    !Number.isFinite(wordGap) ||
    wordGap < 0
  ) {
    throw new Error(
      "M8 invalid subtitle layout measurements",
    );
  }

  if (words.length === 0) {
    return 0;
  }

  let lines = 1;
  let occupied = 0;

  for (const text of words) {
    const estimatedWidth =
      Array.from(text).length *
      fontSize * 0.58;

    if (estimatedWidth > availableWidth) {
      // One unbreakable token exceeds line width.
      return Number.POSITIVE_INFINITY;
    }

    const additional =
      occupied === 0
        ? estimatedWidth
        : wordGap + estimatedWidth;

    if (
      occupied > 0 &&
      occupied + additional > availableWidth
    ) {
      lines++;
      occupied = estimatedWidth;
    } else {
      occupied += additional;
    }
  }

  return lines;
}

function policyValues(
  policy: SubtitleQaPolicy,
) {
  const values = {
    ...DEFAULT_SUBTITLE_QA_POLICY,
    ...policy,
  };

  const finitePositive = [
    values.maxCharactersPerSecond,
    values.minCueDurationSeconds,
    values.maxCueDurationSeconds,
    values.fontSizePx,
    values.lineHeight,
    values.maxLines,
    values.minimumContrastRatio,
  ];

  if (
    finitePositive.some(
      (value) =>
        !Number.isFinite(value) ||
        value <= 0,
    ) ||
    values.maxCueDurationSeconds <
      values.minCueDurationSeconds ||
    !Number.isSafeInteger(values.maxLines) ||
    values.maxLines < 1
  ) {
    throw new Error(
      "M8 invalid subtitle QA policy",
    );
  }

  const fractions = [
    values.safeHorizontalFraction,
    values.safeBottomFraction,
  ];

  if (
    fractions.some(
      (value) =>
        !Number.isFinite(value) ||
        value < 0 ||
        value >= 0.5,
    ) ||
    [
      values.horizontalPaddingPx,
      values.verticalPaddingPx,
      values.wordGapPx,
    ].some(
      (value) =>
        !Number.isFinite(value) ||
        value < 0,
    )
  ) {
    throw new Error(
      "M8 invalid subtitle QA policy",
    );
  }

  return values;
}

export function analyzeVideoQaSubtitles(
  compositionInput: RemotionComposition,
  captionInput: RemotionCaptionPlan,
  policy: SubtitleQaPolicy = {},
): SubtitleQaReport {
  const composition =
    RemotionCompositionSchema.parse(
      compositionInput,
    );

  const captionPlan =
    verifyRemotionCaptionPlan(
      captionInput,
      composition,
    );

  const p = policyValues(policy);

  const findings: SubtitleQaFinding[] = [];

  const push = (
    cue: RemotionCaptionPlan["cues"][number],
    code: SubtitleQaFinding["code"],
    severity: SubtitleQaFinding["severity"],
    detail: string,
  ) => {
    findings.push({
      code,
      severity,
      cueIndex: cue.cueIndex,
      startFrame: cue.startFrame,
      endFrameExclusive:
        cue.endFrameExclusive,
      detail,
    });
  };

  const width = composition.width;
  const height = composition.height;

  const availableWidth =
    width * (1 - 2 * p.safeHorizontalFraction) -
    2 * p.horizontalPaddingPx;

  const availableHeight =
    height * (1 - p.safeBottomFraction);

  for (const cue of captionPlan.cues) {
    const duration =
      (cue.endFrameExclusive -
        cue.startFrame) / composition.fps;

    const texts = cue.words.map(
      (word) => word.text,
    );

    const text = texts.join(" ");
    const isPunctuationOnly = !/[a-zA-Z0-9]/.test(text);

    const cps =
      text.length / duration;

    if (
      !isPunctuationOnly &&
      cps > p.maxCharactersPerSecond
    ) {
      push(
        cue,
        "CAPTION_TOO_FAST",
        "warning",
        `Reading speed ${cps.toFixed(1)} chars/sec exceeds ${p.maxCharactersPerSecond}`,
      );
    }

    if (
      !isPunctuationOnly &&
      duration < p.minCueDurationSeconds
    ) {
      push(
        cue,
        "CAPTION_TOO_SHORT",
        "warning",
        `Cue duration ${duration.toFixed(3)}s is below ${p.minCueDurationSeconds}s`,
      );
    } else if (
      isPunctuationOnly &&
      !p.allowPunctuationOnlyCues &&
      p.minPunctuationCueDurationSeconds !== undefined &&
      duration < p.minPunctuationCueDurationSeconds
    ) {
      push(
        cue,
        "CAPTION_TOO_SHORT",
        "warning",
        `Punctuation cue duration ${duration.toFixed(3)}s is below ${p.minPunctuationCueDurationSeconds}s`,
      );
    }

    if (
      duration >
      p.maxCueDurationSeconds
    ) {
      push(
        cue,
        "CAPTION_TOO_LONG",
        "warning",
        `Cue duration ${duration.toFixed(3)}s exceeds ${p.maxCueDurationSeconds}s`,
      );
    }

    for (const word of cue.words) {
      if (
        word.startFrame <
          cue.startFrame ||
        word.startFrame >=
          cue.endFrameExclusive ||
        word.endFrameExclusive <=
          word.startFrame
      ) {
        push(
          cue,
          "INVALID_WORD_TIMING",
          "error",
          `Invalid visible frame interval for word ${word.index}`,
        );
      }
    }

    const lines = estimateCaptionLines(
      texts,
      availableWidth,
      p.fontSizePx,
      p.wordGapPx,
    );

    if (
      !Number.isFinite(lines) ||
      lines > p.maxLines
    ) {
      push(
        cue,
        "SUBTITLE_OVERFLOW",
        "error",
        `Estimated subtitle lines ${lines} exceed maximum ${p.maxLines}`,
      );
    }

    const safeLines =
      Number.isFinite(lines)
        ? lines
        : p.maxLines + 1;

    const estimatedPanelHeight =
      safeLines *
        p.fontSizePx *
        p.lineHeight +
      2 * p.verticalPaddingPx;

    if (
      estimatedPanelHeight >
      availableHeight
    ) {
      push(
        cue,
        "SUBTITLE_SAFE_AREA",
        "error",
        "Subtitle panel exceeds available vertical area",
      );
    }
  }

  /**
   * Foreground/background styles:
   * white text on 66%-opaque black.
   *
   * Worst case compositing over pure white
   * produces RGB(87,87,87).
   */
  const effectiveBackground:
    [number, number, number] =
      [87, 87, 87];

  const whiteContrast = contrastRatio(
    [255, 255, 255],
    effectiveBackground,
  );

  if (
    whiteContrast <
    p.minimumContrastRatio
  ) {
    for (const cue of captionPlan.cues) {
      push(
        cue,
        "LOW_TEXT_CONTRAST",
        "warning",
        `Estimated worst-case contrast ${whiteContrast.toFixed(2)}:1`,
      );
    }
  }

  const payload = {
    version: 1 as const,
    jobId: composition.jobId,
    compositionHash:
      composition.compositionHash,
    captionPlanHash:
      captionPlan.captionPlanHash,
    cueCount: captionPlan.cues.length,
    findings,
  };

  return SubtitleQaReportSchema.parse({
    ...payload,
    reportHash: sha256(payload),
  });
}

export function verifyVideoQaSubtitleReport(
  candidate: unknown,
  composition: RemotionComposition,
  captionPlan: RemotionCaptionPlan,
  policy: SubtitleQaPolicy = {},
): SubtitleQaReport {
  const saved =
    SubtitleQaReportSchema.parse(candidate);

  const rebuilt = analyzeVideoQaSubtitles(
    composition,
    captionPlan,
    policy,
  );

  if (
    JSON.stringify(saved) !==
    JSON.stringify(rebuilt)
  ) {
    throw new Error(
      "M8 subtitle QA canonical reconstruction mismatch",
    );
  }

  return saved;
}
