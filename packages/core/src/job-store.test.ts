import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { JobStore } from "./job-store.js";

describe("JobStore state invariants", () => {
  it("clears errors when a failed job is requeued", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-job-store-"),
    );

    try {
      const store = new JobStore(directory);

      const job = await store.create({
        title: "Test Job",
        mode: "B",
        durationSeconds: 60,
      });

      await store.update(job.id, { status: "running" });

      await store.update(job.id, {
        status: "failed",
        error: "TTS service unavailable",
      });

      const retried = await store.update(job.id, {
        status: "queued",
      });

      expect(retried.status).toBe("queued");
      expect(retried.error).toBeUndefined();

      const loaded = await store.get(job.id);

      expect(loaded?.error).toBeUndefined();
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("rejects invalid job status transitions", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-job-store-"),
    );

    try {
      const store = new JobStore(directory);

      const job = await store.create({
        title: "Test Job",
        mode: "A",
        durationSeconds: 60,
      });

      await expect(
        store.update(job.id, { status: "completed" }),
      ).rejects.toThrow("Invalid job transition");
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });
});
