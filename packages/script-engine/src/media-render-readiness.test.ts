import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import type { MediaAsset } from "@youcreator/contracts";

import {
  verifyImageRenderReadiness,
} from "./media-render-readiness.js";

const DATE = "2026-10-13T10:00:00.000Z";

function sha256(bytes: Buffer): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}

describe("Full image render readiness", () => {
  let root: string | undefined;

  async function createFixture(
    format: "png" | "jpeg" = "png",
    width = 1280,
    height = 720,
  ): Promise<{
    asset: MediaAsset;
    bytes: Buffer;
  }> {
    root ??= await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-m5-decode-",
      ),
    );

    const bytes = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: "#657b93",
      },
    })
      .toFormat(format)
      .toBuffer();

    const filename = path.join(
      root,
      `fixture-${format}-${width}-${height}.${format}`,
    );

    await writeFile(filename, bytes);

    return {
      bytes,

      asset: {
        version: 1,
        id: `asset-${format}`,
        kind: "image",
        localPath: filename,
        sha256: sha256(bytes),
        bytes: bytes.length,
        mimeType:
          format === "png"
            ? "image/png"
            : "image/jpeg",
        width,
        height,

        provenance: {
          source: "local_library",
          providerAssetId: `test-${format}`,
          license: {
            status: "unknown",
          },
        },

        createdAt: DATE,
      },
    };
  }

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });

      root = undefined;
    }
  });

  it("accepts a fully decodable PNG", async () => {
    const { asset } = await createFixture();

    const report = await verifyImageRenderReadiness(
      asset,
    );

    expect(report.ready).toBe(true);
    expect(report.format).toBe("png");
    expect(report.width).toBe(1280);
    expect(report.height).toBe(720);
    expect(report.decodedPixels).toBe(921600);
  });

  it("accepts a fully decodable JPEG", async () => {
    const { asset } =
      await createFixture("jpeg");

    const report = await verifyImageRenderReadiness(
      asset,
    );

    expect(report.ready).toBe(true);
    expect(report.format).toBe("jpeg");
  });

  it("rejects a header-only PNG with a valid hash", async () => {
    const { asset, bytes } =
      await createFixture();

    const incomplete = bytes.subarray(0, 33);

    await writeFile(
      asset.localPath,
      incomplete,
    );

    const modifiedAsset = {
      ...asset,
      bytes: incomplete.length,
      sha256: sha256(incomplete),
    };

    const report = await verifyImageRenderReadiness(
      modifiedAsset,
    );

    expect(report.ready).toBe(false);

    expect(report.issues.some(
      (item) =>
        item.code === "DECODE_FAILED",
    )).toBe(true);
  });

  it("rejects altered image bytes", async () => {
    const { asset } =
      await createFixture();

    await writeFile(
      asset.localPath,
      Buffer.from("corrupted"),
    );

    const report = await verifyImageRenderReadiness(
      asset,
    );

    expect(report.ready).toBe(false);

    expect(report.issues[0]?.code).toBe(
      "HASH_MISMATCH",
    );
  });

  it("rejects mismatched decoded dimensions", async () => {
    const { asset } =
      await createFixture();

    const report = await verifyImageRenderReadiness({
      ...asset,
      width: 1920,
    });

    expect(report.ready).toBe(false);

    expect(report.issues.some(
      (item) =>
        item.code === "DIMENSION_MISMATCH",
    )).toBe(true);
  });

  it("rejects images below minimum resolution", async () => {
    const { asset } =
      await createFixture("png", 320, 180);

    const report = await verifyImageRenderReadiness(
      asset,
    );

    expect(report.ready).toBe(false);

    expect(report.issues.some(
      (item) =>
        item.code === "INSUFFICIENT_RESOLUTION",
    )).toBe(true);
  });
});
