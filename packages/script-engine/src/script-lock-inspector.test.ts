import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  inspectScriptLock,
} from "./script-lock-inspector.js";

describe("Script lock inspection", () => {
  let root: string | undefined;

  async function setup(jobId = "test-job") {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-lock-"),
    );

    const directory = path.join(
      root,
      jobId,
      ".script-generation.lock",
    );

    return {
      jobId,
      directory,
    };
  }

  async function writeOwner(
    directory: string,
    jobId: string,
    overrides: Record<string, unknown> = {},
  ) {
    await mkdir(directory, { recursive: true });

    await writeFile(
      path.join(directory, "owner.json"),
      JSON.stringify({
        version: 1,
        jobId,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
        ...overrides,
      }),
      "utf8",
    );
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

  it("reports an unlocked job", async () => {
    const env = await setup();

    const result = await inspectScriptLock(
      root!,
      env.jobId,
    );

    expect(result.status).toBe("unlocked");
  });

  it("recognizes a live local process", async () => {
    const env = await setup();

    await writeOwner(
      env.directory,
      env.jobId,
    );

    const result = await inspectScriptLock(
      root!,
      env.jobId,
    );

    expect(result.status).toBe("active");
    expect(result.owner?.pid).toBe(process.pid);
  });

  it("reports missing owner metadata as unknown", async () => {
    const env = await setup();

    await mkdir(env.directory, {
      recursive: true,
    });

    const result = await inspectScriptLock(
      root!,
      env.jobId,
    );

    expect(result.status).toBe("unknown");
  });

  it("rejects invalid owner metadata", async () => {
    const env = await setup();

    await mkdir(env.directory, {
      recursive: true,
    });

    await writeFile(
      path.join(env.directory, "owner.json"),
      "{invalid-json",
      "utf8",
    );

    const result = await inspectScriptLock(
      root!,
      env.jobId,
    );

    expect(result.status).toBe("unknown");
  });

  it("does not claim remote locks are stale", async () => {
    const env = await setup();

    await writeOwner(
      env.directory,
      env.jobId,
      {
        hostname: "different-machine",
      },
    );

    const result = await inspectScriptLock(
      root!,
      env.jobId,
    );

    expect(result.status).toBe("unknown");
  });

  it("rejects unsafe job IDs", async () => {
    await setup();

    await expect(
      inspectScriptLock(
        root!,
        "../outside",
      ),
    ).rejects.toThrow();
  });

  it("does not remove locks during inspection", async () => {
    const env = await setup();

    await writeOwner(
      env.directory,
      env.jobId,
    );

    await inspectScriptLock(
      root!,
      env.jobId,
    );

    const second = await inspectScriptLock(
      root!,
      env.jobId,
    );

    expect(second.status).toBe("active");
  });
});
