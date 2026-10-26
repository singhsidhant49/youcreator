import { describe, expect, it } from "vitest";

import {
  promoteScriptCandidate,
  validateScriptCandidate,
} from "./script-candidate.js";

const original = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook:
    "Why do people delay their important tasks even when they know those tasks really matter?",
  sections: [
    {
      id: "section-001",
      title: "Understanding Avoidance",
      narration:
        "Difficult tasks sometimes bring uncomfortable feelings. " +
        "Avoiding those tasks can provide temporary relief, " +
        "even when the delay causes problems later.",
      estimatedDurationSeconds: 12,
    },
  ],
  outro:
    "Start with one small step.",
};

const candidate = {
  ...original,
  outro:
    "Try setting a two-minute timer and starting the easiest part.",
};

describe("Script candidate validation", () => {
  it("accepts a valid targeted revision", () => {
    const report = validateScriptCandidate(
      original,
      candidate,
    );

    expect(report.eligible).toBe(true);
    expect(report.reasons).toHaveLength(0);
  });

  it("rejects excessive narration expansion", () => {
    const expanded = {
      ...original,
      hook: original.hook.repeat(10),
    };

    const report = validateScriptCandidate(
      original,
      expanded,
    );

    expect(report.eligible).toBe(false);
    expect(report.reasons).toContain(
      "Candidate exceeds allowed narration word drift",
    );
  });

  it("rejects changes to script structure", () => {
    const changed = {
      ...candidate,
      title: "Different Title",
    };

    const report = validateScriptCandidate(
      original,
      changed,
    );

    expect(report.eligible).toBe(false);
    expect(report.reasons).toContain(
      "Candidate changed script structure or metadata",
    );
  });

  it("rejects newly introduced editorial issues", () => {
    const changed = {
      ...original,
      hook:
        "The brain always avoids work because it never likes effort.",
    };

    const report = validateScriptCandidate(
      original,
      changed,
      {
        maxWordDriftRatio: 1,
      },
    );

    expect(report.eligible).toBe(false);
    expect(
      report.candidateEditorial.issues.some(
        (issue) =>
          issue.code === "POTENTIAL_OVERCLAIM",
      ),
    ).toBe(true);
  });

  it("promotes an eligible candidate and preserves original", () => {
    const result = promoteScriptCandidate(
      original,
      candidate,
    );

    expect(result.promoted).toBe(true);
    expect(result.script.outro).toBe(candidate.outro);
    expect(result.originalScript.outro).toBe(
      original.outro,
    );

    expect(result.metrics.words).toBeGreaterThan(0);
    expect(
      result.metrics.estimatedDurationSeconds,
    ).toBeGreaterThan(0);
  });

  it("throws when promotion is rejected", () => {
    const invalid = {
      ...candidate,
      title: "Wrong Title",
    };

    expect(() =>
      promoteScriptCandidate(original, invalid),
    ).toThrow("Script promotion rejected");
  });
});
