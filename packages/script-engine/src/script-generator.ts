import {
  VideoBriefSchema,
  VideoScriptSchema,
  type VideoBriefInput,
  type VideoScript,
} from "@youcreator/contracts";

import type {
  DeepSeekClient,
  LLMMessage,
  LLMResponse,
} from "@youcreator/llm";

import type {
  EditorialNarrativePlan,
} from "./editorial-narrative-plan.js";

export type LLMGenerator = Pick<DeepSeekClient, "generate">;

export interface ScriptGeneratorOptions {
  narrativePlan?: EditorialNarrativePlan;
}

export interface ScriptGenerationResult {
  script: VideoScript;
  usage?: LLMResponse["usage"];
  model: string;
  estimatedWords: number;
}

export class ScriptGenerator {
  constructor(
    private readonly llm: LLMGenerator,
    private readonly options: ScriptGeneratorOptions = {},
  ) {}

  async generate(
    input: VideoBriefInput,
    callOptions?: ScriptGeneratorOptions,
  ): Promise<ScriptGenerationResult> {
    const brief = VideoBriefSchema.parse(input);

    const narrativePlan: EditorialNarrativePlan | undefined =
      callOptions?.narrativePlan ??
      (input as any).narrativePlan ??
      this.options.narrativePlan;

    const targetWords = narrativePlan
      ? narrativePlan.targetWords
      : Math.round(
          (brief.durationSeconds / 60) * 135,
        );

    const narrativeGuidance = narrativePlan
      ? `
NARRATIVE BLUEPRINT (${narrativePlan.profile.toUpperCase()} PROFILE):
Follow this narrative blueprint:
${narrativePlan.beats
  .map(
    (b, idx) =>
      `Beat ${idx + 1} [${b.beat}] (~${Math.round(
        b.targetWordShare * narrativePlan.targetWords,
      )} words): ${b.objective}`,
  )
  .join("\n")}

Narrative Requirements:
- First 3-5 seconds (Hook): Create immediate curiosity with a surprising problem, puzzle, or central question. Never use generic openers like 'In this video...', 'Today we explore...', 'Welcome back...'.
- Narrative Progression: Every section must advance the narrative with meaningful new information and evidence. Avoid repeating phrases or restating the topic.
- Payoff: The conclusion (outro) must directly resolve the central question introduced in the opening hook, delivering a clear payoff and one memorable final thought.
- Visual Intent: Write vivid, concrete spoken narration that provides clear visual opportunities for video scenes.
- Factual Rigor: Reject unsupported numerical claims or fabricated quotations; require factual grounding for claims.
`
      : "";

    const systemPrompt = `
You are a professional YouTube documentary scriptwriter.

Write engaging, natural narration designed to be spoken aloud.
${narrativeGuidance}
Requirements:
- Create a compelling opening hook in the first 3-5 seconds that presents a surprising problem or central question.
- Avoid generic introductory phrasing ('In this video...', 'Welcome back...', 'Today we will discuss...').
- Organize the topic into logical sections where each section adds meaningful new information.
- Maintain narrative continuity without repetition or filler.
- Ensure the outro provides a clear payoff that resolves the central opening question.
- Use clear, conversational language.
- Spell out all numbers, symbols, and abbreviations as full spoken English words (e.g. write 'one thousand' instead of '1,000', 'seven' instead of '7', 'percent' instead of '%') so word alignment matches voiceover pronunciation exactly.
- Match the requested audience and tone.
- Do not include camera instructions or image prompts.
- Avoid unsupported factual claims, fabricated statistics, or unverified quotes.
- Target approximately ${targetWords} spoken words.
- Return ONLY valid JSON.
- Do not use markdown fences.

The JSON must follow this structure:

{
  "version": 1,
  "title": "Video title",
  "language": "Language code",
  "tone": "Narration tone",
  "hook": "Opening narration",
  "sections": [
    {
      "id": "section-001",
      "title": "Section title",
      "narration": "Full narration",
      "estimatedDurationSeconds": 60
    }
  ],
  "outro": "Closing narration"
}

The hook and outro are spoken narration, not summaries.
Do not repeat hook or outro text inside sections.
Section durations are estimates, not measured audio timings.
`;

    const userPrompt = `
Topic: ${brief.topic}
Target duration: ${brief.durationSeconds} seconds
Language: ${brief.language}
Tone: ${brief.tone}
Audience: ${brief.audience}

Additional instructions:
${brief.instructions ?? "None"}

Write the complete script.
`;

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ];

    const response = await this.llm.generate(messages, {
      jsonMode: true,
      maxTokens: Math.min(
        8192,
        Math.max(2048, Math.ceil(targetWords * 2.5)),
      ),
    });

    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(response.text);
    } catch {
      throw new Error(
        "Script generator received invalid JSON",
      );
    }

    const script = VideoScriptSchema.parse(parsedJson);

    const fullNarration = [
      script.hook,
      ...script.sections.map((section) => section.narration),
      script.outro,
    ].join(" ");

    const estimatedWords = fullNarration
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;

    return {
      script,
      model: response.model,
      usage: response.usage,
      estimatedWords,
    };
  }
}
