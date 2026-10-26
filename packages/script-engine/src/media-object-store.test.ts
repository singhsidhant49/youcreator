import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdtemp,
  mkdir,
  readFile,
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
  type MediaSourceIdentity,
} from "./media-object-store.js";

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

describe("MediaObjectStore", () => {
  let root: string | undefined;

  const source: MediaSourceIdentity = {
    provider: "local_library",
    id: "bank-one-image-001",
  };

  async function setup() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-object-store-",
      ),
    );

    const sourceRoot = path.join(root, "source");
    const storageRoot = path.join(root, "store");

    await mkdir(sourceRoot);

    const acquirer = new MediaAcquirer({
      storageRoot,
      allowedLocalRoots: [sourceRoot],
    });

    const store = new MediaObjectStore({
      storageRoot,
    });

    async function acquire(
      name = "image.png",
      bytes = pngBytes(),
    ) {
      const filename = path.join(
        sourceRoot,
        name,
      );

      await writeFile(filename, bytes);

      return acquirer.acquire({
        id: name.replace(/[^a-zA-Z0-9_-]/g, "-"),
        provider: "local_library",
        kind: "image",
        description: "Test image",
        localPath: filename,
        keywords: [],
      });
    }

    return {
      sourceRoot,
      storageRoot,
      acquirer,
      store,
      acquire,
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

  it("returns null for a source that has not been registered", async () => {
    const env = await setup();

    expect(
      await env.store.lookup(source),
    ).toBeNull();
  });

  it("registers and reloads a verified media asset", async () => {
    const env = await setup();

    const asset = await env.acquire();

    const registered = await env.store.register(
      source,
      asset,
    );

    const loaded = await env.store.lookup(
      source,
    );

    expect(registered.sha256).toBe(asset.sha256);
    expect(loaded).toEqual(registered);
    expect(loaded?.localPath).toBe(
      asset.localPath,
    );
  });

  it("reuses an existing source mapping without rewriting it", async () => {
    const env = await setup();

    const first = await env.acquire();

    const registered = await env.store.register(
      source,
      first,
    );

    const second = await env.store.register(
      source,
      first,
    );

    expect(second).toEqual(registered);
  });

  it("allows two sources to reference identical content", async () => {
    const env = await setup();

    const asset = await env.acquire();

    const secondSource: MediaSourceIdentity = {
      provider: "local_library",
      id: "bank-two-image-001",
    };

    await env.store.register(
      source,
      asset,
    );

    await env.store.register(
      secondSource,
      asset,
    );

    const firstLookup = await env.store.lookup(
      source,
    );

    const secondLookup = await env.store.lookup(
      secondSource,
    );

    expect(firstLookup?.sha256).toBe(
      secondLookup?.sha256,
    );

    expect(firstLookup?.localPath).toBe(
      secondLookup?.localPath,
    );
  });

  it("rejects a source identity changing to different image bytes", async () => {
    const env = await setup();

    const first = await env.acquire(
      "first.png",
      pngBytes(1920, 1080),
    );

    const second = await env.acquire(
      "second.png",
      pngBytes(1280, 720),
    );

    await env.store.register(source, first);

    await expect(
      env.store.register(source, second),
    ).rejects.toThrow(
      "already maps to different media",
    );
  });

  it("detects corruption of previously stored media bytes", async () => {
    const env = await setup();

    const asset = await env.acquire();

    await env.store.register(
      source,
      asset,
    );

    const bytes = await readFile(
      asset.localPath,
    );

    bytes[20] = bytes[20]! ^ 0xff;

    await writeFile(
      asset.localPath,
      bytes,
    );

    await expect(
      env.store.lookup(source),
    ).rejects.toThrow();
  });

  it("detects corrupted source receipt metadata", async () => {
    const env = await setup();

    const asset = await env.acquire();

    await env.store.register(
      source,
      asset,
    );

    // Locate the sole source manifest using the exact
    // source-key algorithm. This test intentionally
    // corrupts the persisted receipt on disk.
    const { createHash } = await import("node:crypto");

    const key = createHash("sha256")
      .update(
        JSON.stringify([
          source.provider,
          source.id,
        ]),
      )
      .digest("hex");

    const filename = path.join(
      env.storageRoot,
      "manifests",
      "sources",
      key.slice(0, 2),
      `${key}.json`,
    );

    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        invalid: true,
      }),
    );

    await expect(
      env.store.lookup(source),
    ).rejects.toThrow();
  });

  it("rejects asset metadata that does not agree with stored bytes", async () => {
    const env = await setup();

    const asset = await env.acquire();

    await expect(
      env.store.register(
        source,
        {
          ...asset,
          width: asset.width + 1,
        },
      ),
    ).rejects.toThrow(
      "Stored media metadata mismatch",
    );
  });
});
