import { z } from "zod";

import {
  ScriptOutlineSchema,
  VideoBriefSchema,
  VideoScriptSchema,
  type ScriptOutline,
  type VideoBrief,
  type VideoBriefInput,
  type VideoScript,
} from "@youcreator/contracts";

import { OutlinePlanner } from "./outline-planner.js";
import {
  SectionWriter,
  type SectionWritingContext,
} from "./section-writer.js";
import {
  analyzeScript,
  type ScriptQualityReport,
} from "./script-quality.js";
import { NarrationReviser } from "./narration-reviser.js";
import {
  ScriptPartCache,
  scriptPartHash,
} from "./script-part-cache.js";
import { getOrGenerateNarration } from "./cached-narration.js";
import {
  evaluateEditorialQuality,
  type EditorialQualityOptions,
  type EditorialQualityReport,
} from "./editorial-quality.js";

import type { LLMGenerator } from "./script-generator.js";
import type {
  EditorialNarrativePlan,
} from "./editorial-narrative-plan.js";

const NarrationSchema = z.object({
  narration: z.string().trim().min(1),
});

export interface SectionRevisionRecord {
  sectionId: string;
  originalWords: number;
  revisedWords: number;
  accepted: boolean;
}

export interface AssembledScriptResult {
  script: VideoScript;
  targetWords: number;
  actualWords: number;
  estimatedDurationSeconds: number;
  sectionsGenerated: number;
  quality: ScriptQualityReport;
  revisionCalls: number;
  revisions: SectionRevisionRecord[];
  cacheHits: number;
  cacheMisses: number;
  editorialQuality?: EditorialQualityReport;
}

export interface ScriptAssemblerOptions {
  enforceQuality?: boolean;
  minWordRatio?: number;
  maxWordRatio?: number;

  reviseSections?: boolean;
  maxRevisionCalls?: number;
  revisionTolerance?: number;

  cache?: ScriptPartCache;
  cacheModelKey?: string;

  editorial?: {
    enabled?: boolean;
    requireExample?: boolean;
    minimumSectionWords?: number;
  };

