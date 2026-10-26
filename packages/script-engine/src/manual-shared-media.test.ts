import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  MediaAcquirer,
} from "./media-acquirer.js";

import {
  MediaObjectStore,
} from "./media-object-store.js";

import {
  ManualSharedMediaService,
} from "./manual-shared-media.js";

function pngBytes(
  width = 1920,
  height = 1080,
): Buffer {
  const bytes = Buffer.alloc(33);

  Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]).copy(bytes, 0);

  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 2;

  return bytes;
}

describe("Manual & shared media modes", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-manual-media-",
      ),
    );

    const sourceRoot = path.join(
      root,
      "uploads",
    );

    const storageRoot = path.join(
      root,
      "store",
    );

    await mkdir(sourceRoot);

    const acquirer = new MediaAcquirer({
      storageRoot,
      allowedLocalRoots: [sourceRoot],
    });

    const objectStore = new MediaObjectStore({
      storageRoot,
    });

    const service = new ManualSharedMediaService({
      acquirer,
      objectStore,
    });

    async function upload(
      name: string,
      width = 1920,
      height = 1080,
    ) {
      const filename = path.join(
        sourceRoot,
        name,
      );

      await writeFile(
        filename,
        pngBytes(width, height),
      );

      return filename;
    }

    return {
      sourceRoot,
      storageRoot,
      service,
      objectStore,
      upload,
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

  it("assigns one shared background to multiple shots", async () => {
    const env = await setup();

    const filename = await env.upload(
      "background.png",
    );

    const results =
      await env.service.assignSharedBackground({
        mode: "A",
        backgroundId: "ambient-background-001",
        localPath: filename,
        shotIds: [
          "shot-001",
          "shot-002",
          "shot-003",
        ],
      });

    expect(results).toHaveLength(3);

    expect(results.every(
      (result) => result.status === "assigned",
    )).toBe(true);

    const hashes = results.flatMap(
      (result) =>
        result.status === "assigned"
          ? [result.assignment.asset.sha256]
          : [],
    );

    expect(new Set(hashes).size).toBe(1);
  });

  it("assigns different manual images to different shots", async () => {
    const env = await setup();

    const first = await env.upload(
      "first.png",
      1920,
      1080,
    );

    const second = await env.upload(
      "second.png",
      1280,
      720,
    );

    const results =
      await env.service.assignManualMedia({
        mode: "D",
        assignments: [
          {
            shotId: "shot-001",
            assetId: "manual-001",
            localPath: first,
          },
          {
            shotId: "shot-002",
            assetId: "manual-002",
            localPath: second,
          },
        ],
      });

    expect(results).toHaveLength(2);

    expect(results.every(
      (result) => result.status === "assigned",
    )).toBe(true);
  });

  it("reuses existing background storage without re-acquisition", async () => {
    const env = await setup();

    const filename = await env.upload(
      "background.png",
    );

    const first =
      await env.service.assignSharedBackground({
        mode: "A",
        backgroundId: "shared-001",
        localPath: filename,
        shotIds: ["shot-001"],
      });

    const second =
      await env.service.assignSharedBackground({
        mode: "A",
        backgroundId: "shared-001",
        localPath: filename,
        shotIds: ["shot-002"],
      });

    expect(
      first[0]?.status,
    ).toBe("assigned");

    expect(
      second[0]?.status,
    ).toBe("assigned");

    if (
      first[0]?.status === "assigned" &&
      second[0]?.status === "assigned"
    ) {
      expect(
        first[0].assignment.asset.localPath,
      ).toBe(
        second[0].assignment.asset.localPath,
      );
    }
  });

  it("reports missing manual assets without failing the whole batch", async () => {
    const env = await setup();

    const valid = await env.upload(
      "valid.png",
    );

    const missing = path.join(
      env.sourceRoot,
      "missing.png",
    );

    const results =
      await env.service.assignManualMedia({
        mode: "D",
        assignments: [
          {
            shotId: "shot-001",
            assetId: "manual-valid",
            localPath: valid,
          },
          {
            shotId: "shot-002",
            assetId: "manual-missing",
            localPath: missing,
          },
        ],
      });

    expect(results[0]?.status).toBe("assigned");

    expect(results[1]).toMatchObject({
      status: "unresolved",
      shotId: "shot-002",
      reason: "INVALID_ASSET",
    });
  });

  it("rejects duplicate shot assignments", async () => {
    const env = await setup();

    const filename = await env.upload(
      "duplicate.png",
    );

    await expect(
      env.service.assignManualMedia({
        mode: "D",
        assignments: [
          {
            shotId: "shot-001",
            assetId: "manual-001",
            localPath: filename,
          },
          {
            shotId: "shot-001",
            assetId: "manual-002",
            localPath: filename,
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("rejects files outside approved local roots", async () => {
    const env = await setup();

    const outside = path.join(
      root!,
      "outside.png",
    );

    await writeFile(
      outside,
      pngBytes(),
    );

    const results =
      await env.service.assignManualMedia({
        mode: "D",
        assignments: [
          {
            shotId: "shot-001",
            assetId: "outside-001",
            localPath: outside,
          },
        ],
      });

    expect(results[0]).toMatchObject({
      status: "unresolved",
      shotId: "shot-001",
      reason: "INVALID_ASSET",
    });
  });

  it("preserves logical source provenance for manual uploads", async () => {
    const env = await setup();

    const filename = await env.upload(
      "manual.png",
    );

    const results =
      await env.service.assignManualMedia({
        mode: "D",
        assignments: [
          {
            shotId: "shot-001",
            assetId: "manual-001",
            localPath: filename,
          },
        ],
      });

    expect(results[0]?.status).toBe("assigned");

    if (results[0]?.status === "assigned") {
      expect(
        results[0].assignment.asset.provenance.source,
      ).toBe("manual_upload");
    }
  });

  it("rejects invalid shared background requests", async () => {
    const env = await setup();

    const filename = await env.upload(
      "background.png",
    );

    await expect(
      env.service.assignSharedBackground({
        mode: "A",
        backgroundId: "shared-001",
        localPath: filename,
        shotIds: [
          "shot-001",
          "shot-001",
        ],
      }),
    ).rejects.toThrow();
  });
});
