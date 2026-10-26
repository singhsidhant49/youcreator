import { describe, expect, it } from "vitest";

import {
  validateStoryboardCoverage,
} from "./storyboard-coverage.js";

import type {
  VideoScript,
  Storyboard,
} from "@youcreator/contracts";

const script: VideoScript = {
  version: 1,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",

  hook:
    "You sit down to work, but suddenly " +
    "everything else feels more important.",

  sections: [
    {
      id: "section-001",
      title: "Emotional Avoidance",

      narration:
        "Avoiding difficult tasks can provide " +
        "temporary emotional relief.",

      estimatedDurationSeconds: 15,
    },
  ],

  outro:
    "Begin with one manageable action.",
};

function shot(
  id: string,
  narrationText: string,
) {
  return {
    id,
    narrationText,
    estimatedDurationSeconds: 5,
    motion: "slow_zoom_in" as const,
    transition: "cut" as const,

    visualRequest: {
      description:
        "A realistic person sitting at a desk " +
        "with an unfinished assignment",

      searchQueries: [
        "person working at desk",
      ],
      negativeTerms: [],

      intent: "illustration" as const,
      preferredMediaKind: "either" as const,
    },
  };
}

function section(
  id: string,
  scriptSegmentId: string,
  narrationShots: string[],
) {
  return {
    id,
    scriptSegmentId,
    title: scriptSegmentId,

    scenes: [
      {
        id: `scene-${id}`,
        purpose: "Illustrate narration",

        shots: narrationShots.map(
          (text, index) =>
            shot(
              `shot-${id}-${index + 1}`,
              text,
            ),
        ),
      },
    ],
  };
}

function makeStoryboard(): Storyboard {
  return {
    version: 1,
    scriptTitle: script.title,

    sections: [
      section(
        "sb-hook",
        "hook",
        [
          "You sit down to work,",
          "but suddenly everything else " +
            "feels more important.",
        ],
      ),

      section(
        "sb-main",
        "section-001",
        [
          script.sections[0]!.narration,
        ],
      ),

      section(
        "sb-outro",
        "outro",
        [script.outro],
      ),
    ],
  };
}

describe("Storyboard narration coverage", () => {
  it("accepts complete narration coverage", () => {
    const result = validateStoryboardCoverage(
      script,
      makeStoryboard(),
    );

    expect(result.passed).toBe(true);
    expect(result.expectedWords).toBe(
      result.coveredWords,
    );
    expect(result.coveredSegments).toBe(3);
    expect(result.totalShots).toBe(4);
  });

  it("rejects missing narration segments", () => {
    const storyboard = makeStoryboard();

    storyboard.sections.pop();

    const result = validateStoryboardCoverage(
      script,
      storyboard,
    );

    expect(
      result.issues.some(
        (issue) =>
          issue.code === "MISSING_SEGMENT",
      ),
    ).toBe(true);
  });

  it("rejects omitted narration words", () => {
    const storyboard = makeStoryboard();

    storyboard.sections[0]!
      .scenes[0]!
      .shots[1]!
      .narrationText =
        "but everything else feels more important.";

    const result = validateStoryboardCoverage(
      script,
      storyboard,
    );

    expect(
      result.issues.some(
        (issue) =>
          issue.code === "NARRATION_MISMATCH",
      ),
    ).toBe(true);
  });

  it("rejects repeated narration", () => {
    const storyboard = makeStoryboard();

    storyboard.sections[0]!
      .scenes[0]!
      .shots[1]!
      .narrationText =
        "but suddenly suddenly everything " +
        "else feels more important.";

    const result = validateStoryboardCoverage(
      script,
      storyboard,
    );

    expect(result.passed).toBe(false);
  });

  it("rejects incorrectly ordered segments", () => {
    const storyboard = makeStoryboard();

    storyboard.sections.reverse();

    const result = validateStoryboardCoverage(
      script,
      storyboard,
    );

    expect(
      result.issues.some(
        (issue) =>
          issue.code === "SEGMENT_ORDER_MISMATCH",
      ),
    ).toBe(true);
  });

  it("rejects duplicate shot IDs", () => {
    const storyboard = makeStoryboard();

    const firstId =
      storyboard.sections[0]!
        .scenes[0]!
        .shots[0]!.id;

    storyboard.sections[1]!
      .scenes[0]!
      .shots[0]!.id = firstId;

    const result = validateStoryboardCoverage(
      script,
      storyboard,
    );

    expect(
      result.issues.some(
        (issue) =>
          issue.code === "DUPLICATE_ID",
      ),
    ).toBe(true);
  });

  it("accepts whitespace-only differences", () => {
    const storyboard = makeStoryboard();

    storyboard.sections[2]!
      .scenes[0]!
      .shots[0]!
      .narrationText =
        "Begin   with one\nmanageable action.";

    const result = validateStoryboardCoverage(
      script,
      storyboard,
    );

    expect(result.passed).toBe(true);
  });
});
