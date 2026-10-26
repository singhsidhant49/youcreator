import path from "node:path";

import {
  readFile,
  realpath,
  stat,
} from "node:fs/promises";

import { z } from "zod";

import type {
  MediaCandidate,
  MediaCandidateProvider,
  MediaRequirement,
  MediaSearchContext,
} from "./media-resolver.js";

const ImageFileSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.split("/").includes("..") &&
      !value.split("/").includes(".") &&
      !value.includes("\0"),
    "Unsafe image-bank file path",
  );

export const ImageBankEntrySchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  file: ImageFileSchema,

  description: z.string().trim().min(10),

  tags: z.array(
    z.string().trim().min(1),
  ).default([]),

  keywords: z.array(
    z.string().trim().min(1),
  ).default([]),

  width: z.number().int().positive(),
  height: z.number().int().positive(),

  license: z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    attribution: z.string().optional(),
  }).strict().optional(),
}).strict();

export const ImageBankIndexSchema = z.object({
  version: z.literal(1),
  category: z.string().trim().min(1),
  images: z.array(ImageBankEntrySchema),
}).strict();

export type ImageBankEntry = z.infer<
  typeof ImageBankEntrySchema
>;

export type ImageBankIndex = z.infer<
  typeof ImageBankIndexSchema
>;

export interface LocalImageBankOptions {
  directories: string[];
  minimumScore?: number;
}

interface IndexedImage {
  entry: ImageBankEntry;
  category: string;
  absolutePath: string;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in",
  "on", "at", "to", "for", "with", "from",
  "by", "is", "are", "into", "inside",
  "show", "showing", "image", "photo",
  "photograph", "scene", "cinematic",
  "realistic", "close", "up",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(
      (token) =>
        token.length > 1 && !STOP_WORDS.has(token),
    );
}

function searchTerms(
  requirement: MediaRequirement,
): Set<string> {
  return new Set(
    tokenize([
      requirement.description,
      ...requirement.searchQueries,
    ].join(" ")),
  );
}

function scoreImage(
  requirement: MediaRequirement,
  image: IndexedImage,
): number {
  const queryTokens = searchTerms(requirement);

  if (queryTokens.size === 0) {
    return 0;
  }

  const description = new Set(
    tokenize(image.entry.description),
  );

  const tags = new Set(
    tokenize(image.entry.tags.join(" ")),
  );

  const keywords = new Set(
    tokenize(image.entry.keywords.join(" ")),
  );

  const category = new Set(
    tokenize(image.category),
  );

  let matchedWeight = 0;

  for (const term of queryTokens) {
    if (tags.has(term)) {
      matchedWeight += 4;
    } else if (keywords.has(term)) {
      matchedWeight += 3;
    } else if (description.has(term)) {
      matchedWeight += 2;
    } else if (category.has(term)) {
      matchedWeight += 1;
    }
  }

  // Deterministic lexical relevance, not semantic similarity.
  return Math.min(
    1,
    matchedWeight / (queryTokens.size * 4),
  );
}

function isInsideDirectory(
  directory: string,
  candidate: string,
): boolean {
  const relative = path.relative(
    directory,
    candidate,
  );

  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function loadDirectory(
  directory: string,
): Promise<IndexedImage[]> {
  const indexPath = path.join(
    directory,
    "index.json",
  );

  const raw = await readFile(
    indexPath,
    "utf8",
  );

  const index = ImageBankIndexSchema.parse(
    JSON.parse(raw),
  );

  const realDirectory = await realpath(directory);

  const indexed: IndexedImage[] = [];
  const seenIds = new Set<string>();

  for (const entry of index.images) {
    if (seenIds.has(entry.id)) {
      throw new Error(
        `Duplicate image bank ID: ${entry.id}`,
      );
    }

    seenIds.add(entry.id);

    const filename = path.resolve(
      directory,
      entry.file,
    );

    if (!isInsideDirectory(directory, filename)) {
      throw new Error(
        `Unsafe image path: ${entry.file}`,
      );
    }

    let resolvedFile: string;

    try {
      resolvedFile = await realpath(filename);

      const fileStats = await stat(resolvedFile);

      if (!fileStats.isFile()) {
        continue;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // Missing files are not discoverable.
        continue;
      }

      throw error;
    }

    // Reject symbolic links pointing outside the bank.
    if (
      !isInsideDirectory(
        realDirectory,
        resolvedFile,
      )
    ) {
      throw new Error(
        `Image bank file escapes root: ${entry.file}`,
      );
    }

    indexed.push({
      entry,
      category: index.category,
      absolutePath: resolvedFile,
    });
  }

  return indexed;
}

export class LocalImageBankProvider
  implements MediaCandidateProvider {
  readonly id = "local-image-bank";

  private readonly images: IndexedImage[];

  private readonly minimumScore: number;

  private constructor(
    images: IndexedImage[],
    minimumScore: number,
  ) {
    this.images = images;
    this.minimumScore = minimumScore;
  }

  static async create(
    options: LocalImageBankOptions,
  ): Promise<LocalImageBankProvider> {
    const minimumScore =
      options.minimumScore ?? 0.1;

    if (
      !Number.isFinite(minimumScore) ||
      minimumScore < 0 ||
      minimumScore > 1
    ) {
      throw new Error(
        "Invalid local image-bank minimumScore",
      );
    }

    if (options.directories.length === 0) {
      throw new Error(
        "At least one image-bank directory is required",
      );
    }

    const images: IndexedImage[] = [];

    for (const directory of options.directories) {
      images.push(
        ...(await loadDirectory(
          path.resolve(directory),
        )),
      );
    }

    const seenPaths = new Set<string>();

    return new LocalImageBankProvider(
      images.filter((image) => {
        if (seenPaths.has(image.absolutePath)) {
          return false;
        }

        seenPaths.add(image.absolutePath);
        return true;
      }),
      minimumScore,
    );
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

    const ranked = this.images
      .map((image) => ({
        image,
        score: scoreImage(requirement, image),
      }))
      .filter(
        (item) =>
          item.score > 0 &&
          item.score >= this.minimumScore,
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.image.entry.id.localeCompare(
            b.image.entry.id,
          ) ||
          a.image.absolutePath.localeCompare(
            b.image.absolutePath,
          ),
      );

    return ranked
      .slice(0, context.maxCandidatesPerProvider)
      .map(({ image, score }): MediaCandidate => ({
        id: image.entry.id,
        provider: "local_library",
        kind: "image",

        description: image.entry.description,

        localPath: image.absolutePath,

        width: image.entry.width,
        height: image.entry.height,

        keywords: [
          ...image.entry.tags,
          ...image.entry.keywords,
        ],

        providerScore: score,

        ...(image.entry.license
          ? {
              licenseName: image.entry.license.name,
              ...(image.entry.license.url
                ? {
                    licenseUrl:
                      image.entry.license.url,
                  }
                : {}),
              ...(image.entry.license.attribution
                ? {
                    attributionText:
                      image.entry.license.attribution,
                  }
                : {}),
            }
          : {}),
      }));
  }
}
