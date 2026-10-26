import { createHash } from "node:crypto";
import { z } from "zod";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Frame = z.number().int().safe().nonnegative();

export const EditorialProfileSchema = z.enum([
  "explainer",
  "documentary",
  "story",
]);

export const EditorialShotSchema = z.object({
  shotId: z.string().min(1),
  assetSha256: Hash,
  startFrame: Frame,
  endFrameExclusive: Frame,
}).strict();

export const EditorialMotionShotSchema = z.object({
  shotId: z.string().min(1),
  assetSha256: Hash,
  startFrame: Frame,
  endFrameExclusive: Frame,
  movement: z.enum([
    "static",
    "push_in",
    "pull_out",
    "pan_left",
    "pan_right",
  ]),
  startScale: z.number().min(1).max(1.15),
  endScale: z.number().min(1).max(1.15),
  startX: z.number().min(-1).max(1),
  endX: z.number().min(-1).max(1),
  easing: z.literal("ease_in_out"),
}).strict();

export const EditorialBoundarySchema = z.object({
  fromShotId: z.string().min(1),
  toShotId: z.string().min(1),
  type: z.enum(["cut", "crossfade"]),
  durationFrames: Frame,
}).strict();

export const EditorialMotionPlanSchema = z.object({
  version: z.literal(1),
  profile: EditorialProfileSchema,
  fps: z.number().int().positive(),
  shots: z.array(EditorialMotionShotSchema),
  boundaries: z.array(EditorialBoundarySchema),
  planHash: Hash,
}).strict();

export type EditorialMotionPlan =
  z.infer<typeof EditorialMotionPlanSchema>;

export type EditorialShot =
  z.infer<typeof EditorialShotSchema>;

export type EditorialProfile =
  z.infer<typeof EditorialProfileSchema>;

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function choice(seed: string, count: number): number {
  const digest = createHash("sha256")
    .update(seed)
    .digest();

  return digest.readUInt32BE(0) % count;
}

const MOVEMENTS = {
  explainer: [
    "push_in",
    "pull_out",
  ],
  documentary: [
    "push_in",
    "pull_out",
  ],
  story: [
    "push_in",
    "pull_out",
  ],
} as const;

export function createEditorialMotionPlan(
  input: {
    profile: EditorialProfile;
    fps: number;
    shots: EditorialShot[];
  },
): EditorialMotionPlan {
  const profile =
    EditorialProfileSchema.parse(input.profile);

  const fps = z.number().int().positive()
    .parse(input.fps);

  const shots = z.array(
    EditorialShotSchema,
  ).min(1).parse(input.shots);

  let previousEnd = 0;
  const identifiers = new Set<string>();

  for (const shot of shots) {
    if (
      identifiers.has(shot.shotId) ||
      shot.startFrame !== previousEnd ||
      shot.endFrameExclusive <= shot.startFrame
    ) {
      throw new Error(
        "M10.3 invalid editorial shot timeline",
      );
    }

    identifiers.add(shot.shotId);
    previousEnd = shot.endFrameExclusive;
  }

  const motionShots = shots.map((shot) => {
    const durationFrames =
      shot.endFrameExclusive - shot.startFrame;

    const durationSeconds =
      durationFrames / fps;

    // Tiny clips should not contain noticeable
    // zoom or pan movement.
    const shortShot = durationSeconds < 2.2;

    const available = MOVEMENTS[profile];

    const movement = shortShot
      ? ("static" as const)
      : available[
          choice(
            `${profile}:${shot.assetSha256}:${shot.shotId}`,
            available.length,
          )
        ];

    const zoom = Math.min(
      profile === "story" ? 0.06 : 0.04,
      durationSeconds * 0.008,
    );

    const pan = Math.min(
      0.16,
      durationSeconds * 0.025,
    );

    const baseScale = 1.035;

    const startScale =
      movement === "push_in"
        ? baseScale
        : movement === "pull_out"
          ? baseScale + zoom
          : baseScale;

    const endScale =
      movement === "push_in"
        ? baseScale + zoom
        : baseScale;

    return {
      shotId: shot.shotId,
      assetSha256: shot.assetSha256,
      startFrame: shot.startFrame,
      endFrameExclusive: shot.endFrameExclusive,
      movement,
      startScale,
      endScale,
      startX:
        (movement as string) === "pan_left"
          ? pan
          : (movement as string) === "pan_right"
            ? -pan
            : 0,
      endX:
        (movement as string) === "pan_left"
          ? -pan
          : (movement as string) === "pan_right"
            ? pan
            : 0,
      easing: "ease_in_out" as const,
    };
  });

  const boundaries = motionShots.slice(1)
    .map((shot, index) => {
      const previous = motionShots[index]!;
      const currentDuration =
        shot.endFrameExclusive - shot.startFrame;
      const previousDuration =
        previous.endFrameExclusive -
        previous.startFrame;

      const eligible =
        previousDuration >= fps * 3 &&
        currentDuration >= fps * 3;

      const preferCrossfade =
        profile !== "explainer" &&
        index % 3 === 1;

      const type =
        eligible && preferCrossfade
          ? ("crossfade" as const)
          : ("cut" as const);

      return {
        fromShotId: previous.shotId,
        toShotId: shot.shotId,
        type,
        durationFrames:
          type === "crossfade"
            ? Math.max(1, Math.round(fps * 0.3))
            : 0,
      };
    });

  const payload = {
    version: 1 as const,
    profile,
    fps,
    shots: motionShots,
    boundaries,
  };

  return EditorialMotionPlanSchema.parse({
    ...payload,
    planHash: hash(payload),
  });
}

export function verifyEditorialMotionPlan(
  candidate: unknown,
  source: Parameters<
    typeof createEditorialMotionPlan
  >[0],
): EditorialMotionPlan {
  const saved =
    EditorialMotionPlanSchema.parse(candidate);

  const expected =
    createEditorialMotionPlan(source);

  if (
    JSON.stringify(saved) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      "M10.3 motion plan reconstruction mismatch",
    );
  }

  return saved;
}
