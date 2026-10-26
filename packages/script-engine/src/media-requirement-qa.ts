import {
  SceneMediaPlanSchema,
  type SceneMediaPlan,
} from "./scene-media-plan.js";

export type MediaQACode =
  | "EMPTY_SEARCH_QUERIES"
  | "WEAK_SEARCH_QUERY"
  | "DUPLICATE_SEARCH_QUERY"
  | "WEAK_AI_PROMPT"
  | "MISSING_IDENTITY_INSTRUCTIONS"
  | "MISSING_SHARED_GROUP"
  | "UNEXPECTED_SHARED_GROUP"
  | "SHARED_GROUP_MEDIA_CONFLICT"
  | "SHARED_GROUP_IDENTITY_CONFLICT"
  | "MANUAL_ASSET_UNRESOLVED"
  | "DUPLICATE_SHOT_REQUIREMENT";

export interface MediaQAIssue {
  code: MediaQACode;
  severity: "blocker" | "warning";
  shotId?: string;
  message: string;
}

export interface MediaRequirementQAReport {
  passed: boolean;
  blockers: MediaQAIssue[];
  warnings: MediaQAIssue[];
  checkedShots: number;
  mode: SceneMediaPlan["mode"];
}

export interface MediaRequirementQAOptions {
  minimumSearchQueryCharacters?: number;
  minimumAIPromptCharacters?: number;
}

export function evaluateMediaRequirementQA(
  input: SceneMediaPlan,
  options: MediaRequirementQAOptions = {},
): MediaRequirementQAReport {
  const plan = SceneMediaPlanSchema.parse(input);

  const minimumSearchQueryCharacters =
    options.minimumSearchQueryCharacters ?? 8;

  const minimumAIPromptCharacters =
    options.minimumAIPromptCharacters ?? 80;

  if (
    !Number.isSafeInteger(minimumSearchQueryCharacters) ||
    minimumSearchQueryCharacters < 1 ||
    !Number.isSafeInteger(minimumAIPromptCharacters) ||
    minimumAIPromptCharacters < 1
  ) {
    throw new Error("Invalid media QA thresholds");
  }

  const blockers: MediaQAIssue[] = [];
  const warnings: MediaQAIssue[] = [];

  const add = (
    code: MediaQACode,
    severity: MediaQAIssue["severity"],
    message: string,
    shotId?: string,
  ) => {
    const issue: MediaQAIssue = {
      code,
      severity,
      message,
      ...(shotId ? { shotId } : {}),
    };

    if (severity === "blocker") {
      blockers.push(issue);
    } else {
      warnings.push(issue);
    }
  };

  const seenShots = new Set<string>();

  const sharedGroups = new Map<
    string,
    {
      mediaKind: string;
      identityKey: string;
      shotId: string;
    }
  >();

  const isV2 = plan.version === 2;
  const isStock = isV2 ? plan.mode === "A" : plan.mode === "B";
  const isAI = isV2 ? plan.mode === "B" : plan.mode === "C";
  const isSharedBackground = !isV2 && plan.mode === "A";
  const isManual = isV2 ? plan.mode === "C" : plan.mode === "D";

  for (const shot of plan.shots) {
    if (seenShots.has(shot.shotId)) {
      add(
        "DUPLICATE_SHOT_REQUIREMENT",
        "blocker",
        `Duplicate media requirement for ${shot.shotId}`,
        shot.shotId,
      );
    }

    seenShots.add(shot.shotId);

    if (isStock) {
      if (shot.searchQueries.length === 0) {
        add(
          "EMPTY_SEARCH_QUERIES",
          "blocker",
          "Stock-media shot has no search queries",
          shot.shotId,
        );
      }

      const normalizedQueries = shot.searchQueries.map(
        (query) => query.trim().toLowerCase(),
      );

      if (
        normalizedQueries.some(
          (query) =>
            query.length < minimumSearchQueryCharacters,
        )
      ) {
        add(
          "WEAK_SEARCH_QUERY",
          "warning",
          "One or more stock search queries are too vague",
          shot.shotId,
        );
      }

      if (
        new Set(normalizedQueries).size !==
        normalizedQueries.length
      ) {
        add(
          "DUPLICATE_SEARCH_QUERY",
          "warning",
          "Shot contains duplicate stock search queries",
          shot.shotId,
        );
      }
    }

    if (isAI) {
      if (
        shot.continuityPrompt.trim().length <
        minimumAIPromptCharacters
      ) {
        add(
          "WEAK_AI_PROMPT",
          "blocker",
          "AI visual prompt lacks sufficient detail",
          shot.shotId,
        );
      }

      for (const identityId of shot.identityReferencesRequired) {
        if (
          !shot.continuityPrompt.includes(identityId)
        ) {
          add(
            "MISSING_IDENTITY_INSTRUCTIONS",
            "blocker",
            `AI prompt lacks instructions for ${identityId}`,
            shot.shotId,
          );
        }
      }
    }

    if (isSharedBackground) {
      if (!shot.sharedAssetGroupId) {
        add(
          "MISSING_SHARED_GROUP",
          "blocker",
          "Background shot has no shared asset group",
          shot.shotId,
        );

        continue;
      }

      // Identity ordering is irrelevant for this comparison.
      const identityKey = JSON.stringify(
        [...shot.identityReferencesRequired].sort(),
      );

      const existing = sharedGroups.get(
        shot.sharedAssetGroupId,
      );

      if (!existing) {
        sharedGroups.set(shot.sharedAssetGroupId, {
          mediaKind: shot.preferredMediaKind,
          identityKey,
          shotId: shot.shotId,
        });
      } else {
        const incompatibleMediaKinds =
          existing.mediaKind !== "either" &&
          shot.preferredMediaKind !== "either" &&
          existing.mediaKind !== shot.preferredMediaKind;

        if (incompatibleMediaKinds) {
          add(
            "SHARED_GROUP_MEDIA_CONFLICT",
            "blocker",
            `Shared group ${shot.sharedAssetGroupId} mixes incompatible media requirements`,
            shot.shotId,
          );
        }

        if (existing.identityKey !== identityKey) {
          add(
            "SHARED_GROUP_IDENTITY_CONFLICT",
            "blocker",
            `Shared group ${shot.sharedAssetGroupId} has conflicting explicit identities`,
            shot.shotId,
          );
        }
      }
    } else if (shot.sharedAssetGroupId !== undefined) {
      add(
        "UNEXPECTED_SHARED_GROUP",
        "blocker",
        "Only background mode may declare a shared asset group",
        shot.shotId,
      );
    }

    if (isManual) {
      add(
        "MANUAL_ASSET_UNRESOLVED",
        "warning",
        "Manual media selection will be required before rendering",
        shot.shotId,
      );
    }
  }

  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
    checkedShots: plan.shots.length,
    mode: plan.mode,
  };
}
