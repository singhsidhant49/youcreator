import {
  describe,
  expect,
  it,
} from "vitest";

import {
  segmentNarrationIntoShots,
  splitNarrationSentences,
} from "./narration-shot-segmenter.js";

describe("Sentence-aware narration segmentation", () => {
  it("splits narration into complete sentences", () => {
    const result = splitNarrationSentences(
      "Why do we delay? It feels easier. But why!",
    );

    expect(result).toEqual([
      "Why do we delay?",
      "It feels easier.",
      "But why!",
    ]);
  });

  it("keeps short sentences together when they fit", () => {
    const result = segmentNarrationIntoShots(
      "You sit down. The phone rings. Work begins.",
      {
        maxWordsPerShot: 6,
        wordsPerMinute: 120,
      },
    );

    expect(result).toHaveLength(2);

    expect(result[0]?.narrationText).toBe(
      "You sit down. The phone rings.",
    );

    expect(result[1]?.narrationText).toBe(
      "Work begins.",
    );
  });

  it("preserves sentence boundaries when possible", () => {
    const result = segmentNarrationIntoShots(
      "The first sentence ends here. " +
        "A different thought begins right now.",
      {
        maxWordsPerShot: 8,
        wordsPerMinute: 120,
      },
    );

    expect(result).toHaveLength(2);

    expect(result[0]?.narrationText).toBe(
      "The first sentence ends here.",
    );
  });

  it("splits sentences exceeding the word limit", () => {
    const result = segmentNarrationIntoShots(
      "One two three four five six seven eight nine ten.",
      {
        maxWordsPerShot: 4,
        wordsPerMinute: 120,
      },
    );

    expect(result).toHaveLength(3);

    expect(
      result.every(
        (slot) =>
          slot.narrationText.split(/\s+/u).length <= 4,
      ),
    ).toBe(true);
  });

  it("preserves complete narration coverage", () => {
    const narration =
      "You start working. Then something distracting " +
      "appears on the screen. You lose focus.";

    const result = segmentNarrationIntoShots(
      narration,
      {
        maxWordsPerShot: 5,
        wordsPerMinute: 135,
      },
    );

    expect(
      result.map((slot) => slot.narrationText).join(" "),
    ).toBe(narration);
  });

  it("calculates estimated duration", () => {
    const result = segmentNarrationIntoShots(
      "One two three four.",
      {
        maxWordsPerShot: 10,
        wordsPerMinute: 120,
      },
    );

    expect(
      result[0]?.estimatedDurationSeconds,
    ).toBeCloseTo(2);
  });

  it("returns no shots for empty narration", () => {
    const result = segmentNarrationIntoShots(
      "   ",
      {
        maxWordsPerShot: 10,
        wordsPerMinute: 120,
      },
    );

    expect(result).toEqual([]);
  });

  it("rejects invalid settings", () => {
    expect(() =>
      segmentNarrationIntoShots("Test", {
        maxWordsPerShot: 0,
        wordsPerMinute: 120,
      }),
    ).toThrow("Invalid maxWordsPerShot");

    expect(() =>
      segmentNarrationIntoShots("Test", {
        maxWordsPerShot: 10,
        wordsPerMinute: 0,
      }),
    ).toThrow("Invalid wordsPerMinute");

    expect(() =>
      segmentNarrationIntoShots("Test", {
        maxWordsPerShot: 10,
        wordsPerMinute: 120,
        minDurationSeconds: -1,
      }),
    ).toThrow("Invalid minDurationSeconds");
  });

  it("eliminates sub-1.8s cuts when minDurationSeconds is specified", () => {
    // 14 words: 12 words + 2 words ("vast text.")
    const narration =
      "The secret is it turns our words into numbers and learns from vast text.";
    const result = segmentNarrationIntoShots(narration, {
      maxWordsPerShot: 12,
      wordsPerMinute: 135,
      minDurationSeconds: 1.8,
    });

    // Instead of splitting 12 + 2 (where 2 words is ~0.88s), it merges the 2-word remainder
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedDurationSeconds).toBeGreaterThanOrEqual(1.8);
    expect(result[0]!.narrationText).toBe(narration);
  });
});

