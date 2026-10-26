import { createHash } from "node:crypto";
import { z } from "zod";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const YoutubeChapterSchema = z.object({
  startSeconds: z.number().int().safe().nonnegative(),
  title: z.string().trim().min(1).max(100),
}).strict();

export const YoutubeThumbnailSchema = z.object({
  sha256: Hash,
  bytes: z.number().int().safe().positive(),
  mimeType: z.enum(["image/jpeg", "image/png"]),
  width: z.number().int().safe().positive(),
  height: z.number().int().safe().positive(),
}).strict();

export const YoutubeMetadataInputSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().default(""),
  tags: z.array(z.string().trim().min(1)).default([]),
  categoryId: z.string().regex(/^[0-9]+$/),
  defaultLanguage: z.string().min(2).optional(),
  chapters: z.array(YoutubeChapterSchema).default([]),
  thumbnail: YoutubeThumbnailSchema.optional(),
}).strict();

export type YoutubeMetadataInput =
  z.input<typeof YoutubeMetadataInputSchema>;

export type YoutubeMetadata =
  z.output<typeof YoutubeMetadataInputSchema>;

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function chapterTimestamp(
  seconds: number,
): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(
    (seconds % 3600) / 60,
  );
  const remainder = seconds % 60;

  const two = (n: number) =>
    String(n).padStart(2, "0");

  if (hours > 0) {
    return [
      two(hours),
      two(minutes),
      two(remainder),
    ].join(":");
  }

  return `${two(minutes)}:${two(remainder)}`;
}

export function formatYoutubeChapters(
  chapters: readonly z.infer<
    typeof YoutubeChapterSchema
  >[],
): string {
  return chapters
    .map(
      (chapter) =>
        `${chapterTimestamp(chapter.startSeconds)} ${chapter.title}`,
    )
    .join("\n");
}

export function validateYoutubeChapters(
  chapters: readonly z.infer<
    typeof YoutubeChapterSchema
  >[],
  durationSeconds: number,
): void {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new Error("M9 invalid video duration");
  }

  if (chapters.length === 0) {
    return;
  }

  // Reject invalid chapters instead of silently
  // publishing timestamps YouTube may ignore.
  if (
    chapters.length < 3 ||
    chapters[0]!.startSeconds !== 0
  ) {
    throw new Error(
      "M9 chapters require at least three entries starting at 00:00",
    );
  }

  for (let i = 0; i < chapters.length; i++) {
    const current = chapters[i]!;
    const next = chapters[i + 1];

    if (current.startSeconds >= durationSeconds) {
      throw new Error(
        "M9 chapter exceeds video duration",
      );
    }

    const end = next
      ? next.startSeconds
      : durationSeconds;

    if (end - current.startSeconds < 10) {
      throw new Error(
        "M9 chapter duration must be at least ten seconds",
      );
    }
  }
}

function tagsLength(tags: readonly string[]): number {
  // YouTube counts the combined tag string,
  // including separators and quote overhead
  // for tags containing spaces.
  return tags.reduce(
    (total, tag, index) =>
      total +
      tag.length +
      (tag.includes(" ") ? 2 : 0) +
      (index > 0 ? 1 : 0),
    0,
  );
}

export function normalizeYoutubeMetadata(
  input: YoutubeMetadataInput,
  durationSeconds: number,
): YoutubeMetadata {
  const metadata =
    YoutubeMetadataInputSchema.parse(input);

  if (
    [...metadata.title].length > 100 ||
    /[<>]/.test(metadata.title)
  ) {
    throw new Error(
      "M9 YouTube title exceeds limit or contains prohibited characters",
    );
  }

  if (
    /[<>]/.test(metadata.description) ||
    Buffer.byteLength(
      metadata.description,
      "utf8",
    ) > 5000
  ) {
    throw new Error(
      "M9 YouTube description exceeds API limit",
    );
  }

  if (
    new Set(
      metadata.tags.map(
        (tag) => tag.toLowerCase(),
      ),
    ).size !== metadata.tags.length
  ) {
    throw new Error(
      "M9 duplicate YouTube tags",
    );
  }

  if (tagsLength(metadata.tags) > 500) {
    throw new Error(
      "M9 YouTube tags exceed limit",
    );
  }

  validateYoutubeChapters(
    metadata.chapters,
    durationSeconds,
  );

  const generatedChapters =
    formatYoutubeChapters(metadata.chapters);

  if (
    generatedChapters &&
    !metadata.description.includes(
      generatedChapters,
    )
  ) {
    const separator =
      metadata.description.trim().length > 0
        ? "\n\n"
        : "";

    metadata.description +=
      separator + generatedChapters;
  }

  // Validate the final description, including
  // any generated chapter timestamps.
  if (
    Buffer.byteLength(
      metadata.description,
      "utf8",
    ) > 5000
  ) {
    throw new Error(
      "M9 final description exceeds API limit",
    );
  }

  return metadata;
}

export function youtubeMetadataHash(
  metadata: YoutubeMetadata,
): string {
  return sha256(metadata);
}
