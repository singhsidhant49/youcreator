import { createHash } from "node:crypto";
import { z } from "zod";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const PositiveInt = z.number().int().safe().positive();

export const ExportMetadataSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).default(""),
  tags: z.array(z.string().trim().min(1))
    .max(100).default([]),
  language: z.string().min(2).default("en"),
}).strict();

export type ExportMetadata =
  z.infer<typeof ExportMetadataSchema>;

export const ExportFileSchema = z.object({
  filename: z.enum([
    "video.mp4",
    "subtitles.srt",
    "subtitles.vtt",
    "metadata.json",
    "qa-report.json",
    "thumbnail.png",
  ]),
  sha256: Hash,
  bytes: z.number().int().safe().nonnegative(),
}).strict();

export type ExportFile = z.infer<
  typeof ExportFileSchema
>;

export const VideoExportManifestSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  releaseHash: Hash,
  compositionHash: Hash,
  captionPlanHash: Hash,
  videoSha256: Hash,
  qaReportHash: Hash,
  metadataHash: Hash,
  fps: PositiveInt,
  totalFrames: PositiveInt,
  width: PositiveInt,
  height: PositiveInt,
  files: z.array(ExportFileSchema).min(5),
  exportHash: Hash,
}).strict();

export type VideoExportManifest = z.infer<
  typeof VideoExportManifestSchema
>;

export function exportSha256(
  bytes: Buffer | string,
): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}

export function createVideoExportManifest(
  input: Omit<
    VideoExportManifest,
    "exportHash"
  >,
): VideoExportManifest {
  const payload = {
    ...input,
    files: [...input.files].sort(
      (a, b) =>
        a.filename.localeCompare(b.filename),
    ),
  };

  const names = payload.files.map(
    (file) => file.filename,
  );

  const required: readonly ExportFile["filename"][] = [
    "video.mp4",
    "subtitles.srt",
    "subtitles.vtt",
    "metadata.json",
    "qa-report.json",
  ];

  if (
    new Set(names).size !== names.length ||
    required.some((name) => !names.includes(name))
  ) {
    throw new Error(
      "M9 export file inventory invalid",
    );
  }

  return VideoExportManifestSchema.parse({
    ...payload,
    exportHash: exportSha256(
      JSON.stringify(payload),
    ),
  });
}

export function verifyVideoExportManifest(
  candidate: unknown,
): VideoExportManifest {
  const saved = VideoExportManifestSchema.parse(
    candidate,
  );

  const { exportHash, ...payload } = saved;
  const canonical =
    createVideoExportManifest(payload);

  if (
    JSON.stringify(saved) !==
    JSON.stringify(canonical)
  ) {
    throw new Error(
      "M9 export manifest integrity mismatch",
    );
  }

  return saved;
}
