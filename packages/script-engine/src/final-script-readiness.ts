import {
  VideoScriptSchema,
  type VideoScript,
} from "@youcreator/contracts";

import {
  evaluateEditorialQuality,
  type EditorialQualityReport,
} from "./editorial-quality.js";

export interface FinalScriptReadinessOptions {
  targetDurationSeconds: number;
  wordsPerMinute?: number;
  minimumDurationRatio?: number;
  maximumDurationRatio?: number;
  requireEditorialIssueFree?: boolean;
}

export interface FinalScriptReadinessReport {
  ready: boolean;
  wordCount: number;
  estimatedDurationSeconds: number;
  targetDurationSeconds: number;
  durationRatio: number;
  editorial: EditorialQualityReport;
  blockers: string[];
  warnings: string[];
}

function countWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

import { getCalibratedWpm } from "./duration-calibration.js";

export function evaluateFinalScriptReadiness(
  input: VideoScript,
  options: FinalScriptReadinessOptions,
): FinalScriptReadinessReport {
  const script = VideoScriptSchema.parse(input);

  const targetDurationSeconds = options.targetDurationSeconds;
  const wordsPerMinute = options.wordsPerMinute ?? 135;

  const minimumDurationRatio = options.minimumDurationRatio ?? 0.65;
  const maximumDurationRatio = options.maximumDurationRatio ?? 1.35;
  const requireEditorialIssueFree = options.requireEditorialIssueFree ?? false;



  if (
    !Number.isFinite(targetDurationSeconds) ||
    targetDurationSeconds <= 0 ||
    !Number.isFinite(wordsPerMinute) ||
    wordsPerMinute <= 0 ||
    !Number.isFinite(minimumDurationRatio) ||
    minimumDurationRatio <= 0 ||
    !Number.isFinite(maximumDurationRatio) ||
    maximumDurationRatio < minimumDurationRatio
  ) {
    throw new Error(
      "Invalid final script readiness configuration",
    );
  }

  const narration = [
    script.hook,
    ...script.sections.map(
      (section) => section.narration,
    ),
    script.outro,
  ].join(" ");

  const wordCount = countWords(narration);

  const estimatedDurationSeconds =
    (wordCount / wordsPerMinute) * 60;

  const durationRatio =
    estimatedDurationSeconds / targetDurationSeconds;

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (wordCount === 0) {
    blockers.push("Final narration is empty");
  }

  if (durationRatio < minimumDurationRatio) {
    blockers.push(
      "Final script is shorter than allowed duration",
    );
  }

  if (durationRatio > maximumDurationRatio) {
    blockers.push(
      "Final script exceeds allowed duration",
    );
  }

  const sectionIds = script.sections.map(
    (section) => section.id,
  );

  if (new Set(sectionIds).size !== sectionIds.length) {
    blockers.push("Duplicate section IDs");
  }

  const editorial = evaluateEditorialQuality(script);

  for (const issue of editorial.issues) {
    const description =
      `${issue.code} at ${issue.location}: ${issue.message}`;

    if (
      requireEditorialIssueFree ||
      issue.severity === "error"
    ) {
      blockers.push(description);
    } else {
      warnings.push(description);
    }
  }

  return {
    ready: blockers.length === 0,
    wordCount,
    estimatedDurationSeconds,
    targetDurationSeconds,
    durationRatio,
    editorial,
    blockers,
    warnings,
  };
}
