import { z } from "zod";

import {
  StoryboardSchema,
  type Storyboard,
} from "@youcreator/contracts";

export const VisualContinuityProfileSchema = z.enum([
  "documentary",
  "educational",
  "meditation",
  "audiobook",
  "explainer",
  "story",
]);

export const ContinuityAnchorSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(5),

  type: z.enum([
    "subject",
    "environment",
  ]),

  source: z.enum([
    "explicit",
    "provisional",
  ]).default("provisional"),

  consistencyRules: z.string().optional(),
}).strict();

export const ExplicitVisualIdentitySchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  type: z.enum(["subject", "environment"]),
  description: z.string().trim().min(10),

  // Human-readable appearance or environment rules.
  consistencyRules: z.string().trim().min(10),
}).strict();

export const ShotIdentityAssignmentSchema = z.object({
  shotId: z.string().min(1),
  identityIds: z.array(
    z.string().min(1),
  ),
}).strict();

export const VisualIdentityConfigSchema = z.object({
  identities: z.array(
    ExplicitVisualIdentitySchema,
  ).default([]),

  assignments: z.array(
    ShotIdentityAssignmentSchema,
  ).default([]),
}).strict();

export type VisualIdentityConfig = z.input<
  typeof VisualIdentityConfigSchema
>;

export const ContinuityShotSchema = z.object({
  shotId: z.string().min(1),
  anchorIds: z.array(z.string()).default([]),
  framing: z.enum([
    "wide",
    "medium",
    "close_up",
    "detail",
  ]),
  cameraAngle: z.enum([
    "eye_level",
    "high_angle",
    "low_angle",
    "side",
  ]),
  continuityPrompt: z.string().min(10),
}).strict();

export const VisualContinuityPlanSchema = z.object({
  version: z.literal(1),
  profile: VisualContinuityProfileSchema,
  styleGuide: z.string().min(10),
  anchors: z.array(ContinuityAnchorSchema),
  shots: z.array(ContinuityShotSchema),
}).strict();

export type VisualContinuityProfile = z.infer<
  typeof VisualContinuityProfileSchema
>;

export type VisualContinuityPlan = z.infer<
  typeof VisualContinuityPlanSchema
>;

const PROFILE_STYLES: Record<
  VisualContinuityProfile,
  string
> = {
  documentary:
    "Realistic cinematic documentary photography, natural lighting, believable locations, restrained color grading.",
  educational:
    "Clear professional educational visuals, recognizable subjects, natural lighting, uncluttered compositions.",
  explainer:
    "Clear professional educational visuals, recognizable subjects, natural lighting, uncluttered compositions.",
  story:
    "Cohesive cinematic storybook visuals, consistent environments, natural lighting, atmospheric compositions.",
  meditation:
    "Calm atmospheric landscapes, gentle natural lighting, soft colors, uncluttered compositions.",
  audiobook:
    "Cohesive cinematic storybook visuals, consistent environments, natural lighting, atmospheric compositions.",
};

const FRAMINGS = [
  "wide",
  "medium",
  "close_up",
  "detail",
] as const;

const CAMERA_ANGLES = [
  "eye_level",
  "side",
  "high_angle",
  "low_angle",
] as const;

const SUBJECT_TERMS = [
  "person",
  "woman",
  "man",
  "character",
  "student",
  "worker",
  "child",
  "scientist",
];

function detectSubject(
  description: string,
): string | undefined {
  const lower = description.toLowerCase();

  return SUBJECT_TERMS.find((term) =>
    new RegExp(`\\b${term}\\b`, "i").test(lower),
  );
}

