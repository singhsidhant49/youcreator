import { z } from "zod";

import {
  ScriptOutlineSectionSchema,
  type ScriptOutlineSection,
} from "@youcreator/contracts";

import type { LLMGenerator } from "./script-generator.js";

const WrittenSectionSchema = z.object({
  narration: z.string().trim().min(1),
});

export interface SectionWritingContext {
  videoTitle: string;
  centralIdea: string;
  language: string;
  tone: string;
  audience: string;
  previousNarration?: string;
  nextSectionTitle?: string;
}

export interface WrittenSection {
  id: string;
  title: string;
  narration: string;
  targetWords: number;
  actualWords: number;
  model: string;
}

export class SectionWriter {
  constructor(
    private readonly llm: LLMGenerator,
  ) {}

  async write(
    sectionInput: ScriptOutlineSection,
    context: SectionWritingContext,
  ): Promise<WrittenSection> {
    const section =
      ScriptOutlineSectionSchema.parse(sectionInput);

    const prompt = `
You are an expert YouTube narration writer.

VIDEO TITLE: ${context.videoTitle}
CENTRAL IDEA: ${context.centralIdea}
LANGUAGE: ${context.language}
TONE: ${context.tone}
AUDIENCE: ${context.audience}

CURRENT SECTION:
Title: ${section.title}
Objective: ${section.objective}
Key points:
${section.keyPoints.map((p) => `- ${p}`).join("\n")}

TARGET WORDS: ${section.targetWords}

PREVIOUS NARRATION:
${context.previousNarration ?? "This is the first section."}

NEXT SECTION:
${context.nextSectionTitle ?? "This is the final section."}

Instructions:
- Write complete, natural spoken narration.
- Spell out all numbers, symbols, and abbreviations as full spoken English words (e.g. write 'one thousand' instead of '1,000', 'seven' instead of '7', 'percent' instead of '%') so word alignment matches voiceover pronunciation exactly.
- Develop the key points with sufficient depth.
- Use transitions that maintain narrative continuity.
- Avoid repeating previous narration.
- Avoid generic filler and robotic phrasing.
- Do not include image prompts or camera directions.
- Avoid inventing facts, statistics or quotations.
- Aim for the requested word count.
- Return only valid JSON.

JSON format:
{
  "narration": "Full spoken narration"
}
`;

    const response = await this.llm.generate(
      [
        {
          role: "system",
          content:
            "Write polished spoken narration. Return valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      {
        jsonMode: true,
        maxTokens: Math.max(
          1024,
          Math.ceil(section.targetWords * 2.5),
        ),
      },
    );

    let parsed: unknown;

    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new Error(
        "Section writer returned invalid JSON",
      );
    }

    const written = WrittenSectionSchema.parse(parsed);

    const actualWords = written.narration
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;

    return {
      id: section.id,
      title: section.title,
      narration: written.narration,
      targetWords: section.targetWords,
      actualWords,
      model: response.model,
    };
  }
}
