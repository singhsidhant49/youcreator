import {
  VideoScriptSchema,
  type VideoScript,
} from "@youcreator/contracts";

export type ScriptIssueCode =
  | "TOO_SHORT"
  | "TOO_LONG"
  | "SHORT_SECTION"
  | "DUPLICATE_SECTION_ID"
  | "REPEATED_NARRATION";

export interface ScriptIssue {
  code: ScriptIssueCode;
  severity: "warning" | "error";
  message: string;
  sectionId?: string;
}

export interface ScriptQualityReport {
  passed: boolean;
  totalWords: number;
  targetWords: number;
  estimatedDurationSeconds: number;
  durationDeviation: number;
  issues: ScriptIssue[];
}

export interface ScriptQualityOptions {
  wordsPerMinute?: number;
  minWordRatio?: number;
  maxWordRatio?: number;
  minSectionWords?: number;
}

export function countNarrationWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeNarration(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function analyzeScript(
  input: VideoScript,
  targetDurationSeconds: number,
  options: ScriptQualityOptions = {},
): ScriptQualityReport {
  const script = VideoScriptSchema.parse(input);

  if (
    !Number.isFinite(targetDurationSeconds) ||
    targetDurationSeconds <= 0
  ) {
    throw new Error("Invalid target duration");
  }

  const wordsPerMinute = options.wordsPerMinute ?? 135;
  const minWordRatio = options.minWordRatio ?? 0.75;
  const maxWordRatio = options.maxWordRatio ?? 1.25;
  const minSectionWords = options.minSectionWords ?? 20;

  if (
    !Number.isFinite(wordsPerMinute) ||
    wordsPerMinute <= 0 ||
    minWordRatio <= 0 ||
    maxWordRatio < minWordRatio ||
    minSectionWords < 0
  ) {
    throw new Error("Invalid script quality options");
  }

  const issues: ScriptIssue[] = [];

  const segments = [
    { id: "hook", narration: script.hook },
    ...script.sections.map((section) => ({
      id: section.id,
      narration: section.narration,
    })),
    { id: "outro", narration: script.outro },
  ];

  const totalWords = segments.reduce(
    (sum, segment) =>
      sum + countNarrationWords(segment.narration),
    0,
  );

  const targetWords =
    (targetDurationSeconds / 60) * wordsPerMinute;

  const estimatedDurationSeconds =
    (totalWords / wordsPerMinute) * 60;

  const durationDeviation =
    Math.abs(totalWords - targetWords) / targetWords;

  if (totalWords < targetWords * minWordRatio) {
    issues.push({
      code: "TOO_SHORT",
      severity: "error",
      message:
        `Script has ${totalWords} words; target is approximately ` +
        `${Math.round(targetWords)}.`,
    });
  }

  if (totalWords > targetWords * maxWordRatio) {
    issues.push({
      code: "TOO_LONG",
      severity: "error",
      message:
        `Script has ${totalWords} words; target is approximately ` +
        `${Math.round(targetWords)}.`,
    });
  }

  const sectionIds = new Set<string>();

  for (const section of script.sections) {
    if (sectionIds.has(section.id)) {
      issues.push({
        code: "DUPLICATE_SECTION_ID",
        severity: "error",
        sectionId: section.id,
        message: `Duplicate section ID: ${section.id}`,
      });
    }

    sectionIds.add(section.id);

    if (
      countNarrationWords(section.narration) <
      minSectionWords
    ) {
      issues.push({
        code: "SHORT_SECTION",
        severity: "warning",
        sectionId: section.id,
        message: `Section ${section.id} has very little narration.`,
      });
    }
  }

  const seen = new Map<string, string>();

  for (const segment of segments) {
    const normalized = normalizeNarration(segment.narration);

    if (seen.has(normalized)) {
      issues.push({
        code: "REPEATED_NARRATION",
        severity: "error",
        sectionId: segment.id,
        message:
          `Narration in ${segment.id} duplicates ` +
          `${seen.get(normalized)}.`,
      });
    } else {
      seen.set(normalized, segment.id);
    }
  }

  return {
    passed: !issues.some(
      (issue) => issue.severity === "error",
    ),
    totalWords,
    targetWords: Math.round(targetWords),
    estimatedDurationSeconds,
    durationDeviation,
    issues,
  };
}
