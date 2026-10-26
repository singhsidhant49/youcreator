import {
  afterEach,
  describe,
  expect,
  it,
  vi,
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
  createHash,
} from "node:crypto";

import {
  MediaAcquirer,
} from "./media-acquirer.js";

import {
  inspectImageBytes,
} from "./media-image-probe.js";

import type {
  MediaCandidate,
} from "./media-resolver.js";

// Minimal PNG header fixture for structural
// inspection tests; not a decoded production image.
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

  bytes[24] = 8; // Bit depth
  bytes[25] = 2; // RGB color type

  return bytes;
}

function localCandidate(
  filename: string,
): MediaCandidate {
  return {
    id: "local-test-001",
    provider: "local_library",
    kind: "image",
    description: "Developer at a desk",
    localPath: filename,
    keywords: ["developer", "desk"],
  };
}

function remoteCandidate(): MediaCandidate {
  return {
    id: "pexels-photo-123",
    provider: "pexels",
    kind: "image",
    description: "Developer at a desk",
    sourceUrl:
      "https://images.pexels.com/photos/123/test.png",
    keywords: ["developer", "desk"],
    providerAssetId: "123",
    licenseName: "Pexels License",
  };
}

function response(
  bytes: Buffer,
  options: {
    status?: number;
    contentType?: string;
    contentLength?: string;
  } = {},
): Response {
  const status = options.status ?? 200;

  return new Response(
    new Uint8Array(bytes),
    {
      status,
      headers: {
        "content-type":
          options.contentType ?? "image/png",
        "content-length":
          options.contentLength ??
          String(bytes.length),
      },
    },
  );
}

describe("Media acquisition and integrity", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-acquirer-",
      ),
    );

    const sourceRoot = path.join(
      root,
      "source",
    );

    const storageRoot = path.join(
      root,
      "storage",
    );

    await mkdir(sourceRoot);

    return {
      sourceRoot,
      storageRoot,
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

  it("inspects PNG dimensions from bytes", () => {
    const result = inspectImageBytes(
      pngBytes(1920, 1080),
    );

    expect(result).toMatchObject({
      mimeType: "image/png",
      width: 1920,
      height: 1080,
    });
  });

  it("acquires a local image and verifies its SHA-256", async () => {
    const { sourceRoot, storageRoot } =
      await setup();

    const filename = path.join(
      sourceRoot,
      "image.png",
    );

    const bytes = pngBytes();

    await writeFile(filename, bytes);

    const acquirer = new MediaAcquirer({
      storageRoot,
      allowedLocalRoots: [sourceRoot],
    });

    const asset = await acquirer.acquire(
      localCandidate(filename),
    );

    const expectedHash = createHash("sha256")
      .update(bytes)
      .digest("hex");

    expect(asset.sha256).toBe(expectedHash);
    expect(asset.bytes).toBe(bytes.length);

    expect(asset.width).toBe(1920);
    expect(asset.height).toBe(1080);

    expect(asset.provenance.license.status)
      .toBe("unknown");

    expect(
      await readFile(asset.localPath),
    ).toEqual(bytes);
  });

  it("rejects local files outside approved roots", async () => {
    const { sourceRoot, storageRoot } =
      await setup();

    const outside = path.join(
      root!,
      "outside.png",
    );

    await writeFile(outside, pngBytes());

    const acquirer = new MediaAcquirer({
      storageRoot,
      allowedLocalRoots: [sourceRoot],
    });

    await expect(
      acquirer.acquire(
        localCandidate(outside),
      ),
    ).rejects.toThrow(
      "outside approved roots",
    );
  });

  it("downloads an approved HTTPS image through the injected client", async () => {
    const { storageRoot } = await setup();

    const bytes = pngBytes(1280, 720);

    const httpClient = vi.fn(
      async () => response(bytes),
    );

    const acquirer = new MediaAcquirer({
      storageRoot,
      httpClient: httpClient as typeof fetch,
    });

    const asset = await acquirer.acquire(
      remoteCandidate(),
    );

    expect(asset.provenance.source)
      .toBe("pexels");

    expect(asset.width).toBe(1280);
    expect(asset.height).toBe(720);

    expect(httpClient).toHaveBeenCalledTimes(1);

    const requestOptions =
      httpClient.mock.calls[0];

    expect(requestOptions).toBeDefined();
  });

  it("rejects remote URLs outside the allowlist", async () => {
    const { storageRoot } = await setup();

    const httpClient = vi.fn(
      async () => response(pngBytes()),
    );

    const acquirer = new MediaAcquirer({
      storageRoot,
      httpClient: httpClient as typeof fetch,
    });

    await expect(
      acquirer.acquire({
        ...remoteCandidate(),
        sourceUrl:
          "https://untrusted.example/private.png",
      }),
    ).rejects.toThrow(
      "Remote media URL is not permitted",
    );

    expect(httpClient).not.toHaveBeenCalled();
  });

  it("rejects oversized declared downloads", async () => {
    const { storageRoot } = await setup();

    const httpClient = vi.fn(
      async () => response(
        pngBytes(),
        {
          contentLength: "10000000",
        },
      ),
    );

    const acquirer = new MediaAcquirer({
      storageRoot,
      maxBytes: 1024,
      httpClient: httpClient as typeof fetch,
    });

    await expect(
      acquirer.acquire(
        remoteCandidate(),
      ),
    ).rejects.toThrow(
      "exceeds permitted size",
    );
  });

  it("rejects unsupported image bytes", async () => {
    const { sourceRoot, storageRoot } =
      await setup();

    const filename = path.join(
      sourceRoot,
      "fake.png",
    );

    await writeFile(
      filename,
      Buffer.from("not a real image"),
    );

    const acquirer = new MediaAcquirer({
      storageRoot,
      allowedLocalRoots: [sourceRoot],
    });

    await expect(
      acquirer.acquire(
        localCandidate(filename),
      ),
    ).rejects.toThrow(
      "Unsupported image format",
    );
  });

  it("reuses the same content-addressed file", async () => {
    const { sourceRoot, storageRoot } =
      await setup();

    const filename = path.join(
      sourceRoot,
      "duplicate.png",
    );

    await writeFile(
      filename,
      pngBytes(),
    );

    const acquirer = new MediaAcquirer({
      storageRoot,
      allowedLocalRoots: [sourceRoot],
    });

    const first = await acquirer.acquire(
      localCandidate(filename),
    );

    const second = await acquirer.acquire(
      localCandidate(filename),
    );

    expect(first.localPath).toBe(
      second.localPath,
    );

    expect(first.sha256).toBe(
      second.sha256,
    );
  });
});
