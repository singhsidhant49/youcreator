import { z } from "zod";

import {
  StoryboardSchema,
  type Storyboard,
} from "@youcreator/contracts";

import {
  VisualContinuityPlanSchema,
  validateVisualContinuity,
  type VisualContinuityPlan,
} from "./visual-continuity.js";

export const VideoMediaModeSchema = z.enum([
  "A",
  "B",
  "C",
  "D",
]);

export const MediaResolutionStrategySchema = z.enum([
  "shared_background",
  "stock_search",
  "ai_generation",
  "manual_asset",
]);

export const SceneDirectionSchema = z.object({
  sceneId: z.string().min(1),
  sectionId: z.string().min(1),
  purpose: z.string().min(1),
  visualStyle: z.string().min(10),
  shotIds: z.array(z.string().min(1)).min(1),
}).strict();

export const ShotMediaRequirementSchema = z.object({
  shotId: z.string().min(1),
  sceneId: z.string().min(1),

  strategy: MediaResolutionStrategySchema,

  description: z.string().min(10),

  searchQueries: z.array(z.string()),
  negativeTerms: z.array(z.string()),

  preferredMediaKind: z.enum([
    "image",
    "video",
    "either",
  ]),

  continuityAnchorIds: z.array(z.string()),

  // Explicit subject or environment identities only.
  identityReferencesRequired: z.array(
    z.string(),
  ),

  continuityPrompt: z.string().min(10),

  // Used to group atmospheric backgrounds.
  sharedAssetGroupId: z.string().optional(),

  estimatedDurationSeconds: z.number().positive(),
}).strict();

export const SceneMediaPlanSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]).default(1),
  mode: VideoMediaModeSchema,
  scenes: z.array(SceneDirectionSchema).min(1),
  shots: z.array(ShotMediaRequirementSchema).min(1),
}).strict();

export type VideoMediaMode = z.infer<
  typeof VideoMediaModeSchema
>;

export type SceneMediaPlan = z.infer<
  typeof SceneMediaPlanSchema
>;

export interface SceneMediaPlanIssue {
  code:
    | "INVALID_CONTINUITY"
    | "MISSING_SHOT"
    | "EXTRA_SHOT"
    | "DUPLICATE_SHOT"
    | "SHOT_ORDER_MISMATCH"
    | "SCENE_MISMATCH"
    | "UNKNOWN_IDENTITY";

  message: string;
}

export interface SceneMediaPlanValidation {
  passed: boolean;
  issues: SceneMediaPlanIssue[];
}

export function strategyForMode(
  mode: VideoMediaMode,
  version: 1 | 2 = 1,
): z.infer<typeof MediaResolutionStrategySchema> {
  if (version === 2) {
    switch (mode) {
      case "A":
        return "stock_search";
      case "B":
        return "ai_generation";
      case "C":
        return "manual_asset";
      default:
        throw new Error(`Invalid version 2 media mode: ${mode}`);
    }
  }

  switch (mode) {
    case "A":
      return "shared_background";
    case "B":
      return "stock_search";
    case "C":
      return "ai_generation";
    case "D":
      return "manual_asset";
  }
}