export function planVisualContinuity(
  input: Storyboard,
  profile: VisualContinuityProfile = "documentary",
  identityConfig: VisualIdentityConfig = {},
): VisualContinuityPlan {
  const storyboard = StoryboardSchema.parse(input);

  const identitySettings =
    VisualIdentityConfigSchema.parse(identityConfig);

  const explicitIdentityMap = new Map(
    identitySettings.identities.map(
      (identity) => [identity.id, identity],
    ),
  );

  if (
    explicitIdentityMap.size !==
    identitySettings.identities.length
  ) {
    throw new Error("Duplicate explicit identity ID");
  }

  for (const identity of identitySettings.identities) {
    if (identity.id.startsWith("provisional-")) {
      throw new Error(
        "Explicit identity IDs cannot use the provisional- prefix",
      );
    }
  }

  const assignmentMap = new Map(
    identitySettings.assignments.map(
      (assignment) => [
        assignment.shotId,
        assignment.identityIds,
      ],
    ),
  );

  if (
    assignmentMap.size !==
    identitySettings.assignments.length
  ) {
    throw new Error("Duplicate shot identity assignment");
  }

  const storyboardShotIds = new Set(
    storyboard.sections.flatMap((section) =>
      section.scenes.flatMap((scene) =>
        scene.shots.map((shot) => shot.id),
      ),
    ),
  );

  for (const assignment of identitySettings.assignments) {
    if (!storyboardShotIds.has(assignment.shotId)) {
      throw new Error(
        `Identity assignment references unknown shot: ${assignment.shotId}`,
      );
    }

    if (
      new Set(assignment.identityIds).size !==
      assignment.identityIds.length
    ) {
      throw new Error(
        `Duplicate identities assigned to ${assignment.shotId}`,
      );
    }

    for (const identityId of assignment.identityIds) {
      if (!explicitIdentityMap.has(identityId)) {
        throw new Error(
          `Unknown explicit identity: ${identityId}`,
        );
      }
    }
  }

  const styleGuide = PROFILE_STYLES[profile];

  if (!styleGuide) {
    throw new Error("Invalid continuity profile");
  }

  const anchors: VisualContinuityPlan["anchors"] = [];

  for (const identity of identitySettings.identities) {
    anchors.push({
      id: identity.id,
      type: identity.type,
      source: "explicit",
      description: identity.description,
      consistencyRules: identity.consistencyRules,
    });
  }

  const shots: VisualContinuityPlan["shots"] = [];

  const subjectAnchors = new Map<string, string>();

  let shotIndex = 0;

  for (const section of storyboard.sections) {
    for (const scene of section.scenes) {
      for (const shot of scene.shots) {
        const description =
          shot.visualRequest.description;

        const explicitIds = assignmentMap.get(shot.id);

        const anchorIds: string[] = [];
        let subject: string | undefined;

        if (explicitIds !== undefined) {
          // An explicit assignment is authoritative.
          // Even an empty array means "no recurring identity".
          anchorIds.push(...explicitIds);
        } else {
          // Legacy/provisional category detection.
          subject = detectSubject(description);

          if (subject) {
            let anchorId = subjectAnchors.get(subject);

            if (!anchorId) {
              anchorId = `provisional-${subject}`;

              subjectAnchors.set(subject, anchorId);

              anchors.push({
                id: anchorId,
                type: "subject",
                source: "provisional",
                description:
                  `Generic subject category: ${subject}`,
              });
            }

            anchorIds.push(anchorId);
          }
        }

        const framing =
          FRAMINGS[shotIndex % FRAMINGS.length]!;

        const cameraAngle =
          CAMERA_ANGLES[
            shotIndex % CAMERA_ANGLES.length
          ]!;

        const explicitRules = anchorIds
          .map((id) => explicitIdentityMap.get(id))
          .filter(
            (identity): identity is NonNullable<
              typeof identity
            > => identity !== undefined,
          )
          .map(
            (identity) =>
              `Identity ${identity.id}: ` +
              `${identity.description}. ` +
              `${identity.consistencyRules}`,
          );

        const continuityPrompt = [
          styleGuide,
          `Visual: ${description}`,
          `Framing: ${framing.replaceAll("_", " ")}`,
          `Camera angle: ${cameraAngle.replaceAll("_", " ")}`,
          ...explicitRules,
          subject
            ? `Generic category: ${subject}. Do not assume this is the same individual as another shot.`
            : "",
        ]
          .filter(Boolean)
          .join(". ");

        shots.push({
          shotId: shot.id,
          anchorIds,
          framing,
          cameraAngle,
          continuityPrompt,
        });

        shotIndex++;
      }
    }
  }

  const plan = VisualContinuityPlanSchema.parse({
    version: 1,
    profile,
    styleGuide,
    anchors,
    shots,
  });

  const validation = validateVisualContinuity(
    storyboard,
    plan,
  );

  if (!validation.passed) {
    throw new Error(
      `Visual continuity validation failed: ${
        validation.issues
          .map((issue) => issue.code)
          .join(", ")
      }`,
    );
  }

  return plan;
}

