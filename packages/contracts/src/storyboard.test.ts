import { describe, expect, it } from "vitest";

import {
  StoryboardSchema,
} from "./storyboard.js";

const storyboard = {
  version: 1,

  scriptTitle: "Why Humans Procrastinate",

  sections: [
    {
      id: "sb-section-001",
      scriptSegmentId: "section-001",
      title: "Emotional Avoidance",

      scenes: [
        {
          id: "scene-001",
          purpose: "Show a relatable delay",

          shots: [
            {
              id: "shot-001",

              narrationText:
                "You sit down to work, but suddenly " +
                "everything else feels more important.",

              estimatedDurationSeconds: 6,

              visualRequest: {
                description:
                  "A young adult staring at an unfinished " +
                  "assignment on a desk",

                searchQueries: [
                  "person procrastinating at desk",
                  "unfinished assignment laptop",
                ],

                intent: "illustration",
                preferredMediaKind: "either",
              },
            },
          ],
        },
      ],
    },
  ],
};

describe("Storyboard contracts", () => {
  it("validates a complete storyboard", () => {
    const result = StoryboardSchema.parse(
      storyboard,
    );

    expect(result.sections).toHaveLength(1);

    expect(
      result.sections[0]?.scenes[0]?.shots,
    ).toHaveLength(1);
  });

  it("rejects missing visual descriptions", () => {
    const invalid = structuredClone(storyboard);

    invalid.sections[0]!.scenes[0]!
      .shots[0]!.visualRequest.description = "";

    expect(() =>
      StoryboardSchema.parse(invalid),
    ).toThrow();
  });

  it("rejects invalid estimated durations", () => {
    const invalid = structuredClone(storyboard);

    invalid.sections[0]!.scenes[0]!
      .shots[0]!.estimatedDurationSeconds = -5;

    expect(() =>
      StoryboardSchema.parse(invalid),
    ).toThrow();
  });

  it("rejects empty scenes", () => {
    const invalid = structuredClone(storyboard);

    invalid.sections[0]!.scenes = [];

    expect(() =>
      StoryboardSchema.parse(invalid),
    ).toThrow();
  });

  it("applies motion and transition defaults", () => {
    const result = StoryboardSchema.parse(
      storyboard,
    );

    const shot =
      result.sections[0]!.scenes[0]!.shots[0]!;

    expect(shot.motion).toBe("slow_zoom_in");
    expect(shot.transition).toBe("cut");
    expect(
      shot.visualRequest.negativeTerms,
    ).toEqual([]);
  });
});
