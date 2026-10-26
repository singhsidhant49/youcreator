import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  getStoryboardLockPath,
  withStoryboardGenerationLock,
} from "./storyboard-generation-lock.js";

describe("Storyboard generation locking", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-storyboard-lock-",
      ),
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

  it("runs an operation and releases its lock", async () => {
    const directory = await setup();

    const result = await withStoryboardGenerationLock(
      directory,
      "job-001",
      async () => "completed",
    );

    expect(result).toBe("completed");

    await expect(
      stat(
        getStoryboardLockPath(
          directory,
          "job-001",
        ),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks a second concurrent execution", async () => {
    const directory = await setup();

    let releaseFirst!: () => void;

    const firstCanFinish = new Promise<void>(
      (resolve) => {
        releaseFirst = resolve;
      },
    );

    let markStarted!: () => void;

    const firstStarted = new Promise<void>(
      (resolve) => {
        markStarted = resolve;
      },
    );

    const first = withStoryboardGenerationLock(
      directory,
      "job-001",
      async () => {
        markStarted();

        await firstCanFinish;

        return "first-completed";
      },
    );

    await firstStarted;

    try {
      await expect(
        withStoryboardGenerationLock(
          directory,
          "job-001",
          async () => "second-completed",
        ),
      ).rejects.toThrow(
        "Storyboard generation already locked",
      );
    } finally {
      releaseFirst();
    }

    expect(await first).toBe(
      "first-completed",
    );
  });

  it("releases the lock after operation failure", async () => {
    const directory = await setup();

    await expect(
      withStoryboardGenerationLock(
        directory,
        "job-001",
        async () => {
          throw new Error("Provider failed");
        },
      ),
    ).rejects.toThrow("Provider failed");

    const result = await withStoryboardGenerationLock(
      directory,
      "job-001",
      async () => "retry-succeeded",
    );

    expect(result).toBe("retry-succeeded");
  });

  it("records owner metadata during execution", async () => {
    const directory = await setup();

    await withStoryboardGenerationLock(
      directory,
      "job-001",
      async () => {
        const raw = await readFile(
          path.join(
            getStoryboardLockPath(
              directory,
              "job-001",
            ),
            "owner.json",
          ),
          "utf8",
        );

        const owner = JSON.parse(raw);

        expect(owner.jobId).toBe("job-001");
        expect(owner.pid).toBe(process.pid);
        expect(owner.token).toMatch(
          /^[a-f0-9-]{36}$/,
        );
      },
    );
  });

  it("permits different jobs to run independently", async () => {
    const directory = await setup();

    const results = await Promise.all([
      withStoryboardGenerationLock(
        directory,
        "job-001",
        async () => "first",
      ),
      withStoryboardGenerationLock(
        directory,
        "job-002",
        async () => "second",
      ),
    ]);

    expect(results).toEqual([
      "first",
      "second",
    ]);
  });

  it("rejects unsafe job identifiers", async () => {
    const directory = await setup();

    await expect(
      withStoryboardGenerationLock(
        directory,
        "../outside",
        async () => "unsafe",
      ),
    ).rejects.toThrow();
  });
});
