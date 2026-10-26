import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  VideoScript,
} from "@youcreator/contracts";

import {
  StoryboardPlanner,
} from "./storyboard-planner.js";

import {
  validateStoryboardCoverage,
} from "./storyboard-coverage.js";

const script: VideoScript = {
  version: 1,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook:
    "You sit down to work, but suddenly everything else feels more important.",
  sections: [
    {
      id: "section-001",
      title: "Emotional Avoidance",
      narration:
        "Avoiding difficult tasks can provide temporary emotional relief.",
      estimatedDurationSeconds: 15,
    },
  ],
  outro: "Begin with one manageable action.",
};

function visual(slot: number) {
  return {
    slot,
    visualRequest: {
      description:
        "A cinematic realistic person working " +
        "at a quiet desk beside a window",
      searchQueries: [
        "person working quietly at desk",
      ],
      intent: "illustration",
      preferredMediaKind: "either",
    },
    motion: "slow_zoom_in",
    transition: "cut",
  };
}

function mockLLM(
  plans: unknown[],
) {
  const responses = [...plans];

  return {
    generate: vi.fn(async () => {
      const response = responses.shift();

      if (!response) {
        throw new Error("Unexpected LLM request");
      }

      return {
        text: JSON.stringify(response),
        model: "test-model",
      };
    }),
  };
}

function oneScene(...slots: number[]) {
  return {
    scenes: [
      {
        purpose: "Illustrate the narration visually",
        shots: slots.map(visual),
      },
    ],
  };
}

describe("StoryboardPlanner", () => {
  it("generates a valid storyboard with exact coverage", async () => {
    const llm = mockLLM([
      oneScene(0, 1),
      oneScene(0),
      oneScene(0),
    ]);

    const planner = new StoryboardPlanner(llm, {
      maxWordsPerShot: 8,
    });

    const storyboard = await planner.plan(script);

    expect(storyboard.sections).toHaveLength(3);

    const coverage = validateStoryboardCoverage(
      script,
      storyboard,
    );

    expect(coverage.passed).toBe(true);
    expect(coverage.totalShots).toBe(4);
    expect(llm.generate).toHaveBeenCalledTimes(3);
  });

  it("rejects omitted shot slots", async () => {
    const llm = mockLLM([
      oneScene(0),
    ]);

    const planner = new StoryboardPlanner(llm, {
      maxWordsPerShot: 8,
    });

    await expect(
      planner.plan(script),
    ).rejects.toThrow(
      "shot slot mismatch",
    );
  });

  it("rejects duplicate shot slots", async () => {
    const llm = mockLLM([
      oneScene(0, 0, 1),
    ]);

    const planner = new StoryboardPlanner(llm, {
      maxWordsPerShot: 8,
    });

    await expect(
      planner.plan(script),
    ).rejects.toThrow(
      "shot slot mismatch",
    );
  });

  it("rejects reordered shot slots", async () => {
    const llm = mockLLM([
      oneScene(1, 0),
    ]);

    const planner = new StoryboardPlanner(llm, {
      maxWordsPerShot: 8,
    });

    await expect(
      planner.plan(script),
    ).rejects.toThrow(
      "shot slot mismatch",
    );
  });

  it("rejects invalid LLM JSON", async () => {
    const planner = new StoryboardPlanner(
      {
        async generate() {
          return {
            text: "{invalid",
            model: "test-model",
          };
        },
      },
    );

    await expect(
      planner.plan(script),
    ).rejects.toThrow(
      "invalid JSON",
    );
  });

  it("supports longer narration shots for audiobook mode", async () => {
    const llm = mockLLM([
      oneScene(0),
      oneScene(0),
      oneScene(0),
    ]);

    const planner = new StoryboardPlanner(llm, {
      profile: "audiobook",
    });

    const storyboard = await planner.plan(script);

    const coverage = validateStoryboardCoverage(
      script,
      storyboard,
    );

    expect(coverage.passed).toBe(true);
    expect(coverage.totalShots).toBe(3);
  });

  it("rejects invalid shot-length configuration", async () => {
    const llm = mockLLM([]);

    const planner = new StoryboardPlanner(llm, {
      maxWordsPerShot: 0,
    });

    await expect(
      planner.plan(script),
    ).rejects.toThrow(
      "Invalid maxWordsPerShot",
    );

    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("merges short trailing remainder shots when minDurationSeconds is enforced", async () => {
    // The hook is 11 words: "You sit down to work, but suddenly everything else feels more important."
    // With maxWordsPerShot: 8 and wordsPerMinute: 135:
    // Without minDurationSeconds, it produces 2 slots (8 words + 3 words).
    // With minDurationSeconds: 1.8, the 3 words (1.33s < 1.8s) merge into the 8 words, producing 1 slot.
    const llm = mockLLM([
      oneScene(0),
      oneScene(0),
      oneScene(0),
    ]);

    const planner = new StoryboardPlanner(llm, {
      maxWordsPerShot: 8,
      wordsPerMinute: 135,
      minDurationSeconds: 1.8,
    });

    const storyboard = await planner.plan(script);
    expect(storyboard.sections).toHaveLength(3);
    const coverage = validateStoryboardCoverage(script, storyboard);
    expect(coverage.passed).toBe(true);
    expect(coverage.totalShots).toBe(3);
  });
});
