import { z } from "zod";

import {
  StoryboardSchema,
  VideoScriptSchema,
  VisualRequestSchema,
  type Storyboard,
  type VideoScript,
} from "@youcreator/contracts";

import type { LLMGenerator } from "./script-generator.js";

import {
  getScriptNarrationSegments,
  validateStoryboardCoverage,
} from "./storyboard-coverage.js";

import {
  segmentNarrationIntoShots,
} from "./narration-shot-segmenter.js";

export type StoryboardProfile =
  | "documentary"
  | "educational"
  | "meditation"
  | "audiobook";

export interface StoryboardPlannerOptions {
  profile?: StoryboardProfile;
  maxWordsPerShot?: number;
  wordsPerMinute?: number;
  minDurationSeconds?: number;
  maxTokensPerRequest?: number;
  autoRepairSlots?: boolean;
}

const NormalizedTransitionSchema = z.preprocess((val) => {
  if (typeof val === "string") {
    const s = val.toLowerCase().trim();
    if (s === "fade" || s === "dissolve" || s === "crossfade" || s === "cross_dissolve") {
      return "crossfade";
    }
    if (s === "clean_cut" || s === "cut") {
      return "cut";
    }
  }
  return "cut";
}, z.enum(["cut", "crossfade"]).default("cut"));

const NormalizedMotionSchema = z.preprocess((val) => {
  if (typeof val === "string") {
    const s = val.toLowerCase().trim();
    if (s.includes("out") || s === "pull_out" || s === "zoom_out" || s === "slow_zoom_out") {
      return "slow_zoom_out";
    }
    return "slow_zoom_in";
  }
  return "slow_zoom_in";
}, z.enum(["slow_zoom_in", "slow_zoom_out"]).default("slow_zoom_in"));

const NormalizedVisualRequestSchema = z.preprocess((val) => {
  if (val && typeof val === "object") {
    let copy = { ...val } as Record<string, unknown>;
    if (copy.optional && typeof copy.optional === "object") {
      const opt = copy.optional as Record<string, unknown>;
      delete copy.optional;
      copy = { ...opt, ...copy };
    }

    let description = typeof copy.description === "string" ? copy.description.trim() : "";
    if (description.length < 10) {
      description = `${description} in clear cinematic visual detail`.trim();
    }
    if (description.length < 10) {
      description = "Detailed visual depiction of narrative";
    }

    let searchQueries: string[] = [];
    if (Array.isArray(copy.searchQueries)) {
      searchQueries = copy.searchQueries
        .map((q) => (typeof q === "string" ? q.trim() : ""))
        .filter((q) => q.length >= 2);
    } else if (typeof copy.searchQueries === "string" && (copy.searchQueries as string).trim().length >= 2) {
      searchQueries = [(copy.searchQueries as string).trim()];
    }
    if (searchQueries.length === 0) {
      searchQueries = [description.slice(0, 30).trim() || "visual footage"];
    }
    if (searchQueries.length > 5) {
      searchQueries = searchQueries.slice(0, 5);
    }

    let negativeTerms: string[] = [];
    if (Array.isArray(copy.negativeTerms)) {
      negativeTerms = copy.negativeTerms
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter((t) => t.length >= 2);
    }

    let intent = "illustration";
    if (typeof copy.intent === "string") {
      const i = copy.intent.toLowerCase().trim();
      if (["establishing", "illustration", "demonstration", "character", "atmosphere", "transition"].includes(i)) {
        intent = i;
      }
    }

    let preferredMediaKind: "image" | "video" | "either" = "either";
    if (typeof copy.preferredMediaKind === "string") {
      const k = copy.preferredMediaKind.toLowerCase().trim();
      if (k === "image" || k === "either") {
        preferredMediaKind = k;
      } else if (k === "video") {
        preferredMediaKind = "either";
      }
    }

    const clean: Record<string, unknown> = {
      description,
      searchQueries,
      negativeTerms,
      intent,
      preferredMediaKind,
    };

    if (typeof copy.composition === "string" && copy.composition.trim().length > 0) {
      clean.composition = copy.composition.trim();
    }

    return clean;
  }
  return val;
}, VisualRequestSchema);

