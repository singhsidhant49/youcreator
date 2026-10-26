import { createHash } from "node:crypto";
import { z } from "zod";

import {
  StoryboardSchema,
  VideoScriptSchema,
  type Storyboard,
  type VideoScript,
} from "@youcreator/contracts";

import {
  hashScriptContent,
} from "./script-job-artifacts.js";

import {
  validateStoryboardCoverage,
} from "./storyboard-coverage.js";

import {
  VisualContinuityPlanSchema,
  validateVisualContinuity,
  type VisualContinuityPlan,
} from "./visual-continuity.js";

import {
  SceneMediaPlanSchema,
  validateSceneMediaPlan,
  type SceneMediaPlan,
} from "./scene-media-plan.js";

import {
  evaluateMediaRequirementQA,
} from "./media-requirement-qa.js";

const Sha256Schema =
  z.string().regex(/^[a-f0-9]{64}$/);

const ProductionPayloadSchema = z.object({
  version: z.literal(1),

  scriptHash: Sha256Schema,

  script: VideoScriptSchema,
  storyboard: StoryboardSchema,

  continuity: VisualContinuityPlanSchema,
  mediaPlan: SceneMediaPlanSchema,

  // These reports are verified by recomputation below.
  coverage: z.unknown(),
  mediaQA: z.unknown(),
}).strict();

export const StoryboardProductionPackageSchema =
  ProductionPayloadSchema.extend({
    packageHash: Sha256Schema,
  }).strict();

type Payload = z.infer<
  typeof ProductionPayloadSchema
>;

export type StoryboardProductionPackage =
  Omit<Payload, "coverage" | "mediaQA"> & {
    coverage: ReturnType<
      typeof validateStoryboardCoverage
    >;

    mediaQA: ReturnType<
      typeof evaluateMediaRequirementQA
    >;

    packageHash: string;
  };

export type StoryboardProductionInput = {
  script: VideoScript;
  storyboard: Storyboard;
  continuity: VisualContinuityPlan;
  mediaPlan: SceneMediaPlan;
};

function hashPayload(payload: Payload): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function assertProductionValidity(
  script: VideoScript,
  storyboard: Storyboard,
  continuity: VisualContinuityPlan,
  mediaPlan: SceneMediaPlan,
) {
  const coverage = validateStoryboardCoverage(
    script,
    storyboard,
  );

  if (!coverage.passed) {
    throw new Error(
      "Storyboard production blocked: narration coverage failed",
    );
  }

  const continuityValidation =
    validateVisualContinuity(
      storyboard,
      continuity,
    );

  if (!continuityValidation.passed) {
    throw new Error(
      "Storyboard production blocked: continuity validation failed",
    );
  }

  const mediaValidation = validateSceneMediaPlan(
    storyboard,
    continuity,
    mediaPlan,
  );

  if (!mediaValidation.passed) {
    throw new Error(
      "Storyboard production blocked: scene media validation failed",
    );
  }

  const mediaQA = evaluateMediaRequirementQA(
    mediaPlan,
  );

  if (!mediaQA.passed) {
    throw new Error(
      "Storyboard production blocked: media requirement QA failed",
    );
  }

  return { coverage, mediaQA };
}

export function createStoryboardProductionPackage(
  input: StoryboardProductionInput,
): StoryboardProductionPackage {
  const script = VideoScriptSchema.parse(
    input.script,
  );

  const storyboard = StoryboardSchema.parse(
    input.storyboard,
  );

  const continuity =
    VisualContinuityPlanSchema.parse(
      input.continuity,
    );

  const mediaPlan = SceneMediaPlanSchema.parse(
    input.mediaPlan,
  );

  const reports = assertProductionValidity(
    script,
    storyboard,
    continuity,
    mediaPlan,
  );

  const payload = ProductionPayloadSchema.parse({
    version: 1,
    scriptHash: hashScriptContent(script),
    script,
    storyboard,
    continuity,
    mediaPlan,
    coverage: reports.coverage,
    mediaQA: reports.mediaQA,
  });

  return {
    ...payload,
    coverage: reports.coverage,
    mediaQA: reports.mediaQA,
    packageHash: hashPayload(payload),
  };
}

export function verifyStoryboardProductionPackage(
  input: unknown,
): StoryboardProductionPackage {
  const parsed =
    StoryboardProductionPackageSchema.parse(input);

  const {
    packageHash,
    ...payload
  } = parsed;

  const actualHash = hashPayload(payload);

  if (actualHash !== packageHash) {
    throw new Error(
      "Storyboard production package integrity mismatch",
    );
  }

  if (
    hashScriptContent(parsed.script) !==
    parsed.scriptHash
  ) {
    throw new Error(
      "Storyboard production script hash mismatch",
    );
  }

  const reports = assertProductionValidity(
    parsed.script,
    parsed.storyboard,
    parsed.continuity,
    parsed.mediaPlan,
  );

  if (
    JSON.stringify(parsed.coverage) !==
    JSON.stringify(reports.coverage)
  ) {
    throw new Error(
      "Storyboard production coverage report mismatch",
    );
  }

  if (
    JSON.stringify(parsed.mediaQA) !==
    JSON.stringify(reports.mediaQA)
  ) {
    throw new Error(
      "Storyboard production media QA report mismatch",
    );
  }

  return {
    ...parsed,
    coverage: reports.coverage,
    mediaQA: reports.mediaQA,
  };
}
