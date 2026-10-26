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

import { MediaAcquirer } from "./media-acquirer.js";
import { MediaObjectStore } from "./media-object-store.js";

import {
  MediaUsageRightsStore,
} from "./media-usage-rights-store.js";

import {
  StoredMediaAssetVerifier,
  StoredMediaRightsChecker,
} from "./media-production-adapters.js";

function pngBytes(): Buffer {
  // Lightweight PNG-header fixture accepted by the
  // existing M4 image probe. This is not a fully
  // decodable PNG and is not a renderer QA test.
  const bytes = Buffer.alloc(33);

  Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]).copy(bytes);

  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");

  bytes.writeUInt32BE(1280, 16);
  bytes.writeUInt32BE(720, 20);

  bytes[24] = 8;
  bytes[25] = 2;

  return bytes;
}

describe("Production media verification adapters", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-production-adapters-",
      ),
    );

    const sourceRoot = path.join(root, "uploads");
    const storageRoot = path.join(root, "store");

    await mkdir(sourceRoot);

    const localPath = path.join(
      sourceRoot,
      "test.png",
    );

    await writeFile(localPath, pngBytes());

    const acquirer = new MediaAcquirer({
      storageRoot,
      allowedLocalRoots: [sourceRoot],
    });

    const objectStore = new MediaObjectStore({
      storageRoot,
    });

    const rightsStore =
      new MediaUsageRightsStore(storageRoot);

    const source = {
      provider: "local_library" as const,
      id: "bank-test-image-001",
    };

    const acquired = await acquirer.acquire({
      id: source.id,
      provider: source.provider,
      kind: "image",
      description: "Test image",
      localPath,
      keywords: [],
    });

    const asset = await objectStore.register(
      source,
      {
        ...acquired,
        provenance: {
          ...acquired.provenance,
          source: source.provider,
          providerAssetId: source.id,
        },
      },
    );

    const verifier = new StoredMediaAssetVerifier(
      objectStore,
    );

    const rightsChecker =
      new StoredMediaRightsChecker({
        objectStore,
        rightsStore,
      });

    async function approve() {
      await rightsStore.save({
        source,
        assetHash: asset.sha256,
        intendedUse: "commercial_youtube",

        reviewer: "test-reviewer",
        reviewedAt:
          "2026-10-12T10:00:00.000Z",

        evidenceUrl:
          "https://example.com/test-evidence",

        commercialPermission: "confirmed",
        personRelease: "not_required",
        propertyRelease: "not_required",
        attribution: "not_required",
        notes: "Synthetic test-only approval",
      });
    }

    return {
      asset,
      source,
      verifier,
      rightsChecker,
      approve,
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

  it("verifies a content-addressed stored asset", async () => {
    const env = await setup();

    expect(
      await env.verifier.verify(env.asset),
    ).toBe(true);
  });

  it("rejects mismatched asset metadata", async () => {
    const env = await setup();

    expect(
      await env.verifier.verify({
        ...env.asset,
        sha256: "f".repeat(64),
      }),
    ).toBe(false);
  });

  it("does not approve assets without rights assessments", async () => {
    const env = await setup();

    expect(
      await env.rightsChecker.check(env.asset),
    ).toBe("review_required");
  });

  it("uses a persisted source-specific rights assessment", async () => {
    const env = await setup();

    await env.approve();

    expect(
      await env.rightsChecker.check(env.asset),
    ).toBe("approved");

    expect(
      await env.rightsChecker.check({
        ...env.asset,
        provenance: {
          ...env.asset.provenance,
          providerAssetId: "another-image",
        },
      }),
    ).toBe("review_required");
  });

  it("rejects rights checks for a different image hash", async () => {
    const env = await setup();

    await env.approve();

    expect(
      await env.rightsChecker.check({
        ...env.asset,
        sha256: "e".repeat(64),
      }),
    ).toBe("review_required");
  });
});
