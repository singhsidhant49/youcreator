import { z } from "zod";

import type { LLMGenerator } from "./script-generator.js";
import { countNarrationWords } from "./script-quality.js";

const RevisedNarrationSchema = z.object({
  narration: z.string().trim().min(1),
});

export interface NarrationRevisionRequest {
  narration: string;
  targetWords: number;
  language: string;
  tone: string;
  context: string;
}

export interface NarrationRevisionResult {
  narration: string;
  originalWords: number;
  actualWords: number;
  targetWords: number;
  attempts: number;
  passed: boolean;
}

export interface NarrationReviserOptions {
  maxAttempts?: number;
  tolerance?: number;
}

export class NarrationReviser {
  constructor(
    private readonly llm: LLMGenerator,
    private readonly options: NarrationReviserOptions = {},
  ) {}

  async revise(
    request: NarrationRevisionRequest,
  ): Promise<NarrationRevisionResult> {
    const {
      narration,
      targetWords,
      language,
      tone,
      context,
    } = request;

    if (!narration.trim()) {
      throw new Error("Narration cannot be empty");
    }

    if (
      !Number.isInteger(targetWords) ||
      targetWords <= 0
    ) {
      throw new Error("Invalid target word count");
    }

    const maxAttempts = this.options.maxAttempts ?? 2;
    const tolerance = this.options.tolerance ?? 0.15;

    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 0 ||
      maxAttempts > 5 ||
      !Number.isFinite(tolerance) ||
      tolerance < 0 ||
      tolerance > 1
    ) {
      throw new Error("Invalid revision options");
    }

    const originalWords = countNarrationWords(narration);

    let current = narration;
    let attempts = 0;

    const withinTolerance = (words: number): boolean =>
      Math.abs(words - targetWords) / targetWords <= tolerance;

    while (
      !withinTolerance(countNarrationWords(current)) &&
      attempts < maxAttempts
    ) {
      attempts++;

      const currentWords = countNarrationWords(current);
      const direction =
        currentWords < targetWords ? "expand" : "shorten";

      const response = await this.llm.generate(
        [
          {
            role: "system",
            content:
              "You revise spoken YouTube narration. Return valid JSON only.",
          },
          {
            role: "user",
            content: `
Revise the following narration.

Goal: ${direction} the narration to ${targetWords} words (aim for at least ${targetWords} words if expanding).

Language: ${language}
Tone: ${tone}
Context: ${context}

Current word count: ${currentWords}

Original narration:
${current}

Requirements:
- Preserve the original meaning.
- Preserve relevant factual information.
- Improve clarity and natural spoken flow.
- Avoid repetition, filler and invented facts.
- Spell out all numbers, symbols, and abbreviations as full spoken English words.
- Do not add camera directions or image prompts.
- Do not introduce unsupported statistics.
- Return the entire revised narration.
- Return only JSON.

JSON structure:
{
  "narration": "Complete revised narration"
}
`,
          },
        ],
        {
          jsonMode: true,
          maxTokens: Math.min(
            4096,
            Math.max(512, Math.ceil(targetWords * 3)),
          ),
        },
      );

      let parsed: unknown;

      try {
        parsed = JSON.parse(response.text);
      } catch {
        throw new Error(
          "Narration reviser returned invalid JSON",
        );
      }

      const revised = RevisedNarrationSchema.parse(parsed);
      current = revised.narration;
    }

    const actualWords = countNarrationWords(current);

    return {
      narration: current,
      originalWords,
      actualWords,
      targetWords,
      attempts,
      passed: withinTolerance(actualWords),
    };
  }
}
