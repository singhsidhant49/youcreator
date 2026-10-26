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
  symlink,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  LocalImageBankProvider,
} from "./local-image-bank.js";

import {
  MediaResolver,
} from "./media-resolver.js";

import {
  planVisualContinuity,
} from "./visual-continuity.js";

import {
  createSceneMediaPlan,
} from "./scene-media-plan.js";

import {
  storyboard,
} from "./visual-continuity.test-fixture.js";

const continuity = planVisualContinuity(
  storyboard,
  "documentary",
);

const mediaPlan = createSceneMediaPlan(
  storyboard,
  continuity,
  "B",
);

const requirement = mediaPlan.shots[0]!;

const context = {
  jobId: "job-001",
  mode: "B" as const,
  maxCandidatesPerProvider: 10,
};

const images = [
  {
    id: "desk-001",
    file: "images/desk.jpg",
    description:
      "A person working at a desk with a laptop",
    tags: ["person", "desk", "working"],
    keywords: ["office", "computer"],
    width: 1920,
    height: 1080,
  },
  {
    id: "server-001",
    file: "images/server.jpg",
    description:
      "Modern servers in a cloud computing data center",
    tags: ["server", "cloud"],
    keywords: ["infrastructure"],
    width: 1920,
    height: 1080,
  },
];

describe("Local image bank discovery", () => {
  let root: string | undefined;

  async function setup(
    entries: typeof images = images,
  ) {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-bank-"),
    );

    await mkdir(
      path.join(root, "images"),
      { recursive: true },
    );

    for (const entry of entries) {
      await writeFile(
        path.join(root, entry.file),
        "test-image-bytes",
      );
    }

    await writeFile(
      path.join(root, "index.json"),
      JSON.stringify({
        version: 1,
        category: "technology",
        images: entries,
      }),
    );

    return root;
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

  it("discovers a relevant local image", async () => {
    const directory = await setup();

    const provider =
      await LocalImageBankProvider.create({
        directories: [directory],
      });

    const results = await provider.search(
      requirement,
      context,
    );

    expect(results[0]?.id).toBe("desk-001");
    expect(results[0]?.provider).toBe(
      "local_library",
    );
  });

  it("ranks matching images ahead of unrelated images", async () => {
    const directory = await setup();

    const provider =
      await LocalImageBankProvider.create({
        directories: [directory],
      });

    const results = await provider.search(
      requirement,
      context,
    );

    expect(results[0]?.id).toBe("desk-001");
    expect(results.some(
      (result) => result.id === "server-001",
    )).toBe(false);
  });

  it("integrates with MediaResolver", async () => {
    const directory = await setup();

    const provider =
      await LocalImageBankProvider.create({
        directories: [directory],
      });

    const resolver = new MediaResolver([
      provider,
    ]);

    const result = await resolver.discover(
      requirement,
      {
        jobId: "job-001",
        mode: "B",
      },
    );

    expect(result.status).toBe(
      "candidates_found",
    );

    expect(result.candidates[0]?.id).toBe(
      "desk-001",
    );
  });

  it("does not search for video-only requirements", async () => {
    const directory = await setup();

    const provider =
      await LocalImageBankProvider.create({
        directories: [directory],
      });

    expect(
      provider.supports(
        {
          ...requirement,
          preferredMediaKind: "video",
        },
        context,
      ),
    ).toBe(false);
  });

  it("skips missing image files", async () => {
    const directory = await setup();

    await rm(
      path.join(
        directory,
        "images/desk.jpg",
      ),
    );

    const provider =
      await LocalImageBankProvider.create({
        directories: [directory],
      });

    const results = await provider.search(
      requirement,
      context,
    );

    expect(results.some(
      (result) => result.id === "desk-001",
    )).toBe(false);
  });

  it("rejects path traversal", async () => {
    const directory = await setup([]);

    await writeFile(
      path.join(directory, "index.json"),
      JSON.stringify({
        version: 1,
        category: "technology",
        images: [{
          ...images[0],
          file: "../outside.jpg",
        }],
      }),
    );

    await expect(
      LocalImageBankProvider.create({
        directories: [directory],
      }),
    ).rejects.toThrow();
  });

  it("rejects symlinks escaping the image bank", async () => {
    const directory = await setup([]);

    const outside = path.join(
      os.tmpdir(),
      `youcreator-outside-${Date.now()}.jpg`,
    );

    try {
      await writeFile(
        outside,
        "outside-bytes",
      );

      await symlink(
        outside,
        path.join(
          directory,
          "images/escaped.jpg",
        ),
      );

      await writeFile(
        path.join(directory, "index.json"),
        JSON.stringify({
          version: 1,
          category: "technology",
          images: [{
            ...images[0],
            file: "images/escaped.jpg",
          }],
        }),
      );

      await expect(
        LocalImageBankProvider.create({
          directories: [directory],
        }),
      ).rejects.toThrow(
        "escapes root",
      );
    } finally {
      await rm(outside, {
        force: true,
      });
    }
  });

  it("rejects malformed image metadata", async () => {
    const directory = await setup([]);

    await writeFile(
      path.join(directory, "index.json"),
      JSON.stringify({
        version: 1,
        category: "technology",
        images: [{
          ...images[0],
          width: -100,
        }],
      }),
    );

    await expect(
      LocalImageBankProvider.create({
        directories: [directory],
      }),
    ).rejects.toThrow();
  });
});
