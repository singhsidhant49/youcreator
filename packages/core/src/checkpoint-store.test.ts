import { describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { CheckpointStore } from "./checkpoint-store.js";

describe("CheckpointStore", () => {
  it("saves and restores completed outputs", async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-"),
    );

    try {
      const store = new CheckpointStore(dir);

      await store.save(
        "script",
        { text: "Hello world" },
        "a".repeat(64),
      );

      const checkpoint = await store.load("script");

      expect(checkpoint?.stageId).toBe("script");
      expect(checkpoint?.inputHash).toBe("a".repeat(64));
      expect(checkpoint?.output).toEqual({
        text: "Hello world",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for missing checkpoints", async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-"),
    );

    try {
      const store = new CheckpointStore(dir);

      expect(await store.load("audio")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores corrupted checkpoint JSON", async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-corrupt-"),
    );

    try {
      const store = new CheckpointStore(dir);

      await store.save(
        "script",
        { text: "Hello" },
        "a".repeat(64),
      );

      const file = path.join(
        dir,
        "checkpoints",
        "script.json",
      );

      await writeFile(file, "{broken json");

      expect(await store.load("script")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
