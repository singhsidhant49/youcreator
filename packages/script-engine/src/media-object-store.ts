import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  MediaAssetSchema,
  MediaSourceSchema,
  type MediaAsset,
} from "@youcreator/contracts";

import {
  inspectImageBytes,
} from "./media-image-probe.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const MediaSourceIdentitySchema = z.object({
  provider: MediaSourceSchema,
  id: z.string().trim().min(1).max(512),
}).strict();

export type MediaSourceIdentity = z.infer<
  typeof MediaSourceIdentitySchema
>;

export const MediaObjectRecordSchema = z.object({
  version: z.literal(1),
  sha256: HashSchema,
  bytes: z.number().int().positive(),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  createdAt: z.string().datetime(),
}).strict();

export const MediaSourceReceiptSchema = z.object({
  version: z.literal(1),
  source: MediaSourceIdentitySchema,
  sourceKey: HashSchema,
  objectHash: HashSchema,
  asset: MediaAssetSchema,
  createdAt: z.string().datetime(),
}).strict();

export type MediaSourceReceipt = z.infer<
  typeof MediaSourceReceiptSchema
>;

export interface MediaObjectStoreOptions {
  storageRoot: string;
  maxBytes?: number;
  maxPixels?: number;
}

function sha256(
  value: Buffer | string,
): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isExisting(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

/**
 * True: published new file.
 * False: final path already exists.
 *
 * All manifest writes are create-only.
 */
async function publishJson(
  filename: string,
  value: unknown,
): Promise<boolean> {
  const directory = path.dirname(filename);

  await mkdir(directory, {
    recursive: true,
  });

  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );

  await writeFile(
    temporary,
    JSON.stringify(value, null, 2),
    { flag: "wx" },
  );

  try {
    try {
      await link(temporary, filename);
      return true;
    } catch (error) {
      if (isExisting(error)) {
        return false;
      }

      throw error;
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) {
        throw error;
      }
    });
  }
}

export class MediaObjectStore {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly maxPixels: number;