export interface ContinuityValidationIssue {
  code:
    | "DUPLICATE_SHOT"
    | "MISSING_SHOT"
    | "UNKNOWN_SHOT"
    | "DUPLICATE_ANCHOR"
    | "UNKNOWN_ANCHOR"
    | "DUPLICATE_ANCHOR_REFERENCE"
    | "UNUSED_ANCHOR"
    | "SHOT_ORDER_MISMATCH";
  message: string;
}

export interface ContinuityValidationReport {
  passed: boolean;
  expectedShots: number;
  actualShots: number;
  issues: ContinuityValidationIssue[];
}

export function validateVisualContinuity(
  storyboardInput: Storyboard,
  planInput: VisualContinuityPlan,
): ContinuityValidationReport {
  const storyboard = StoryboardSchema.parse(
    storyboardInput,
  );

  const plan = VisualContinuityPlanSchema.parse(
    planInput,
  );

  const expectedIds = storyboard.sections.flatMap(
    (section) =>
      section.scenes.flatMap(
        (scene) => scene.shots.map(
          (shot) => shot.id,
        ),
      ),
  );

  const actualIds = plan.shots.map(
    (shot) => shot.shotId,
  );

  const expectedSet = new Set(expectedIds);
  const actualSet = new Set(actualIds);

  const issues: ContinuityValidationIssue[] = [];

  function addIssue(
    code: ContinuityValidationIssue["code"],
    message: string,
  ) {
    issues.push({ code, message });
  }

  if (expectedSet.size !== expectedIds.length) {
    addIssue(
      "DUPLICATE_SHOT",
      "Storyboard contains duplicate shot IDs",
    );
  }

  if (actualSet.size !== actualIds.length) {
    addIssue(
      "DUPLICATE_SHOT",
      "Continuity plan contains duplicate shot IDs",
    );
  }

  for (const id of expectedSet) {
    if (!actualSet.has(id)) {
      addIssue(
        "MISSING_SHOT",
        `Continuity plan missing shot: ${id}`,
      );
    }
  }

  for (const id of actualSet) {
    if (!expectedSet.has(id)) {
      addIssue(
        "UNKNOWN_SHOT",
        `Continuity plan contains unknown shot: ${id}`,
      );
    }
  }

  if (
    expectedIds.length === actualIds.length &&
    expectedIds.some(
      (id, index) => id !== actualIds[index],
    )
  ) {
    addIssue(
      "SHOT_ORDER_MISMATCH",
      "Continuity shots do not match storyboard order",
    );
  }

  const anchorIds = plan.anchors.map(
    (anchor) => anchor.id,
  );

  const anchorSet = new Set(anchorIds);

  if (anchorSet.size !== anchorIds.length) {
    addIssue(
      "DUPLICATE_ANCHOR",
      "Continuity plan contains duplicate anchor IDs",
    );
  }

  const usedAnchors = new Set<string>();

  for (const shot of plan.shots) {
    if (
      new Set(shot.anchorIds).size !==
      shot.anchorIds.length
    ) {
      addIssue(
        "DUPLICATE_ANCHOR_REFERENCE",
        `Shot ${shot.shotId} repeats an anchor`,
      );
    }

    for (const id of shot.anchorIds) {
      if (!anchorSet.has(id)) {
        addIssue(
          "UNKNOWN_ANCHOR",
          `Shot ${shot.shotId} references unknown anchor ${id}`,
        );
      }

      usedAnchors.add(id);
    }
  }

  for (const anchor of plan.anchors) {
    if (
      !usedAnchors.has(anchor.id) &&
      anchor.source === "provisional"
    ) {
      addIssue(
        "UNUSED_ANCHOR",
        `Unused provisional anchor: ${anchor.id}`,
      );
    }
  }

  return {
    passed: issues.length === 0,
    expectedShots: expectedIds.length,
    actualShots: actualIds.length,
    issues,
  };
}
