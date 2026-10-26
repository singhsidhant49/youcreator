import { createHash } from "node:crypto";
import { z } from "zod";

const BeatSchema = z.enum([
  "hook",
  "setup",
  "development",
  "escalation",
  "payoff",
  "closing",
]);

export const NarrativeProfileSchema = z.enum([
  "explainer",
  "documentary",
  "story",
]);

export const NarrativeBeatSchema = z.object({
  beat: BeatSchema,
  objective: z.string().min(1),
  targetWordShare: z.number().positive().max(1),
}).strict();

export const EditorialNarrativePlanSchema = z.object({
  version: z.literal(1),
  topic: z.string().trim().min(1),
  profile: NarrativeProfileSchema,
  targetDurationSeconds: z.number().positive(),
  targetWords: z.number().int().positive(),
  beats: z.array(NarrativeBeatSchema).min(3),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type EditorialNarrativePlan =
  z.infer<typeof EditorialNarrativePlanSchema>;

export type NarrativeProfile =
  z.infer<typeof NarrativeProfileSchema>;

export type NarrativeBeat =
  z.infer<typeof NarrativeBeatSchema>;

const STRUCTURES: Record<
  NarrativeProfile,
  Array<{
    beat: z.infer<typeof BeatSchema>;
    objective: string;
    targetWordShare: number;
  }>
> = {
  explainer: [
    {
      beat: "hook",
      objective: "Introduce the central curiosity",
      targetWordShare: 0.07,
    },
    {
      beat: "setup",
      objective: "Explain why the topic matters",
      targetWordShare: 0.16,
    },
    {
      beat: "development",
      objective: "Explain the underlying mechanism",
      targetWordShare: 0.47,
    },
    {
      beat: "payoff",
      objective: "Resolve the opening question",
      targetWordShare: 0.22,
    },
    {
      beat: "closing",
      objective: "Leave one memorable insight",
      targetWordShare: 0.08,
    },
  ],
  documentary: [
    {
      beat: "hook",
      objective: "Open with a consequential event",
      targetWordShare: 0.08,
    },
    {
      beat: "setup",
      objective: "Establish the historical context",
      targetWordShare: 0.18,
    },
    {
      beat: "development",
      objective: "Describe pivotal decisions",
      targetWordShare: 0.30,
    },
    {
      beat: "escalation",
      objective: "Explain conflict and consequences",
      targetWordShare: 0.24,
    },
    {
      beat: "payoff",
      objective: "Explain the outcome and its impact",
      targetWordShare: 0.15,
    },
    {
      beat: "closing",
      objective: "Conclude with a specific implication",
      targetWordShare: 0.05,
    },
  ],
  story: [
    {
      beat: "hook",
      objective: "Immerse the viewer in a scene",
      targetWordShare: 0.08,
    },
    {
      beat: "setup",
      objective: "Establish the setting and stakes",
      targetWordShare: 0.17,
    },
    {
      beat: "development",
      objective: "Advance the journey or discovery",
      targetWordShare: 0.31,
    },
    {
      beat: "escalation",
      objective: "Increase wonder or uncertainty",
      targetWordShare: 0.24,
    },
    {
      beat: "payoff",
      objective: "Deliver the central discovery",
      targetWordShare: 0.15,
    },
    {
      beat: "closing",
      objective: "Leave an evocative final image",
      targetWordShare: 0.05,
    },
  ],
};

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function createEditorialNarrativePlan(input: {
  topic: string;
  profile: NarrativeProfile;
  targetDurationSeconds: number;
  wordsPerMinute?: number;
}): EditorialNarrativePlan {
  const topic = z.string()
    .trim()
    .min(1)
    .parse(input.topic);

  const profile =
    NarrativeProfileSchema.parse(input.profile);

  const seconds = z.number()
    .positive()
    .parse(input.targetDurationSeconds);

  const wpm = z.number()
    .min(80)
    .max(240)
    .parse(input.wordsPerMinute ?? 135);

  const targetWords = Math.max(
    1,
    Math.round(seconds / 60 * wpm),
  );

  const payload = {
    version: 1 as const,
    topic,
    profile,
    targetDurationSeconds: seconds,
    targetWords,
    beats: STRUCTURES[profile].map(
      (beat) => ({ ...beat }),
    ),
  };

  return EditorialNarrativePlanSchema.parse({
    ...payload,
    planHash: hash(payload),
  });
}

export function verifyEditorialNarrativePlan(
  candidate: unknown,
  input: Parameters<
    typeof createEditorialNarrativePlan
  >[0],
): EditorialNarrativePlan {
  const saved =
    EditorialNarrativePlanSchema.parse(candidate);

  const expected =
    createEditorialNarrativePlan(input);

  if (
    JSON.stringify(saved) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      "M10.5 narrative plan identity mismatch",
    );
  }

  return saved;
}
