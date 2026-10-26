import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointStore } from "./checkpoint-store.js";
import { invalidateCheckpointsFrom } from "./checkpoint-invalidation.js";

describe("Checkpoint Invalidation", () => {
  it("invalidates all downstream checkpoints starting from specified stage", async () => {
    const tempDir = path.join(
      os.tmpdir(),
      `test-inval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const store = new CheckpointStore(tempDir);

    // Save checkpoints for stages
    await store.save("script", { script: "ok" }, "a".repeat(64));
    await store.save("storyboard", { shots: [] }, "b".repeat(64));
    await store.save("media", { assets: [] }, "c".repeat(64));
    await store.save("visual", { package: "ok" }, "d".repeat(64));

    expect(await store.load("script")).not.toBeNull();
    expect(await store.load("storyboard")).not.toBeNull();
    expect(await store.load("media")).not.toBeNull();
    expect(await store.load("visual")).not.toBeNull();

    // Invalidate from storyboard onwards
    const invalidated = await invalidateCheckpointsFrom(tempDir, "storyboard");

    expect(invalidated).toContain("storyboard");
    expect(invalidated).toContain("media");
    expect(invalidated).toContain("visual");
    expect(invalidated).not.toContain("script");

    // Script should still exist; downstream checkpoints should be gone
    expect(await store.load("script")).not.toBeNull();
    expect(await store.load("storyboard")).toBeNull();
    expect(await store.load("media")).toBeNull();
    expect(await store.load("visual")).toBeNull();
  });
});
