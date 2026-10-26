import {
  VideoBriefSchema,
  ScriptOutlineSchema,
  type VideoBriefInput,
  type ScriptOutline,
} from "@youcreator/contracts";

import type {
  LLMGenerator,
} from "./script-generator.js";

import type {
  EditorialNarrativePlan,
} from "./editorial-narrative-plan.js";

export interface OutlinePlanningResult {
  outline: ScriptOutline;
  model: string;
  totalTargetWords: number;
}

export interface OutlinePlannerOptions {
  tolerance?: number;
  narrativePlan?: EditorialNarrativePlan;
}

export class OutlinePlanner {
  constructor(
    private readonly llm: LLMGenerator,
    private readonly options: OutlinePlannerOptions = {},
  ) {}

  async plan(
    input: VideoBriefInput,
    callOptions?: { narrativePlan?: EditorialNarrativePlan },
  ): Promise<OutlinePlanningResult> {
    const brief = VideoBriefSchema.parse(input);

    const narrativePlan: EditorialNarrativePlan | undefined =
      callOptions?.narrativePlan ??
      (input as any).narrativePlan ??
      this.options.narrativePlan;

    const totalTargetWords = narrativePlan
      ? narrativePlan.targetWords
      : Math.round(
          (brief.durationSeconds / 60) * 135,
        );

    const narrativeBlueprintPrompt = narrativePlan
      ? `
NARRATIVE BLUEPRINT (${narrativePlan.profile.toUpperCase()} PROFILE):
Version: ${narrativePlan.version}
Plan Hash: ${narrativePlan.planHash}
Target Words: ${narrativePlan.targetWords}
Beats:
${narrativePlan.beats
  .map(
    (beat, i) =>
      `Beat ${i + 1} [${beat.beat}] (~${Math.round(
        beat.targetWordShare * narrativePlan.targetWords,
      )} words, ${Math.round(beat.targetWordShare * 100)}% share):
- Objective: ${beat.objective}`,
  )
  .join("\n")}

Narrative Requirements:
- Hook (0-3s): Present a surprising problem or central question that sparks curiosity without generic filler ('In this video...', 'Today we will...').
- Progression: Every section must add meaningful new information and evidence; do not restate the topic or repeat earlier sentences.
- Payoff: The hookPlan must establish the central question, and the outroPlan must explicitly resolve that opening question.
- Visual Storytelling: Objectives must establish meaningful visual direction and scene opportunities.
- Factual Accuracy: Reject unsupported numerical claims or fabricated quotations; require source evidence for factual claims.
`
      : "";

    const hookExampleWords = Math.max(12, Math.round(totalTargetWords * 0.12));
    const outroExampleWords = Math.max(12, Math.round(totalTargetWords * 0.12));
    const sectionExampleWords = Math.max(25, totalTargetWords - hookExampleWords - outroExampleWords);

    const prompt = `
You are a professional YouTube video content planner.

Create an engaging, coherent narration outline.

TOPIC: ${brief.topic}
DURATION: ${brief.durationSeconds} seconds
LANGUAGE: ${brief.language}
TONE: ${brief.tone}
AUDIENCE: ${brief.audience}
ADDITIONAL INSTRUCTIONS:
${brief.instructions ?? "None"}

TARGET SPOKEN WORDS: ${totalTargetWords}
${narrativeBlueprintPrompt}
Requirements:
- Create a compelling opening hook plan that introduces a central curiosity or question within the first 3-5 seconds.
- Develop a logical sequence of sections where every section adds meaningful new information.
- Give every section a clear objective with concrete visual intent.
- Include specific key points without filler or repetition.
- Avoid repetitive sections or restating the topic.
- Maintain narrative continuity.
- Allocate realistic word budgets that sum to ${totalTargetWords} words.
- Include a satisfying payoff in the outro that resolves the opening question.
- Do not write the complete narration yet.
- Do not include scene descriptions or image prompts.
- Avoid unsupported facts, fabricated statistics, or unverified quotes.
- Return only valid JSON.

Return exactly this JSON structure:

{
  "version": 1,
  "title": "Title",
  "centralIdea": "Main message",
  "hookPlan": "What the opening should communicate",
  "hookTargetWords": ${hookExampleWords},
  "sections": [
    {
      "id": "section-001",
      "title": "Section title",
      "objective": "Purpose of this section",
      "keyPoints": ["Point 1", "Point 2"],
      "targetWords": ${sectionExampleWords}
    }
  ],
  "outroPlan": "How the video should conclude",
  "outroTargetWords": ${outroExampleWords}
}

CRITICAL: The sum of hookTargetWords, all section targetWords,
and outroTargetWords MUST equal approximately ${totalTargetWords} words.
`;

    const response = await this.llm.generate(
      [
        {
          role: "system",
          content:
            "You plan structured YouTube narration. Return valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      {
        jsonMode: true,
        maxTokens: 4096,
      },
    );

    let json: unknown;

    try {
      json = JSON.parse(response.text);
    } catch {
      throw new Error(
        "Outline planner returned invalid JSON",
      );
    }

    const outline = ScriptOutlineSchema.parse(json);

    const allocatedWords =
      outline.hookTargetWords +
      outline.outroTargetWords +
      outline.sections.reduce(
        (sum, section) => sum + section.targetWords,
        0,
      );

    const deviation =
      Math.abs(allocatedWords - totalTargetWords) /
      totalTargetWords;

    const maxDeviation = this.options.tolerance ?? 0.25;

    if (deviation > maxDeviation) {
      throw new Error(
        `Outline word budget deviates by ${Math.round(
          deviation * 100,
        )}% from target`,
      );
    }

    // Proportionally normalize section target words to match totalTargetWords
    if (allocatedWords !== totalTargetWords && outline.sections.length > 0) {
      const remainingForSections = Math.max(
        outline.sections.length * 15,
        totalTargetWords - outline.hookTargetWords - outline.outroTargetWords,
      );
      const currentSectionSum = outline.sections.reduce(
        (sum, s) => sum + s.targetWords,
        0,
      );
      if (currentSectionSum > 0) {
        let runningAllocated = 0;
        for (let i = 0; i < outline.sections.length; i++) {
          if (i === outline.sections.length - 1) {
            outline.sections[i].targetWords = Math.max(
              15,
              remainingForSections - runningAllocated,
            );
          } else {
            const scaled = Math.max(
              15,
              Math.round(
                (outline.sections[i].targetWords / currentSectionSum) *
                  remainingForSections,
              ),
            );
            outline.sections[i].targetWords = scaled;
            runningAllocated += scaled;
          }
        }
      }
    }

    return {
      outline,
      model: response.model,
      totalTargetWords,
    };
  }
}