const LLMShotSchema = z.preprocess(
  (val) => {
    if (val && typeof val === "object") {
      const copy = { ...val } as Record<string, unknown>;
      delete copy.type;
      delete copy.shotId;
      delete copy.id;
      delete copy.duration;
      delete copy.estimatedDurationSeconds;
      if (copy.slot === undefined && copy.slotIndex !== undefined) {
        copy.slot = copy.slotIndex;
      }
      if (typeof copy.slot === "string") {
        copy.slot = parseInt(copy.slot, 10);
      }
      if (!("visualRequest" in copy) || !copy.visualRequest || typeof copy.visualRequest !== "object") {
        copy.visualRequest = {
          description: copy.description ?? copy.prompt ?? "Visual depiction",
          searchQueries: Array.isArray(copy.searchQueries) ? copy.searchQueries : [copy.searchQuery ?? copy.description ?? "visual footage"].filter(Boolean),
          intent: copy.intent ?? "illustration",
          preferredMediaKind: copy.preferredMediaKind ?? "either",
        };
      }
      const vr = copy.visualRequest;
      if (vr && typeof vr === "object") {
        const { motion, transition, ...cleanVR } =
          vr as Record<string, unknown>;
        return {
          ...copy,
          visualRequest: cleanVR,
          motion:
            copy.motion ??
            motion ??
            "slow_zoom_in",
          transition:
            copy.transition ??
            transition ??
            "cut",
        };
      }
      return copy;
    }
    return val;
  },
  z.object({
    slot: z.number().int().nonnegative(),
    visualRequest: NormalizedVisualRequestSchema,
    motion: NormalizedMotionSchema,
    transition: NormalizedTransitionSchema,
  }),
);

const LLMSceneSchema = z.object({
  purpose: z.string().trim().min(3),
  shots: z.array(LLMShotSchema).min(1),
});

const LLMSceneOrShotSchema = z.preprocess((val) => {
  if (val && typeof val === "object") {
    let copy = { ...val } as Record<string, unknown>;
    delete copy.type;
    if (typeof copy.scenePurpose === "string") {
      if (!copy.purpose) copy.purpose = copy.scenePurpose;
      delete copy.scenePurpose;
    }
    delete copy.scene;
    delete copy.sceneNumber;
    delete copy.sceneId;

    // Unwrap if wrapped under single key like { "scene_1": { ... } }
    const keys = Object.keys(copy);
    if (keys.length === 1 && copy[keys[0]] && typeof copy[keys[0]] === "object" && !Array.isArray(copy[keys[0]])) {
      const nested = copy[keys[0]] as Record<string, unknown>;
      if ("shots" in nested || "purpose" in nested || "slot" in nested) {
        copy = { ...nested };
      }
    }

    // If copy is already a scene with shots array
    if (Array.isArray(copy.shots)) {
      if (!copy.purpose || typeof copy.purpose !== "string" || (copy.purpose as string).trim().length < 3) {
        copy.purpose = (typeof copy.title === "string" && copy.title.trim().length >= 3)
          ? copy.title
          : (typeof copy.description === "string" && copy.description.trim().length >= 3)
            ? copy.description
            : (typeof copy.name === "string" && copy.name.trim().length >= 3)
              ? copy.name
              : "Visual narrative scene";
      }
      return copy;
    }

    // If copy has shots as a single object
    if (copy.shots && !Array.isArray(copy.shots) && typeof copy.shots === "object") {
      copy.shots = [copy.shots];
      if (!copy.purpose || typeof copy.purpose !== "string" || (copy.purpose as string).trim().length < 3) {
        copy.purpose = "Visual narrative scene";
      }
      return copy;
    }

    // If copy is a shot directly
    const hasSlot = "slot" in copy || "slotIndex" in copy || "shot" in copy || "shotIndex" in copy;
    const hasVisuals = "visualRequest" in copy || "description" in copy || "searchQueries" in copy || "intent" in copy || "prompt" in copy;

    if (hasSlot || hasVisuals) {
      const purpose = typeof copy.purpose === "string" && copy.purpose.trim().length >= 3
        ? copy.purpose
        : typeof copy.scenePurpose === "string" && copy.scenePurpose.trim().length >= 3
          ? copy.scenePurpose
          : "Visual scene";

      const rawSlot = copy.slot ?? copy.slotIndex ?? copy.shot ?? copy.shotIndex ?? 0;
      let slotVal = typeof rawSlot === "number" ? rawSlot : parseInt(String(rawSlot), 10);
      if (isNaN(slotVal)) slotVal = 0;

      let visualReq = copy.visualRequest;
      if (!visualReq || typeof visualReq !== "object") {
        visualReq = {
          description: copy.description ?? copy.prompt ?? "Visual depiction",
          searchQueries: Array.isArray(copy.searchQueries) ? copy.searchQueries : [copy.searchQuery ?? copy.description ?? "visual footage"].filter(Boolean),
          intent: copy.intent ?? "illustration",
          preferredMediaKind: copy.preferredMediaKind ?? "either",
        };
      }

      const shot = {
        slot: slotVal,
        visualRequest: visualReq,
        motion: copy.motion ?? "slow_zoom_in",
        transition: copy.transition ?? "cut",
      };

      return {
        purpose,
        shots: [shot],
      };
    }

    if (!copy.purpose || typeof copy.purpose !== "string" || (copy.purpose as string).trim().length < 3) {
      copy.purpose = "Visual scene";
    }
    if (!Array.isArray(copy.shots)) {
      copy.shots = [];
    }

    return copy;
  }
  return val;
}, LLMSceneSchema);

