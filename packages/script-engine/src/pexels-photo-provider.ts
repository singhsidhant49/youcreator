import { z } from "zod";

import type {
  MediaCandidate,
  MediaCandidateProvider,
  MediaRequirement,
  MediaSearchContext,
} from "./media-resolver.js";

const PexelsPhotoSchema = z.object({
  id: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  url: z.string().url(),
  photographer: z.string().optional(),
  alt: z.string().nullable().optional(),
  src: z.object({
    original: z.string().url(),
    large2x: z.string().url().optional(),
    large: z.string().url().optional(),
    medium: z.string().url().optional(),
  }).passthrough(),
}).passthrough();

const PexelsSearchResponseSchema = z.object({
  photos: z.array(z.unknown()),
  page: z.number().int().positive(),
  per_page: z.number().int().positive(),
}).passthrough();

export interface PexelsHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type PexelsHttpClient = (
  url: string,
  options: {
    headers: {
      Authorization: string;
    };
  },
) => Promise<PexelsHttpResponse>;

export interface PexelsPhotoProviderOptions {
  apiKey: string;
  httpClient?: PexelsHttpClient;
  perPage?: number;
  orientation?: "landscape" | "portrait" | "square";
}

const PexelsOptionsSchema = z.object({
  apiKey: z.string().trim().min(1),
  perPage: z.number()
    .int()
    .min(1)
    .max(80)
    .default(15),
  orientation: z.enum([
    "landscape",
    "portrait",
    "square",
  ]).default("landscape"),
});

const ENDPOINT =
  "https://api.pexels.com/v1/search";

const LICENSE_URL =
  "https://www.pexels.com/license/";

function defaultHttpClient(
  url: string,
  options: {
    headers: {
      Authorization: string;
    };
  },
): Promise<PexelsHttpResponse> {
  return fetch(url, {
    method: "GET",
    headers: options.headers,
  });
}

function getSearchQuery(
  requirement: MediaRequirement,
): string {
  const queries = requirement.searchQueries
    .map((query) => query.trim())
    .filter(Boolean);

  const preferred = queries[0] ??
    requirement.description.trim();

  // Bounded request query.
  return preferred.slice(0, 160).trim();
}

export class PexelsPhotoProvider
  implements MediaCandidateProvider {
  readonly id = "pexels-photos";

  private readonly apiKey: string;
  private readonly perPage: number;
  private readonly orientation:
    "landscape" | "portrait" | "square";

  private readonly httpClient: PexelsHttpClient;

  constructor(options: PexelsPhotoProviderOptions) {
    const validated = PexelsOptionsSchema.parse({
      apiKey: options.apiKey,
      perPage: options.perPage,
      orientation: options.orientation,
    });

    this.apiKey = validated.apiKey;
    this.perPage = validated.perPage;
    this.orientation = validated.orientation;
    this.httpClient =
      options.httpClient ?? defaultHttpClient;
  }

  supports(
    requirement: MediaRequirement,
    context: MediaSearchContext,
  ): boolean {
    return (
      (context.mode === "A" || context.mode === "B") &&
      requirement.strategy === "stock_search" &&
      requirement.preferredMediaKind !== "video"
    );
  }

  async search(
    requirement: MediaRequirement,
    context: MediaSearchContext,
  ): Promise<MediaCandidate[]> {
    if (!this.supports(requirement, context)) {
      return [];
    }

    if (
      !Number.isSafeInteger(
        context.maxCandidatesPerProvider,
      ) ||
      context.maxCandidatesPerProvider < 1
    ) {
      throw new Error(
        "Invalid Pexels candidate limit",
      );
    }

    const rawQueries = requirement.searchQueries
      .map((q) => q.trim())
      .filter(Boolean);

    const queries: string[] = rawQueries.length > 0
      ? rawQueries
      : (requirement.description.trim() ? [requirement.description.trim()] : []);

    if (queries.length === 0) {
      return [];
    }

    const limit = Math.min(
      this.perPage,
      context.maxCandidatesPerProvider,
      80,
    );

    const candidates: MediaCandidate[] = [];
    const seenIds = new Set<number>();

    for (const query of queries) {
      const url = new URL(ENDPOINT);

      url.searchParams.set("query", query.slice(0, 160).trim());
      url.searchParams.set(
        "per_page",
        String(limit),
      );
      url.searchParams.set("page", "1");
      url.searchParams.set(
        "orientation",
        this.orientation,
      );

      const response = await this.httpClient(
        url.toString(),
        {
          headers: {
            Authorization: this.apiKey,
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          `Pexels photo search failed with HTTP ${response.status}`,
        );
      }

      const payload = PexelsSearchResponseSchema.parse(
        await response.json(),
      );

      for (const rawPhoto of payload.photos) {
        const parsed =
          PexelsPhotoSchema.safeParse(rawPhoto);

        if (!parsed.success) {
          continue;
        }

        const photo = parsed.data;

        if (seenIds.has(photo.id)) {
          continue;
        }

        seenIds.add(photo.id);

        const description =
          photo.alt?.trim() ||
          query;

        candidates.push({
          id: `pexels-photo-${photo.id}`,
          provider: "pexels",
          kind: "image",
          providerAssetId: String(photo.id),

          description,

          sourceUrl: photo.src.large2x ?? photo.src.original,

          previewUrl:
            photo.src.medium ??
            photo.src.large ??
            photo.src.large2x ??
            photo.src.original,

          width: photo.width,
          height: photo.height,

          keywords: [query, ...requirement.searchQueries],
          providerScore: 1.0,

          licenseName: "Pexels License",
          licenseUrl: LICENSE_URL,

          ...(photo.photographer
            ? {
                attributionText:
                  `Photo by ${photo.photographer} on Pexels (${photo.url})`,
              }
            : {}),
        });

        if (candidates.length >= limit) {
          break;
        }
      }

      if (candidates.length > 0) {
        break;
      }
    }

    return candidates;
  }
}
