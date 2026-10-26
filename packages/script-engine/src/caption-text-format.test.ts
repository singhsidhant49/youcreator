import { describe, expect, it } from "vitest";

import {
  formatCaptionText,
  groupCaptionTokens,
} from "./caption-text-format.js";

describe("M10.2 caption punctuation", () => {
  it("attaches question marks", () => {
    expect(formatCaptionText([
      { text: "schedule" },
      { text: "?" },
    ])).toBe("schedule?");
  });

  it("attaches commas and periods", () => {
    expect(formatCaptionText([
      { text: "Hello" },
      { text: "," },
      { text: "world" },
      { text: "." },
    ])).toBe("Hello, world.");
  });

  it("attaches colons", () => {
    expect(formatCaptionText([
      { text: "The" },
      { text: "secret" },
      { text: ":" },
      { text: "patterns" },
    ])).toBe("The secret: patterns");
  });

  it("handles opening parentheses", () => {
    expect(formatCaptionText([
      { text: "AI" },
      { text: "(" },
      { text: "today" },
      { text: ")" },
    ])).toBe("AI (today)");
  });

  it("preserves original token identities", () => {
    const tokens = [
      { text: "Hello", index: 0 },
      { text: ",", index: 1 },
    ];

    const groups = groupCaptionTokens(tokens);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.text).toBe("Hello,");
    expect(groups[0]!.tokens[0]).toBe(tokens[0]);
    expect(groups[0]!.tokens[1]).toBe(tokens[1]);
  });

  it("handles empty tokens", () => {
    expect(formatCaptionText([
      { text: "" },
      { text: "Hello" },
      { text: " " },
      { text: "!" },
    ])).toBe("Hello!");
  });
});
