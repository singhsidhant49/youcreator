import {
  VideoScriptSchema,
  type VideoScript,
} from "@youcreator/contracts";

import {
  evaluateEditorialQuality,
  type EditorialQualityOptions,
  type EditorialQualityReport,
} from "./editorial-quality.js";

export interface CandidatePolicy {
  wordsPerMinute?: number;
  maxWordDriftRatio?: number;
  maxDurationDriftSeconds?: number;
  editorial?: EditorialQualityOptions;
}

export interface ScriptMetrics {
  words: number;
  estimatedDurationSeconds: number;
}

export interface CandidateValidation {
  eligible: boolean;
  reasons: string[];
  original: ScriptMetrics;
  candidate: ScriptMetrics;
  originalEditorial: EditorialQualityReport;
  candidateEditorial: EditorialQualityReport;
}

export interface PromotedScript {
  script: VideoScript;
  originalScript: VideoScript;
  metrics: ScriptMetrics;
  validation: CandidateValidation;
  promoted: true;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function narration(script: VideoScript): string {
  return [
    script.hook,
    ...script.sections.map(
      (section) => section.narration,
    ),
    script.outro,
  ].join(" ");
}

function metrics(
  script: VideoScript,
  wordsPerMinute: number,
): ScriptMetrics {
  const words = countWords(narration(script));

  return {
    words,
    estimatedDurationSeconds:
      (words / wordsPerMinute) * 60,
  };
}

function validatePolicy(policy: CandidatePolicy): void {
  const wpm = policy.wordsPerMinute ?? 135;
  const wordDrift = policy.maxWordDriftRatio ?? 0.2;
  const durationDrift =
    policy.maxDurationDriftSeconds ?? 15;

  if (
    !Number.isFinite(wpm) ||
    wpm <= 0 ||
    !Number.isFinite(wordDrift) ||
    wordDrift < 0 ||
    !Number.isFinite(durationDrift) ||
    durationDrift < 0
  ) {
    throw new Error("Invalid candidate validation policy");
  }
}

export function validateScriptCandidate(
  originalInput: VideoScript,
  candidateInput: VideoScript,
  policy: CandidatePolicy = {},
): CandidateValidation {
  validatePolicy(policy);

  const original = VideoScriptSchema.parse(originalInput);
  const candidate = VideoScriptSchema.parse(candidateInput);

  const wpm = policy.wordsPerMinute ?? 135;
  const maxWordDriftRatio =
    policy.maxWordDriftRatio ?? 0.2;
  const maxDurationDriftSeconds =
    policy.maxDurationDriftSeconds ?? 15;

  const originalMetrics = metrics(original, wpm);
  const candidateMetrics = metrics(candidate, wpm);

  const reasons: string[] = [];

  // Editorial revision must not silently modify metadata,
  // structure, section identities or section titles.
  const unchangedStructure = (
    a: VideoScript,
    b: VideoScript,
  ): boolean => {
    const withoutNarration = (script: VideoScript) => ({
      ...script,
      hook: "",
      outro: "",
      sections: script.sections.map((section) => ({
        ...section,
        narration: "",
      })),
    });

    return JSON.stringify(withoutNarration(a)) ===
      JSON.stringify(withoutNarration(b));
  };

  if (!unchangedStructure(original, candidate)) {
    reasons.push(
      "Candidate changed script structure or metadata",
    );
  }

  if (candidateMetrics.words === 0) {
    reasons.push("Candidate narration is empty");
  }

  const wordDrift =
    originalMetrics.words === 0
      ? 1
      : Math.abs(
          candidateMetrics.words - originalMetrics.words,
        ) / originalMetrics.words;

  if (wordDrift > maxWordDriftRatio) {
    reasons.push(
      "Candidate exceeds allowed narration word drift",
    );
  }

  const durationDrift = Math.abs(
    candidateMetrics.estimatedDurationSeconds -
    originalMetrics.estimatedDurationSeconds,
  );

  if (durationDrift > maxDurationDriftSeconds) {
    reasons.push(
      "Candidate exceeds allowed duration drift",
    );
  }

  const originalEditorial = evaluateEditorialQuality(
    original,
    policy.editorial,
  );

  const candidateEditorial = evaluateEditorialQuality(
    candidate,
    policy.editorial,
  );

  // Block any newly introduced heuristic findings.
  // This is not equivalent to proving factual correctness.
  const originalIssueKeys = new Set(
    originalEditorial.issues.map(
      (issue) => `${issue.code}:${issue.location}`,
    ),
  );

  const newIssues = candidateEditorial.issues.filter(
    (issue) =>
      !originalIssueKeys.has(
        `${issue.code}:${issue.location}`,
      ),
  );

  if (newIssues.length > 0) {
    reasons.push(
      `Candidate introduced ${newIssues.length} new editorial issue(s)`,
    );
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    original: originalMetrics,
    candidate: candidateMetrics,
    originalEditorial,
    candidateEditorial,
  };
}

export function promoteScriptCandidate(
  original: VideoScript,
  candidate: VideoScript,
  policy: CandidatePolicy = {},
): PromotedScript {
  const validation = validateScriptCandidate(
    original,
    candidate,
    policy,
  );

  if (!validation.eligible) {
    throw new Error(
      `Script promotion rejected: ${validation.reasons.join("; ")}`,
    );
  }

  // Explicit, independent promoted artifact.
  // Neither supplied script is modified.
  return {
    script: structuredClone(
      VideoScriptSchema.parse(candidate),
    ),
    originalScript: structuredClone(
      VideoScriptSchema.parse(original),
    ),
    metrics: validation.candidate,
    validation,
    promoted: true,
  };
}