export function validateSceneMediaPlan(
  storyboardInput: Storyboard,
  continuityInput: VisualContinuityPlan,
  planInput: SceneMediaPlan,
): SceneMediaPlanValidation {
  const storyboard = StoryboardSchema.parse(
    storyboardInput,
  );

  const continuity =
    VisualContinuityPlanSchema.parse(continuityInput);

  const plan = SceneMediaPlanSchema.parse(planInput);

  const issues: SceneMediaPlanIssue[] = [];

  const add = (
    code: SceneMediaPlanIssue["code"],
    message: string,
  ) => {
    issues.push({ code, message });
  };

  const continuityReport = validateVisualContinuity(
    storyboard,
    continuity,
  );

  if (!continuityReport.passed) {
    add(
      "INVALID_CONTINUITY",
      "Continuity plan does not match storyboard",
    );
  }

  const expectedScenes = storyboard.sections.flatMap(
    (section) =>
      section.scenes.map((scene) => ({
        sectionId: section.id,
        sceneId: scene.id,
        purpose: scene.purpose,
        shotIds: scene.shots.map((shot) => shot.id),
      })),
  );

  const expectedShots = storyboard.sections.flatMap(
    (section) =>
      section.scenes.flatMap(
        (scene) => scene.shots.map((shot) => shot.id),
      ),
  );

  const actualShots = plan.shots.map(
    (shot) => shot.shotId,
  );

  const expectedSet = new Set(expectedShots);
  const actualSet = new Set(actualShots);

  if (actualSet.size !== actualShots.length) {
    add("DUPLICATE_SHOT", "Duplicate media requirement");
  }

  for (const id of expectedShots) {
    if (!actualSet.has(id)) {
      add("MISSING_SHOT", `Missing shot: ${id}`);
    }
  }

  for (const id of actualShots) {
    if (!expectedSet.has(id)) {
      add("EXTRA_SHOT", `Unexpected shot: ${id}`);
    }
  }

  if (
    JSON.stringify(expectedShots) !==
    JSON.stringify(actualShots)
  ) {
    add(
      "SHOT_ORDER_MISMATCH",
      "Media requirements are not in storyboard order",
    );
  }

  const actualScenes = plan.scenes.map(
    (scene) => ({
      sectionId: scene.sectionId,
      sceneId: scene.sceneId,
      purpose: scene.purpose,
      shotIds: scene.shotIds,
    }),
  );

  if (
    JSON.stringify(expectedScenes) !==
    JSON.stringify(actualScenes)
  ) {
    add(
      "SCENE_MISMATCH",
      "Scene directions do not match storyboard scenes",
    );
  }

  const anchors = new Map(
    continuity.anchors.map((anchor) => [
      anchor.id,
      anchor,
    ]),
  );

  const continuityShots = new Map(
    continuity.shots.map((shot) => [
      shot.shotId,
      shot,
    ]),
  );

  const expectedStrategy = strategyForMode(plan.mode, plan.version);

  for (const requirement of plan.shots) {
    const source = continuityShots.get(
      requirement.shotId,
    );

    if (
      !source ||
      JSON.stringify(source.anchorIds) !==
        JSON.stringify(
          requirement.continuityAnchorIds,
        ) ||
      source.continuityPrompt !==
        requirement.continuityPrompt
    ) {
      add(
        "INVALID_CONTINUITY",
        `Continuity mismatch: ${requirement.shotId}`,
      );
    }

    const expectedExplicitIds = (
      source?.anchorIds ?? []
    ).filter(
      (id) => anchors.get(id)?.source === "explicit",
    );

    if (
      JSON.stringify(expectedExplicitIds) !==
      JSON.stringify(
        requirement.identityReferencesRequired,
      )
    ) {
      add(
        "UNKNOWN_IDENTITY",
        `Explicit identity mismatch: ${requirement.shotId}`,
      );
    }

    if (requirement.strategy !== expectedStrategy) {
      add(
        "SCENE_MISMATCH",
        `Incorrect media strategy: ${requirement.shotId}`,
      );
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

export function createSceneMediaPlan(
  storyboardInput: Storyboard,
  continuityInput: VisualContinuityPlan,
  mode: VideoMediaMode,
  version: 1 | 2 = 1,
): SceneMediaPlan {
  const storyboard = StoryboardSchema.parse(
    storyboardInput,
  );

  const continuity =
    VisualContinuityPlanSchema.parse(continuityInput);

  const parsedMode = VideoMediaModeSchema.parse(mode);

  const continuityValidation =
    validateVisualContinuity(
      storyboard,
      continuity,
    );

  if (!continuityValidation.passed) {
    throw new Error(
      "Cannot create media plan from invalid continuity",
    );
  }

  const continuityShots = new Map(
    continuity.shots.map((shot) => [
      shot.shotId,
      shot,
    ]),
  );

  const anchors = new Map(
    continuity.anchors.map((anchor) => [
      anchor.id,
      anchor,
    ]),
  );

  const scenes: SceneMediaPlan["scenes"] = [];
  const shots: SceneMediaPlan["shots"] = [];

  for (const section of storyboard.sections) {
    for (const scene of section.scenes) {
      scenes.push({
        sceneId: scene.id,
        sectionId: section.id,
        purpose: scene.purpose,
        visualStyle: continuity.styleGuide,
        shotIds: scene.shots.map((shot) => shot.id),
      });

      for (const shot of scene.shots) {
        const visual = continuityShots.get(shot.id);

        if (!visual) {
          throw new Error(
            `Missing continuity for shot ${shot.id}`,
          );
        }

        const explicitIds = visual.anchorIds.filter(
          (id) =>
            anchors.get(id)?.source === "explicit",
        );

        shots.push({
          shotId: shot.id,
          sceneId: scene.id,
          strategy: strategyForMode(parsedMode, version),

          description:
            shot.visualRequest.description,

          searchQueries:
            shot.visualRequest.searchQueries,

          negativeTerms:
            shot.visualRequest.negativeTerms,

          preferredMediaKind:
            shot.visualRequest.preferredMediaKind,

          continuityAnchorIds: visual.anchorIds,

          identityReferencesRequired: explicitIds,

          continuityPrompt:
            visual.continuityPrompt,

          estimatedDurationSeconds:
            shot.estimatedDurationSeconds,

          ...(parsedMode === "A" && version === 1
            ? {
                sharedAssetGroupId:
                  `background-${section.id}`,
              }
            : {}),
        });
      }
    }
  }

  const plan = SceneMediaPlanSchema.parse({
    version,
    mode: parsedMode,
    scenes,
    shots,
  });

  const validation = validateSceneMediaPlan(
    storyboard,
    continuity,
    plan,
  );

  if (!validation.passed) {
    throw new Error(
      `Scene media plan invalid: ${
        validation.issues
          .map((issue) => issue.code)
          .join(", ")
      }`,
    );
  }

  return plan;
}