  constructor(options: MediaObjectStoreOptions) {
    if (!options.storageRoot.trim()) {
      throw new Error("storageRoot is required");
    }

    this.root = path.resolve(options.storageRoot);

    this.maxBytes =
      options.maxBytes ?? 15 * 1024 * 1024;

    this.maxPixels =
      options.maxPixels ?? 50_000_000;

    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      !Number.isSafeInteger(this.maxPixels) ||
      this.maxPixels < 1
    ) {
      throw new Error(
        "Invalid media storage verification limits",
      );
    }
  }

  private sourceKey(
    source: MediaSourceIdentity,
  ): string {
    const parsed =
      MediaSourceIdentitySchema.parse(source);

    return sha256(
      JSON.stringify([
        parsed.provider,
        parsed.id,
      ]),
    );
  }

  private objectPath(
    hash: string,
    mimeType: string,
  ): string {
    HashSchema.parse(hash);

    const extension =
      mimeType === "image/png"
        ? "png"
        : mimeType === "image/jpeg"
          ? "jpg"
          : null;

    if (!extension) {
      throw new Error(
        "Unsupported stored media MIME type",
      );
    }

    return path.join(
      this.root,
      "objects",
      hash.slice(0, 2),
      `${hash}.${extension}`,
    );
  }

  private objectRecordPath(
    hash: string,
  ): string {
    HashSchema.parse(hash);

    return path.join(
      this.root,
      "manifests",
      "objects",
      hash.slice(0, 2),
      `${hash}.json`,
    );
  }

  private receiptPath(
    source: MediaSourceIdentity,
  ): string {
    const key = this.sourceKey(source);

    return path.join(
      this.root,
      "manifests",
      "sources",
      key.slice(0, 2),
      `${key}.json`,
    );
  }

  private async verifyAsset(
    input: MediaAsset,
  ): Promise<MediaAsset> {
    const asset = MediaAssetSchema.parse(input);

    if (asset.kind !== "image") {
      throw new Error(
        "MediaObjectStore currently supports images only",
      );
    }

    const expectedPath = this.objectPath(
      asset.sha256,
      asset.mimeType,
    );

    if (
      path.resolve(asset.localPath) !== expectedPath
    ) {
      throw new Error(
        "Media asset path does not match content address",
      );
    }

    const details = await stat(expectedPath);

    if (
      !details.isFile() ||
      details.size < 1 ||
      details.size > this.maxBytes ||
      details.size !== asset.bytes
    ) {
      throw new Error(
        "Stored media size mismatch",
      );
    }

    const bytes = await readFile(expectedPath);

    if (
      bytes.length !== asset.bytes ||
      sha256(bytes) !== asset.sha256
    ) {
      throw new Error(
        "Stored media SHA-256 mismatch",
      );
    }

    const image = inspectImageBytes(
      bytes,
      this.maxPixels,
    );

    if (
      image.mimeType !== asset.mimeType ||
      image.width !== asset.width ||
      image.height !== asset.height
    ) {
      throw new Error(
        "Stored media metadata mismatch",
      );
    }

    return asset;
  }

  private async readReceipt(
    source: MediaSourceIdentity,
  ): Promise<MediaSourceReceipt | null> {
    const filename = this.receiptPath(source);

    let raw: string;

    try {
      raw = await readFile(filename, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }

      throw error;
    }

    const receipt = MediaSourceReceiptSchema.parse(
      JSON.parse(raw),
    );

    const expectedKey = this.sourceKey(source);

    if (
      receipt.sourceKey !== expectedKey ||
      receipt.source.provider !== source.provider ||
      receipt.source.id !== source.id ||
      receipt.objectHash !== receipt.asset.sha256 ||
      receipt.asset.provenance.source !==
        source.provider
    ) {
      throw new Error(
        "Stored media source receipt mismatch",
      );
    }

    return receipt;
  }

  private async verifyObjectRecord(
    asset: MediaAsset,
  ): Promise<void> {
    const filename = this.objectRecordPath(
      asset.sha256,
    );

    const parsed = MediaObjectRecordSchema.parse(
      JSON.parse(
        await readFile(filename, "utf8"),
      ),
    );

    if (
      parsed.sha256 !== asset.sha256 ||
      parsed.bytes !== asset.bytes ||
      parsed.mimeType !== asset.mimeType ||
      parsed.width !== asset.width ||
      parsed.height !== asset.height
    ) {
      throw new Error(
        "Stored media object manifest mismatch",
      );
    }
  }

  /**
   * Find an existing source mapping.
   *
   * No external provider requests are performed.
   * Corrupted receipts or objects fail rather than
   * being silently discarded.
   */
  async lookup(
    input: MediaSourceIdentity,
  ): Promise<MediaAsset | null> {
    const source =
      MediaSourceIdentitySchema.parse(input);

    const receipt = await this.readReceipt(source);

    if (!receipt) {
      return null;
    }

    const asset = await this.verifyAsset(
      receipt.asset,
    );

    await this.verifyObjectRecord(asset);

    return asset;
  }

  /**
   * Register a previously acquired content-addressed
   * image without mutating its bytes.
   *
   * The same source identity must never silently change
   * to a different content hash.
   */
  async register(
    inputSource: MediaSourceIdentity,
    inputAsset: MediaAsset,
  ): Promise<MediaAsset> {
    const source =
      MediaSourceIdentitySchema.parse(inputSource);

    const asset = await this.verifyAsset(
      inputAsset,
    );

    if (
      asset.provenance.source !== source.provider
    ) {
      throw new Error(
        "Asset provenance does not match source identity",
      );
    }

    const existing = await this.readReceipt(
      source,
    );

    if (existing) {
      const stored = await this.lookup(source);

      if (
        !stored ||
        stored.sha256 !== asset.sha256
      ) {
        throw new Error(
          "Source identity already maps to different media",
        );
      }

      return stored;
    }

    const objectRecord = MediaObjectRecordSchema.parse({
      version: 1,
      sha256: asset.sha256,
      bytes: asset.bytes,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      createdAt: new Date().toISOString(),
    });

    await publishJson(
      this.objectRecordPath(asset.sha256),
      objectRecord,
    );

    // Whether newly created or already present,
    // the object manifest must verify.
    await this.verifyObjectRecord(asset);

    const receipt = MediaSourceReceiptSchema.parse({
      version: 1,
      source,
      sourceKey: this.sourceKey(source),
      objectHash: asset.sha256,
      asset,
      createdAt: new Date().toISOString(),
    });

    const published = await publishJson(
      this.receiptPath(source),
      receipt,
    );

    if (!published) {
      // Another process may have registered the source
      // concurrently. Re-read and verify the winner.
      const winner = await this.lookup(source);

      if (
        !winner ||
        winner.sha256 !== asset.sha256
      ) {
        throw new Error(
          "Concurrent media source registration conflict",
        );
      }

      return winner;
    }

    return asset;
  }
}
