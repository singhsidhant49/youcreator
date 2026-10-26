import { z } from "zod";

import {
  MediaSourceSchema,
} from "@youcreator/contracts";

import {
  ShotMediaRequirementSchema,
  type SceneMediaPlan,
} from "./scene-media-plan.js";

import type { SemanticCandidateEvidence } from "./media-semantic-gate.js";

/**
 * Describes a media item discovered through a provider.
 *
 * A candidate is not yet a verified MediaAsset.
 */
export const MediaCandidateSchema = z.object({
  id: z.string().min(1),

  provider: MediaSourceSchema,

  kind: z.enum([
    "image",
    "video",
  ]),

  description: z.string().min(1),

  // Discovery metadata, not verified media.
  sourceUrl: z.string().url().optional(),
  previewUrl: z.string().url().optional(),

  localPath: z.string().min(1).optional(),

  providerAssetId: z.string().optional(),

  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),

  keywords: z.array(z.string()).default([]),

  // A provider-supplied score, not a final ranking.
  providerScore: z.number().min(0).max(1).optional(),

  // License claims still require independent checks.
  licenseName: z.string().optional(),
  licenseUrl: z.string().url().optional(),
  attributionText: z.string().optional(),

  // P0: Optional verified semantic evidence for this candidate
  semanticEvidence: z.custom<SemanticCandidateEvidence>().optional(),
}).strict();

export type MediaCandidate = z.infer<
  typeof MediaCandidateSchema
>;

export type MediaRequirement = z.infer<
  typeof ShotMediaRequirementSchema
>;

export interface MediaSearchContext {
  jobId: string;
  mode: SceneMediaPlan["mode"];
  maxCandidatesPerProvider: number;
}

/**
 * Every discovery provider implements this interface.
 *
 * Examples:
 * - Local image bank
 * - Pexels
 * - Wikimedia
 * - Other stock providers
 *
 * AI generation and manual asset resolution may use
 * specialized adapters in later milestones.
 */
export interface MediaCandidateProvider {
  readonly id: string;

  supports(
    requirement: MediaRequirement,
    context: MediaSearchContext,
  ): boolean;

  search(
    requirement: MediaRequirement,
    context: MediaSearchContext,
  ): Promise<MediaCandidate[]>;
}

export type MediaDiscoveryOutcome =
  | {
      status: "candidates_found";
      shotId: string;
      candidates: MediaCandidate[];
      attemptedProviders: string[];
      providerErrors: string[];
    }
  | {
      status: "no_candidates";
      shotId: string;
      candidates: [];
      attemptedProviders: string[];
      providerErrors: string[];
    };

export interface MediaResolverOptions {
  maxCandidatesPerProvider?: number;
  failOnProviderError?: boolean;
}

/**
 * Coordinates candidate discovery across providers.
 *
 * Does not:
 * - download assets
 * - verify file bytes
 * - grant license approval
 * - select the final render asset
 */
export class MediaResolver {
  private readonly providers: MediaCandidateProvider[];

  private readonly options: Required<MediaResolverOptions>;

  constructor(
    providers: MediaCandidateProvider[],
    options: MediaResolverOptions = {},
  ) {
    const ids = providers.map(
      (provider) => provider.id,
    );

    if (
      ids.some((id) => !id.trim()) ||
      new Set(ids).size !== ids.length
    ) {
      throw new Error(
        "Media providers require unique non-empty IDs",
      );
    }

    const maxCandidatesPerProvider =
      options.maxCandidatesPerProvider ?? 10;

    if (
      !Number.isSafeInteger(maxCandidatesPerProvider) ||
      maxCandidatesPerProvider < 1
    ) {
      throw new Error(
        "Invalid maxCandidatesPerProvider",
      );
    }

    this.providers = [...providers];

    this.options = {
      maxCandidatesPerProvider,
      failOnProviderError:
        options.failOnProviderError ?? false,
    };
  }

  async discover(
    input: unknown,
    context: {
      jobId: string;
      mode: SceneMediaPlan["mode"];
    },
  ): Promise<MediaDiscoveryOutcome> {
    const requirement =
      ShotMediaRequirementSchema.parse(input);

    const searchContext: MediaSearchContext = {
      jobId: context.jobId,
      mode: context.mode,
      maxCandidatesPerProvider:
        this.options.maxCandidatesPerProvider,
    };

    const attemptedProviders: string[] = [];
    const providerErrors: string[] = [];
    const candidates: MediaCandidate[] = [];

    for (const provider of this.providers) {
      if (
        !provider.supports(
          requirement,
          searchContext,
        )
      ) {
        continue;
      }

      attemptedProviders.push(provider.id);

      try {
        const discovered = await provider.search(
          requirement,
          searchContext,
        );

        if (!Array.isArray(discovered)) {
          throw new Error(
            "Provider returned a non-array response",
          );
        }

        for (
          const rawCandidate of discovered.slice(
            0,
            this.options.maxCandidatesPerProvider,
          )
        ) {
          const candidate =
            MediaCandidateSchema.parse(rawCandidate);

          const requiredKind =
            requirement.preferredMediaKind;

          if (
            requiredKind !== "either" &&
            candidate.kind !== requiredKind
          ) {
            continue;
          }

          candidates.push(candidate);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        providerErrors.push(
          `${provider.id}: ${message}`,
        );

        if (this.options.failOnProviderError) {
          throw new Error(
            `Media provider ${provider.id} failed: ${message}`,
          );
        }
      }
    }

    // Remove duplicates within the same media source.
    const seen = new Set<string>();

    const uniqueCandidates = candidates.filter(
      (candidate) => {
        const key =
          `${candidate.provider}:${candidate.id}`;

        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      },
    );

    if (uniqueCandidates.length > 0) {
      return {
        status: "candidates_found",
        shotId: requirement.shotId,
        candidates: uniqueCandidates,
        attemptedProviders,
        providerErrors,
      };
    }

    return {
      status: "no_candidates",
      shotId: requirement.shotId,
      candidates: [],
      attemptedProviders,
      providerErrors,
    };
  }
}
