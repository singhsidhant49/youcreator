import {
  VideoScriptSchema,
  type VideoScript,
} from "@youcreator/contracts";

export type EditorialIssueCode =
  | "WEAK_HOOK"
  | "GENERIC_OUTRO"
  | "MISSING_EXAMPLE"
  | "WEAK_SECTION_DEVELOPMENT"
  | "POTENTIAL_OVERCLAIM"
  | "MISSING_PAYOFF"
  | "REDUNDANT_NARRATION"
  | "UNSUPPORTED_CLAIM";

export interface EditorialIssue {
  code: EditorialIssueCode;
  severity: "warning" | "error";
  message: string;
  location: string;
  suggestion: string;
}

export interface EditorialQualityReport {
  passed: boolean;
  issues: EditorialIssue[];
  evaluatedSections: number;
}

export interface EditorialQualityOptions {
  requireExample?: boolean;
  minimumSectionWords?: number;
}

const OVERCLAIM_PATTERNS = [
  /\b(always|never|everyone|nobody)\b/i,
  /\b(proves?|guarantees?|cures?)\b/i,
  /\bthe brain (automatically|always|never)\b/i,
];

const GENERIC_HOOK_PATTERNS = [
  /^(in this video|today we('ll| will| are going to)|welcome back to|let('s| us) talk about|let('s| us) dive into)\b/i,
  /\b(in this video we will|today's video is about)\b/i,
];

const GENERIC_OUTRO_PATTERNS = [
  /start with one small step/i,
  /the choice is yours/i,
  /anything is possible/i,
  /believe in yourself/i,
];

const FILLER_PATTERNS = [
  /\bas we (all )?know\b/i,
  /\bit goes without saying\b/i,
  /\bneedless to say\b/i,
];

const FABRICATED_QUOTE_PATTERNS = [
  /\b(?:einstein|newton|darwin|tesla)\s+(?:once\s+)?(?:said|stated|wrote)\s*[,:]\s*"/i,
];

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasConcreteExample(text: string): boolean {
  return /\b(for example|for instance|imagine|picture this|suppose|consider this)\b/i.test(
    text,
  );
}

export function evaluateEditorialQuality(
  input: VideoScript,
  options: EditorialQualityOptions = {},
): EditorialQualityReport {
  const script = VideoScriptSchema.parse(input);

  const issues: EditorialIssue[] = [];
  const minimumSectionWords =
    options.minimumSectionWords ?? 35;

  if (
    !Number.isInteger(minimumSectionWords) ||
    minimumSectionWords < 0
  ) {
    throw new Error("Invalid editorial quality options");
  }

  // Hook quality: flag very short openings or generic introductions.
  if (countWords(script.hook) < 12) {
    issues.push({
      code: "WEAK_HOOK",
      severity: "warning",
      location: "hook",
      message: "Opening hook may be underdeveloped.",
      suggestion:
        "Introduce curiosity, tension, or a relatable situation.",
    });
  } else if (
    GENERIC_HOOK_PATTERNS.some((pattern) =>
      pattern.test(script.hook),
    )
  ) {
    issues.push({
      code: "WEAK_HOOK",
      severity: "warning",
      location: "hook",
      message: "Opening hook contains generic introductory phrasing.",
      suggestion:
        "Open with a surprising problem, central question, or immediate curiosity within the first 3-5 seconds.",
    });
  }

  // Check for generic endings.
  const hasGenericOutro = GENERIC_OUTRO_PATTERNS.some((pattern) =>
    pattern.test(script.outro),
  );

  if (hasGenericOutro) {
    issues.push({
      code: "GENERIC_OUTRO",
      severity: "warning",
      location: "outro",
      message: "Conclusion contains a generic takeaway.",
      suggestion:
        "Provide a specific insight or actionable conclusion.",
    });
  }

  // Payoff resolution: if hook introduces a question, outro must resolve it.
  const hookHasQuestion =
    /\?|\b(how does|why do|what happens when|how can|can we|does it|how it)\b/i.test(
      script.hook,
    );

  if (hookHasQuestion && (hasGenericOutro || countWords(script.outro) < 8)) {
    issues.push({
      code: "MISSING_PAYOFF",
      severity: "warning",
      location: "outro",
      message:
        "Opening question or central curiosity appears unresolved in the conclusion.",
      suggestion:
        "Ensure the conclusion directly resolves the central question introduced in the opening hook.",
    });
  }

  const fullNarration = [
    script.hook,
    ...script.sections.map((s) => s.narration),
    script.outro,
  ].join(" ");

  // Examples are useful for explanatory videos.
  if (
    options.requireExample &&
    !hasConcreteExample(fullNarration)
  ) {
    issues.push({
      code: "MISSING_EXAMPLE",
      severity: "warning",
      location: "script",
      message: "No explicit illustrative example detected.",
      suggestion:
        "Add a relatable real-world example.",
    });
  }

  for (const section of script.sections) {
    if (
      countWords(section.narration) <
      minimumSectionWords
    ) {
      issues.push({
        code: "WEAK_SECTION_DEVELOPMENT",
        severity: "warning",
        location: section.id,
        message:
          `Section ${section.id} may lack sufficient development.`,
        suggestion:
          "Expand the central idea with useful context or detail.",
      });
    }
  }

  for (const segment of [
    { id: "hook", text: script.hook },
    ...script.sections.map((s) => ({
      id: s.id,
      text: s.narration,
    })),
    { id: "outro", text: script.outro },
  ]) {
    if (
      OVERCLAIM_PATTERNS.some((pattern) =>
        pattern.test(segment.text),
      )
    ) {
      issues.push({
        code: "POTENTIAL_OVERCLAIM",
        severity: "warning",
        location: segment.id,
        message:
          "Narration contains potentially overconfident wording.",
        suggestion:
          "Check whether the claim is justified and qualify it if necessary.",
      });
    }

    if (
      FILLER_PATTERNS.some((pattern) =>
        pattern.test(segment.text),
      )
    ) {
      issues.push({
        code: "REDUNDANT_NARRATION",
        severity: "warning",
        location: segment.id,
        message:
          `Narration in ${segment.id} contains redundant filler phrasing.`,
        suggestion:
          "Remove filler phrases and deliver meaningful new information.",
      });
    }

    if (
      FABRICATED_QUOTE_PATTERNS.some((pattern) =>
        pattern.test(segment.text),
      )
    ) {
      issues.push({
        code: "UNSUPPORTED_CLAIM",
        severity: "warning",
        location: segment.id,
        message:
          `Narration in ${segment.id} attributes an unverified quotation without source evidence.`,
        suggestion:
          "Verify the quotation against primary sources or state the concept directly.",
      });
    }
  }

  return {
    passed: !issues.some(
      (issue) => issue.severity === "error",
    ),
    issues,
    evaluatedSections: script.sections.length,
  };
}
