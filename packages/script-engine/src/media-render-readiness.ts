import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";

import sharp from "sharp";
import { z } from "zod";

import { MediaAssetSchema } from "@youcreator/contracts";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ImageRenderReadinessSchema = z.object({
  version: z.literal(1),
  assetId: z.string().min(1),
  sha256: HashSchema,

  ready: z.boolean(),

  format: z.enum(["png", "jpeg"]).nullable(),

  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),

  decodedPixels: z.number().int().nonnegative(),

  issues: z.array(z.object({
    code: z.enum([
      "INVALID_ASSET",
      "UNSUPPORTED_FORMAT",
      "FILE_NOT_FOUND",
      "FILE_TOO_LARGE",
      "HASH_MISMATCH",
      "DIMENSION_MISMATCH",
      "DECODE_FAILED",
      "PIXEL_LIMIT_EXCEEDED",
      "INSUFFICIENT_RESOLUTION",
    ]),
    message: z.string().min(1),
  }).strict()),
}).strict();

export type ImageRenderReadiness = z.infer<
  typeof ImageRenderReadinessSchema
>;

export interface MediaRenderReadinessOptions {
  maxFileBytes?: number;
  maxPixels?: number;
  minimumWidth?: number;
  minimumHeight?: number;
}

const DEFAULTS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxPixels: 40_000_000,
  minimumWidth: 640,
  minimumHeight: 360,
};

type Issue = ImageRenderReadiness["issues"][number];

function digest(bytes: Buffer): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}

function issue(
  code: Issue["code"],
  message: string,
): Issue {
  return { code, message };
}

export async function verifyImageRenderReadiness(
  input: unknown,
  options: MediaRenderReadinessOptions = {},
): Promise<ImageRenderReadiness> {
  const parsed = MediaAssetSchema.safeParse(input);

  if (!parsed.success) {
    throw new Error("Invalid canonical MediaAsset");
  }

  const asset = parsed.data;

  const config = {
    ...DEFAULTS,
    ...options,
  };

  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid decoder limit: ${key}`);
    }
  }

  const issues: Issue[] = [];

  let format: "png" | "jpeg" | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let decodedPixels = 0;

  function finish(): ImageRenderReadiness {
    return ImageRenderReadinessSchema.parse({
      version: 1,
      assetId: asset.id,
      sha256: asset.sha256,

      ready: issues.length === 0,

      format,
      width,
      height,
      decodedPixels,
      issues,
    });
  }

  if (
    asset.kind !== "image" ||
    !["image/png", "image/jpeg"].includes(asset.mimeType)
  ) {
    issues.push(issue(
      "UNSUPPORTED_FORMAT",
      "Renderer readiness currently supports PNG and JPEG images only",
    ));

    return finish();
  }

  let bytes: Buffer;

  try {
    const info = await stat(asset.localPath);

    if (!info.isFile()) {
      throw new Error("Asset path is not a regular file");
    }

    if (info.size > config.maxFileBytes) {
      issues.push(issue(
        "FILE_TOO_LARGE",
        "Media file exceeds the configured decoder byte limit",
      ));

      return finish();
    }

    // Verify that the file exists at the stored path.
    await realpath(asset.localPath);

    bytes = await readFile(asset.localPath);
  } catch {
    issues.push(issue(
      "FILE_NOT_FOUND",
      "Stored media file is missing or unreadable",
    ));

    return finish();
  }

  if (bytes.length > config.maxFileBytes) {
    issues.push(issue(
      "FILE_TOO_LARGE",
      "Media file exceeds the configured decoder byte limit",
    ));

    return finish();
  }

  if (
    bytes.length !== asset.bytes ||
    digest(bytes) !== asset.sha256
  ) {
    issues.push(issue(
      "HASH_MISMATCH",
      "Actual media bytes do not match the stored asset identity",
    ));

    return finish();
  }

  try {
    const image = sharp(bytes, {
      failOn: "error",
      limitInputPixels: config.maxPixels,
      animated: false,
      sequentialRead: true,
    });

    const metadata = await image.metadata();

    if (
      metadata.format !== "png" &&
      metadata.format !== "jpeg"
    ) {
      issues.push(issue(
        "UNSUPPORTED_FORMAT",
        "Decoded media format is not PNG or JPEG",
      ));

      return finish();
    }

    format = metadata.format;
    width = metadata.width ?? null;
    height = metadata.height ?? null;

    if (
      width === null ||
      height === null
    ) {
      issues.push(issue(
        "DECODE_FAILED",
        "Image decoder could not determine dimensions",
      ));

      return finish();
    }

    const expectedMime =
      format === "png"
        ? "image/png"
        : "image/jpeg";

    if (asset.mimeType !== expectedMime) {
      issues.push(issue(
        "UNSUPPORTED_FORMAT",
        "Decoded image format disagrees with stored MIME type",
      ));
    }

    if (
      width !== asset.width ||
      height !== asset.height
    ) {
      issues.push(issue(
        "DIMENSION_MISMATCH",
        "Decoded dimensions disagree with verified asset metadata",
      ));
    }

    if (
      width * height > config.maxPixels
    ) {
      issues.push(issue(
        "PIXEL_LIMIT_EXCEEDED",
        "Image exceeds configured decoded-pixel limit",
      ));

      return finish();
    }

    if (
      width < config.minimumWidth ||
      height < config.minimumHeight
    ) {
      issues.push(issue(
        "INSUFFICIENT_RESOLUTION",
        "Image resolution is below the renderer minimum",
      ));
    }

    // Force a FULL raster decode.
    // metadata() alone does not validate the pixel stream.
    //
    // A 1x1 output minimizes retained output memory;
    // the decoder must still process the source image.
    await sharp(bytes, {
      failOn: "error",
      limitInputPixels: config.maxPixels,
      animated: false,
    })
      .resize(1, 1, { fit: "fill" })
      .raw()
      .toBuffer();

    decodedPixels = width * height;
  } catch (error) {
    issues.push(issue(
      "DECODE_FAILED",
      error instanceof Error
        ? error.message
        : "Unknown image decoding failure",
    ));
  }

  return finish();
}