const LLMPlanSchema = z.preprocess(
  (val) => {
    if (val && typeof val === "object") {
      const rawScenes =
        "scenes" in val && Array.isArray((val as any).scenes)
          ? (val as any).scenes
          : Array.isArray(val)
            ? val
            : [];
      const flattenedScenes: any[] = [];
      function extractScenes(items: any[]) {
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          if ("scenes" in item && Array.isArray(item.scenes)) {
            extractScenes(item.scenes);
          } else if (Array.isArray(item.shots) || "shots" in item) {
            flattenedScenes.push(item);
          } else {
            const values = Object.values(item).filter(
              (v) => v && typeof v === "object" && ("shots" in (v as any) || "purpose" in (v as any))
            );
            if (values.length > 0) {
              extractScenes(values);
            } else {
              flattenedScenes.push(item);
            }
          }
        }
      }
      extractScenes(rawScenes);

      const validScenes = flattenedScenes.filter((s) => {
        if (!s || typeof s !== "object") return false;
        if (Array.isArray(s.shots) && s.shots.length > 0) return true;
        if (s.shots && typeof s.shots === "object") return true;
        if ("slot" in s || "slotIndex" in s || "shot" in s || "visualRequest" in s || "description" in s || "searchQueries" in s) return true;
        return false;
      });

      return { scenes: validScenes.length > 0 ? validScenes : flattenedScenes };
    }
    return val;
  },
  z.object({
    scenes: z.array(LLMSceneOrShotSchema).min(1),
  }),
);

const DEFAULT_SHOT_WORDS: Record<
  StoryboardProfile,
  number
> = {
  documentary: 12,
  educational: 16,
  meditation: 70,
  audiobook: 55,
};


function positiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}`);
  }
}

function getBeatVisualIntent(
  segmentId: string,
  segmentIndex: number,
  totalSegments: number,
  profile: StoryboardProfile,
): {
  beat: string;
  objective: string;
  visualIntent: string;
} {
  if (segmentId === "hook" || segmentIndex === 0) {
    return {
      beat: "hook",
      objective: "Introduce the central curiosity and present a surprising problem or question",
      visualIntent: "Establish the core question or problem visually within 3-5 seconds; engaging, high-curiosity subject framing",
    };
  }

  if (segmentId === "outro" || segmentIndex === totalSegments - 1) {
    return {
      beat: "payoff",
      objective: "Resolve the opening question and deliver a memorable final insight",
      visualIntent: "Clear visual payoff resolving the central question; definitive, lasting concluding imagery",
    };
  }

  const middleIndex = segmentIndex - 1;
  const middleCount = totalSegments - 2;

  if (middleIndex === 0) {
    return {
      beat: "setup",
      objective: "Establish why the topic matters and set the stakes",
      visualIntent: "Contextual framing, real-world relevance, setting, and stakes",
    };
  }

  if (middleIndex === middleCount - 1 && middleCount > 1) {
    return {
      beat: profile === "documentary" ? "escalation" : "development",
      objective: profile === "documentary" ? "Explain conflict and consequences" : "Deliver evidence, mechanisms, and progression",
      visualIntent: "High-impact visual evidence, pivotal decisions, or escalating wonder",
    };
  }

  return {
    beat: "development",
    objective: "Deliver evidence, explanations, and progression",
    visualIntent: "Concrete visual representation of mechanisms, processes, and progressive evidence",
  };
}

export class StoryboardPlanner {
  constructor(
    private readonly llm: LLMGenerator,
    private readonly options: StoryboardPlannerOptions = {},
  ) {}

  async plan(input: VideoScript): Promise<Storyboard> {
    const script = VideoScriptSchema.parse(input);

    const profile = this.options.profile ?? "documentary";

    const maxWordsPerShot =
      this.options.maxWordsPerShot ??
      DEFAULT_SHOT_WORDS[profile];

    const wordsPerMinute =
      this.options.wordsPerMinute ?? 135;

    const maxTokens =
      this.options.maxTokensPerRequest ?? 8192;

    positiveInteger(maxWordsPerShot, "maxWordsPerShot");
    positiveInteger(maxTokens, "maxTokensPerRequest");

    if (
      !Number.isFinite(wordsPerMinute) ||
      wordsPerMinute <= 0
    ) {
      throw new Error("Invalid wordsPerMinute");
    }

    const segments =
      getScriptNarrationSegments(script);

    const sections: Storyboard["sections"] = [];

    for (
      let segmentIndex = 0;
      segmentIndex < segments.length;
      segmentIndex++
    ) {
      const segment = segments[segmentIndex]!;

      const beatInfo = getBeatVisualIntent(
        segment.id,
        segmentIndex,
        segments.length,
        profile,
      );

      const slots = segmentNarrationIntoShots(
        segment.text,
        {
          maxWordsPerShot,
          wordsPerMinute,
          minDurationSeconds: this.options.minDurationSeconds,
        },
      );

function tryRepairTruncatedJson(str: string): unknown {
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{" || c === "[") {
      stack.push(c);
    } else if (c === "}" && stack[stack.length - 1] === "{") {
      stack.pop();
    } else if (c === "]" && stack[stack.length - 1] === "[") {
      stack.pop();
    }
  }
  let repaired = str;
  if (inString) repaired += '"';
  repaired = repaired.trimEnd().replace(/,\s*$/, "");
  while (stack.length > 0) {
    const top = stack.pop();
    repaired += top === "{" ? "}" : "]";
  }
  return JSON.parse(repaired);
}

function parseLlmJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      try {
        return JSON.parse(cleaned);
      } catch {
        // continue
      }
    }
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch {
        // continue
      }
    }
    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      try {
        return JSON.parse(cleaned.slice(firstBracket, lastBracket + 1));
      } catch {
        // continue
      }
    }
    try {
      return tryRepairTruncatedJson(cleaned);
    } catch {
      // continue
    }
    throw new Error("Invalid JSON");
  }
}

      let proposal: z.infer<typeof LLMPlanSchema> | undefined;

      for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await this.llm.generate(
          [
            {
              role: "system",
              content: [
                "You are a professional YouTube visual",
                "storyboard director.",
                "Return one valid JSON object only.",
                "Do not rewrite or invent narration.",
                "Design practical images or video footage.",
                "Avoid complex diagrams and UI animations.",
                "Every numbered shot slot must appear",
                "exactly once in its original order.",
              ].join(" "),
            },
            {
              role: "user",
              content: JSON.stringify({
                task: "Create a visual storyboard plan",
                title: script.title,
                profile,
                language: script.language,
                tone: script.tone,
                segmentId: segment.id,
                beat: beatInfo.beat,
                beatObjective: beatInfo.objective,
                visualIntent: beatInfo.visualIntent,
                slots: slots.map((slot) => ({
                  slot: slot.index,
                  narration: slot.narrationText,
                })),
                instructions: [
                  `Visual storytelling: Align shots with the narrative beat objective (${beatInfo.beat}: ${beatInfo.visualIntent}).`,
                  `CRITICAL REQUIREMENT: There are exactly ${slots.length} shot slots (indices ${slots.map((s) => s.index).join(", ")}). You must return exactly ${slots.length} shots across your scenes with slot numbers [${slots.map((s) => s.index).join(", ")}].`,
                  "Group adjacent shot slots into scenes.",
                  "Every shot MUST be inside a scene object's 'shots' array, never placed directly at top-level.",
                  "Use each slot exactly once in sequential order.",
                  "Give every scene a meaningful purpose.",
                  "For each slot provide visualRequest with:",
                  "- description: detailed visual description (at least 20 chars).",
                  "- searchQueries: array of 1-3 specific search phrases (at least 8 chars each).",
                  "- intent: exactly one of 'establishing' | 'illustration' | 'demonstration' | 'character' | 'atmosphere' | 'transition'.",
                  "- preferredMediaKind: exactly one of 'image' | 'video' | 'either'.",
                  "- motion: exactly one of 'slow_zoom_in' | 'slow_zoom_out' (only Zoom In and Zoom Out animations are allowed; no pans or static camera drift).",
                  "- transition: exactly one of 'cut' | 'crossfade' (only Clean Cut and Cross Dissolve / Crossfade transitions are permitted).",
                  "- negativeTerms: optional array of unwanted concepts.",
                  "- composition: optional camera framing description.",
                  "Be concise. Keep visual descriptions focused (1-2 sentences, max 30 words). Keep searchQueries to 2-3 concise terms.",
                  "Storytelling & Visual Flow (Mode B AI):",
                  "- Maintain consistent character appearance (face, costume, hair, age) and visual atmosphere across sequential shots.",
                  "- Compose with cinematic depth: prioritize shallow depth of field, creamy background bokeh, and sharp character focus.",
                  "- Alternate camera motions between 'slow_zoom_in' (to heighten emotion/focus) and 'slow_zoom_out' (to reveal surroundings/context).",
                  "- Use 'cut' for dynamic beat progression and 'crossfade' for smooth scene/temporal transitions.",
                  "All fields must be placed directly inside visualRequest (do not wrap in an 'optional' object).",
                  "Return JSON matching:",
                  {
                    scenes: [
                      {
                        purpose: "Visual narrative purpose",
                        shots: [
                          {
                            slot: 0,
                            visualRequest: {
                              description:
                                "Specific visual description",
                              searchQueries: [
                                "specific footage search phrase",
                              ],
                              intent: "illustration",
                              preferredMediaKind: "either",
                            },
                            motion: "slow_zoom_in",
                            transition: "cut",
                          },
                        ],
                      },
                    ],
                  },
                ],
              }),
            },
          ],
          {
            jsonMode: true,
            maxTokens,
          },
        );

        let parsed: unknown;
        try {
          parsed = parseLlmJson(response.text);
        } catch {
          if (attempt === 2) {
            throw new Error(
              `Storyboard LLM returned invalid JSON for ${segment.id}`,
            );
          }
          continue;
        }

        let candidateProposal: z.infer<typeof LLMPlanSchema>;
        try {
          candidateProposal = LLMPlanSchema.parse(parsed);
        } catch (schemaErr) {
          if (attempt === 2) {
            throw schemaErr;
          }
          continue;
        }

        const rawProposedIndices =
          candidateProposal.scenes.flatMap(
            (scene) =>
              scene.shots.map((shot) => shot.slot),
          );

        const allShots = candidateProposal.scenes.flatMap((s) => s.shots);

        if (this.options.autoRepairSlots && allShots.length > 0) {
          // If the LLM returned fewer shots than slots, append continuation shots to the last scene
          if (allShots.length < slots.length) {
            const lastScene = candidateProposal.scenes[candidateProposal.scenes.length - 1]!;
            const lastShot = allShots[allShots.length - 1]!;
            while (allShots.length < slots.length) {
              const nextSlot = allShots.length;
              const newShot = {
                ...lastShot,
                slot: nextSlot,
                visualRequest: {
                  ...lastShot.visualRequest,
                  description: `${lastShot.visualRequest.description} (continued view)`,
                },
                motion: lastShot.motion === "slow_zoom_in" ? ("slow_zoom_out" as const) : ("slow_zoom_in" as const),
                transition: "cut" as const,
              };
              lastScene.shots.push(newShot);
              allShots.push(newShot);
            }
          } else if (allShots.length > slots.length) {
            // If the LLM returned more shots than slots, trim excess shots from the end
            let count = 0;
            for (const scene of candidateProposal.scenes) {
              scene.shots = scene.shots.filter(() => {
                count++;
                return count <= slots.length;
              });
            }
          }

          // Always ensure sequential slot indexing [0, 1, ..., slots.length - 1]
          let globalSlot = 0;
          for (const scene of candidateProposal.scenes) {
            for (const shot of scene.shots) {
              shot.slot = globalSlot++;
            }
          }
        } else {
          // 1. If the LLM returned 1-based indices (1, 2, 3...), normalize to 0-based
          if (
            rawProposedIndices.length === slots.length &&
            rawProposedIndices.every((val, idx) => val === idx + 1)
          ) {
            for (const scene of candidateProposal.scenes) {
              for (const shot of scene.shots) {
                shot.slot -= 1;
              }
            }
          }

          // 2. If per-scene reset (e.g. multiple scenes where each scene restarted its shot numbering at 0)
          if (
            rawProposedIndices.length === slots.length &&
            candidateProposal.scenes.length > 1 &&
            candidateProposal.scenes.every(
              (scene) => scene.shots.length > 0 && scene.shots[0]!.slot === 0,
            ) &&
            !rawProposedIndices.every((val, idx) => val === idx)
          ) {
            let globalSlot = 0;
            for (const scene of candidateProposal.scenes) {
              for (const shot of scene.shots) {
                shot.slot = globalSlot++;
              }
            }
          }
        }

        const proposedIndices =
          candidateProposal.scenes.flatMap(
            (scene) =>
              scene.shots.map((shot) => shot.slot),
          );

        const expectedIndices =
          slots.map((slot) => slot.index);

        if (
          JSON.stringify(proposedIndices) !==
          JSON.stringify(expectedIndices)
        ) {
          throw new Error(
            `Storyboard shot slot mismatch for ${segment.id}`,
          );
        }

        proposal = candidateProposal;
        break;
      }



      if (!proposal) {
        throw new Error(
          `Storyboard LLM failed to produce valid plan for ${segment.id}`,
        );
      }

      sections.push({
        id: `sb-section-${segmentIndex + 1}`,
        scriptSegmentId: segment.id,
        title:
          segment.id === "hook"
            ? "Opening Hook"
            : segment.id === "outro"
              ? "Conclusion"
              : script.sections.find(
                  (section) => section.id === segment.id,
                )?.title ?? segment.id,

        scenes: proposal.scenes.map(
          (scene, sceneIndex) => ({
            id:
              `scene-${segmentIndex + 1}-${sceneIndex + 1}`,
            purpose: scene.purpose,

            shots: scene.shots.map((shot) => {
              const slot = slots[shot.slot]!;

              return {
                id:
                  `shot-${segmentIndex + 1}-${shot.slot + 1}`,

                // Always copied from the deterministic
                // slot, never from LLM output.
                narrationText: slot.narrationText,

                estimatedDurationSeconds:
                  slot.estimatedDurationSeconds,

                visualRequest: shot.visualRequest,
                motion: shot.motion,
                transition: shot.transition,
              };
            }),
          }),
        ),
      });
    }

    const storyboard = StoryboardSchema.parse({
      version: 1,
      scriptTitle: script.title,
      sections,
    });

    const coverage = validateStoryboardCoverage(
      script,
      storyboard,
    );

    if (!coverage.passed) {
      throw new Error(
        `Storyboard coverage failed: ${coverage.issues
          .map((issue) => issue.code)
          .join(", ")}`,
      );
    }

    return storyboard;
  }
}
