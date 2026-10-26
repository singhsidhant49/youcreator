import { describe, expect, it } from "vitest";
import { VideoScriptSchema } from "./script.js";

const validScript = {
  version: 1,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "educational",
  hook: "Why do we delay important tasks?",
  sections: [
    {
      id: "section-001",
      title: "The Psychology",
      narration:
        "Procrastination is often connected to emotional regulation.",
      estimatedDurationSeconds: 20,
    },
  ],
  outro: "Understanding the cause is the first step.",
};

describe("VideoScriptSchema", () => {
  it("accepts a valid script", () => {
    expect(
      VideoScriptSchema.safeParse(validScript).success,
    ).toBe(true);
  });

  it("rejects scripts without sections", () => {
    expect(
      VideoScriptSchema.safeParse({
        ...validScript,
        sections: [],
      }).success,
    ).toBe(false);
  });

  it("rejects empty narration", () => {
    expect(
      VideoScriptSchema.safeParse({
        ...validScript,
        sections: [
          {
            ...validScript.sections[0],
            narration: "",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects negative estimated durations", () => {
    expect(
      VideoScriptSchema.safeParse({
        ...validScript,
        sections: [
          {
            ...validScript.sections[0],
            estimatedDurationSeconds: -5,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