  narrativePlan?: EditorialNarrativePlan;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export class ScriptAssembler {
  private readonly planner: OutlinePlanner;
  private readonly writer: SectionWriter;
  private readonly reviser: NarrationReviser;

  constructor(
    private readonly llm: LLMGenerator,
    private readonly options: ScriptAssemblerOptions = {},
  ) {
    this.planner = new OutlinePlanner(llm, {
      narrativePlan: options.narrativePlan,
      tolerance: options.revisionTolerance ?? 0.15,
    });
    this.writer = new SectionWriter(llm);

    this.reviser = new NarrationReviser(llm, {
      maxAttempts: 1,
      tolerance: options.revisionTolerance ?? 0.15,
    });
  }

  private async getOutline(
    brief: VideoBrief,
    narrativePlan?: EditorialNarrativePlan,
  ): Promise<{
    outline: ScriptOutline;
    totalTargetWords: number;
  }> {
    const cache = this.options.cache;

    const totalTargetWords = narrativePlan
      ? narrativePlan.targetWords
      : Math.round(
          (brief.durationSeconds / 60) * 135,
        );

    if (!cache) {
      return this.planner.plan(brief, { narrativePlan });
    }

    if (!this.options.cacheModelKey?.trim()) {
      throw new Error(
        "cacheModelKey is required when script caching is enabled",
      );
    }

    const hash = scriptPartHash({
      kind: "outline",
      id: "main",
      promptVersion: "outline-v1",
      model: this.options.cacheModelKey,
      context: narrativePlan
        ? {
            brief,
            narrativePlan: {
              version: narrativePlan.version,
              planHash: narrativePlan.planHash,
              profile: narrativePlan.profile,
            },
          }
        : brief,
    });

    const cached = await cache.load(hash);

    if (cached !== null) {
      try {
        const outline = ScriptOutlineSchema.parse(
          JSON.parse(cached),
        );

        const allocatedWords =
          outline.hookTargetWords +
          outline.outroTargetWords +
          outline.sections.reduce(
            (sum, section) => sum + section.targetWords,
            0,
          );

        if (
          Math.abs(allocatedWords - totalTargetWords) /
            totalTargetWords <=
          0.15
        ) {
          return { outline, totalTargetWords };
        }
      } catch {
        // Invalid cached outlines are regenerated.
      }
    }

    const planned = await this.planner.plan(brief, { narrativePlan });

    await cache.save(
      hash,
      JSON.stringify(planned.outline),
    );

    return planned;
  }

  private async generateSection(
    section: ScriptOutline["sections"][number],
    context: SectionWritingContext,
    remainingRevisionCalls: number,
  ): Promise<{
    narration: string;
    revisionCalls: number;
    revision?: SectionRevisionRecord;
  }> {
    const written = await this.writer.write(section, context);

    let narration = written.narration;
    let revisionCalls = 0;
    let revision: SectionRevisionRecord | undefined;

    const tolerance = this.options.revisionTolerance ?? 0.15;

    if (
      this.options.reviseSections &&
      remainingRevisionCalls > 0 &&
      Math.abs(written.actualWords - section.targetWords) /
        section.targetWords > tolerance
    ) {
      const result = await this.reviser.revise({
        narration,
        targetWords: section.targetWords,
        language: context.language,
        tone: context.tone,
        context: [
          `Video: ${context.videoTitle}`,
          `Section: ${section.title}`,
          `Objective: ${section.objective}`,
          `Central idea: ${context.centralIdea}`,
        ].join("\n"),
      });

      revisionCalls = result.attempts;

      const accepted =
        result.passed &&
        Math.abs(result.actualWords - section.targetWords) <
          Math.abs(written.actualWords - section.targetWords);

      if (accepted) {
        narration = result.narration;
      }

      revision = {
        sectionId: section.id,
        originalWords: written.actualWords,
        revisedWords: result.actualWords,
        accepted,
      };
    }

    return {
      narration,
      revisionCalls,
      revision,
    };
  }

  private async writeNarration(
    label: string,
    instructions: string,
    targetWords: number,
  ): Promise<string> {
    const response = await this.llm.generate(
      [
        {
          role: "system",
          content:
            "Write natural spoken YouTube narration. Return only valid JSON.",
        },
        {
          role: "user",
          content: `
Write the ${label} of a YouTube video.

Instructions:
${instructions}

Target words: ${targetWords}

Return JSON:
{"narration":"Complete spoken narration"}

Do not include visual descriptions.
Do not invent facts or statistics.
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

    let json: unknown;

    try {
      json = JSON.parse(response.text);
    } catch {
      throw new Error(`${label} returned invalid JSON`);
    }

    return NarrationSchema.parse(json).narration;
  }

  async assemble(
    input: VideoBriefInput,
    callOptions?: { narrativePlan?: EditorialNarrativePlan },
  ): Promise<AssembledScriptResult> {
    const brief = VideoBriefSchema.parse(input);

    const narrativePlan: EditorialNarrativePlan | undefined =
      callOptions?.narrativePlan ??
      (input as any).narrativePlan ??
      this.options.narrativePlan;

    // Stage 1: Create the outline.
    const planned = await this.getOutline(brief, narrativePlan);
    const outline = planned.outline;

    let cacheHits = 0;
    let cacheMisses = 0;

    const cache = this.options.cache;
    const modelKey = this.options.cacheModelKey ?? "uncached";

    const cachedNarration = async (
      input: Parameters<typeof getOrGenerateNarration>[1],
      generate: () => Promise<string>,
    ): Promise<string> => {
      const result = await getOrGenerateNarration(
        cache,
        input,
        generate,
      );

      if (result.cacheHit) {
        cacheHits++;
      } else {
        cacheMisses++;
      }

      return result.narration;
    };

    // Stage 2: Write the opening hook.
    const hook = await cachedNarration(
      {
        kind: "hook",
        id: "opening",
        promptVersion: "hook-v1",
        model: modelKey,
        context: {
          brief,
          outline,
          targetWords: outline.hookTargetWords,
        },
      },
      () =>
        this.writeNarration(
          "opening hook",
          `
Video: ${outline.title}
Central idea: ${outline.centralIdea}
Hook plan: ${outline.hookPlan}
${narrativePlan ? `Narrative beat: hook (${narrativePlan.beats.find((b) => b.beat === "hook")?.objective ?? "Introduce the central curiosity"})` : ""}
Language: ${brief.language}
Tone: ${brief.tone}
Audience: ${brief.audience}
Additional instructions: ${brief.instructions ?? "None"}
Hook guidance: Open with a surprising problem, central question, or immediate curiosity within the first 3-5 seconds. Avoid generic openers ('In this video', 'Welcome back').
`,
          outline.hookTargetWords,
        ),
    );

    // Stage 3: Write sections sequentially.
    const maxRevisionCalls =
      this.options.maxRevisionCalls ?? 3;

    if (
      !Number.isInteger(maxRevisionCalls) ||
      maxRevisionCalls < 0 ||
      maxRevisionCalls > 20
    ) {
      throw new Error("Invalid revision call budget");
    }

    let revisionCalls = 0;

    const revisions: SectionRevisionRecord[] = [];

    const sections: VideoScript["sections"] = [];

    let previousNarration = hook;

    for (let i = 0; i < outline.sections.length; i++) {
      const current = outline.sections[i];
      const next = outline.sections[i + 1];

      const sectionContext: SectionWritingContext = {
        videoTitle: outline.title,
        centralIdea: outline.centralIdea,
        language: brief.language,
        tone: brief.tone,
        audience: brief.audience,
        previousNarration: previousNarration.slice(-2000),
        nextSectionTitle: next?.title,
      };

      const sectionResult = await getOrGenerateNarration(
        cache,
        {
          kind: "section",
          id: current.id,
          promptVersion: "section-v2",
          model: modelKey,
          context: {
            brief,
            outline,
            section: current,
            sectionContext,
            reviseSections: this.options.reviseSections ?? false,
            revisionTolerance:
              this.options.revisionTolerance ?? 0.15,
            remainingRevisionCalls:
              maxRevisionCalls - revisionCalls,
          },
        },
        async () => {
          const generated = await this.generateSection(
            current,
            sectionContext,
            maxRevisionCalls - revisionCalls,
          );

          revisionCalls += generated.revisionCalls;

          if (generated.revision) {
            revisions.push(generated.revision);
          }

          return generated.narration;
        },
      );

      if (sectionResult.cacheHit) {
        cacheHits++;
      } else {
        cacheMisses++;
      }

      const finalNarration = sectionResult.narration;
      const finalWords = countWords(finalNarration);

      sections.push({
        id: current.id,
        title: current.title,
        narration: finalNarration,
        estimatedDurationSeconds: (finalWords / 135) * 60,
      });

      previousNarration = finalNarration;
    }

    // Stage 4: Write the conclusion.
    const outro = await cachedNarration(
      {
        kind: "outro",
        id: "closing",
        promptVersion: "outro-v1",
        model: modelKey,
        context: {
          brief,
          outline,
          previousNarration: previousNarration.slice(-2000),
          targetWords: outline.outroTargetWords,
        },
      },
      () =>
        this.writeNarration(
          "outro",
          `
Video: ${outline.title}
Central idea: ${outline.centralIdea}
Conclusion plan: ${outline.outroPlan}
${narrativePlan ? `Narrative beat: payoff/closing (${narrativePlan.beats.find((b) => b.beat === "payoff" || b.beat === "closing")?.objective ?? "Resolve the opening question"})` : ""}
Language: ${brief.language}
Tone: ${brief.tone}
Previous section: ${previousNarration.slice(-2000)}
Guidance: Directly resolve the central question or problem presented in the opening hook, providing a clear payoff and memorable final thought. Avoid generic conclusions.
Avoid repeating earlier sentences.
`,
          outline.outroTargetWords,
        ),
    );

    // Stage 5: Assemble the canonical script.
    let script = VideoScriptSchema.parse({
      version: 1,
      title: outline.title,
      language: brief.language,
      tone: brief.tone,
      hook,
      sections,
      outro,
    });

    let fullNarration = [
      script.hook,
      ...script.sections.map((s) => s.narration),
      script.outro,
    ].join("\n\n");

    let actualWords = countWords(fullNarration);

    const totalTolerance = this.options.revisionTolerance ?? 0.15;
    const totalTargetWords = planned.totalTargetWords;

    if (this.options.reviseSections && sections.length > 0) {
      let currentDeviation =
        Math.abs(actualWords - totalTargetWords) / totalTargetWords;

      while (
        currentDeviation > totalTolerance &&
        revisionCalls < maxRevisionCalls
      ) {
        let candidateIndex = 0;
        if (actualWords < totalTargetWords) {
          let maxDeficit = -Infinity;
          for (let i = 0; i < sections.length; i++) {
            const sec = sections[i]!;
            const target = outline.sections[i]?.targetWords ?? 0;
            const currentCount = countWords(sec.narration);
            const deficit = target - currentCount;
            if (deficit > maxDeficit) {
              maxDeficit = deficit;
              candidateIndex = i;
            }
          }
        } else {
          let maxSurplus = -Infinity;
          for (let i = 0; i < sections.length; i++) {
            const sec = sections[i]!;
            const target = outline.sections[i]?.targetWords ?? 0;
            const currentCount = countWords(sec.narration);
            const surplus = currentCount - target;
            if (surplus > maxSurplus) {
              maxSurplus = surplus;
              candidateIndex = i;
            }
          }
        }

        const chosenSection = sections[candidateIndex]!;
        const currentSectionWords = countWords(chosenSection.narration);
        const wordDelta = totalTargetWords - actualWords;
        const targetSectionWords = Math.max(
          20,
          currentSectionWords + wordDelta,
        );

        if (targetSectionWords === currentSectionWords) {
          break;
        }

        const sectionMeta = outline.sections[candidateIndex];
        const result = await this.reviser.revise({
          narration: chosenSection.narration,
          targetWords: targetSectionWords,
          language: brief.language,
          tone: brief.tone,
          context: [
            `Video: ${outline.title}`,
            `Section: ${chosenSection.title}`,
            `Objective: ${sectionMeta?.objective ?? ""}`,
            `Central idea: ${outline.centralIdea}`,
          ].join("\n"),
        });

        revisionCalls += result.attempts;

        const improved =
          Math.abs(result.actualWords - targetSectionWords) <
          Math.abs(currentSectionWords - targetSectionWords);

        if (improved) {
          sections[candidateIndex] = {
            ...chosenSection,
            narration: result.narration,
            estimatedDurationSeconds: (result.actualWords / 135) * 60,
          };
          revisions.push({
            sectionId: chosenSection.id,
            originalWords: currentSectionWords,
            revisedWords: result.actualWords,
            accepted: true,
          });

          script = VideoScriptSchema.parse({
            version: 1,
            title: outline.title,
            language: brief.language,
            tone: brief.tone,
            hook,
            sections,
            outro,
          });

          fullNarration = [
            script.hook,
            ...script.sections.map((s) => s.narration),
            script.outro,
          ].join("\n\n");

          actualWords = countWords(fullNarration);
          currentDeviation =
            Math.abs(actualWords - totalTargetWords) / totalTargetWords;
        } else {
          revisions.push({
            sectionId: chosenSection.id,
            originalWords: currentSectionWords,
            revisedWords: result.actualWords,
            accepted: false,
          });
          break;
        }
      }
    }

    const quality = analyzeScript(
      script,
      brief.durationSeconds,
      {
        minWordRatio: this.options.minWordRatio,
        maxWordRatio: this.options.maxWordRatio,
      },
    );

    let editorialQuality: EditorialQualityReport | undefined;

    if (this.options.editorial?.enabled) {
      const editorialOptions: EditorialQualityOptions = {
        requireExample:
          this.options.editorial.requireExample ?? false,

        minimumSectionWords:
          this.options.editorial.minimumSectionWords ?? 35,
      };

      editorialQuality = evaluateEditorialQuality(
        script,
        editorialOptions,
      );
    }

    if (this.options.enforceQuality && !quality.passed) {
      const errors = quality.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.code}: ${issue.message}`);

      throw new Error(
        `Script quality validation failed: ${errors.join("; ")}`,
      );
    }

    return {
      script,
      targetWords: planned.totalTargetWords,
      actualWords,
      estimatedDurationSeconds:
        (actualWords / 135) * 60,
      sectionsGenerated: sections.length,
      quality,
      revisionCalls,
      revisions,
      cacheHits,
      cacheMisses,
      editorialQuality,
    };
  }
}
