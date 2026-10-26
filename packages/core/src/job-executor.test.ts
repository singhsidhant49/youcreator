import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

import { JobStore } from "./job-store.js";
import { PipelineRegistry } from "./pipeline-registry.js";
import { PipelineRunner } from "./pipeline-runner.js";
import { JobExecutor } from "./job-executor.js";

async function setup() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "youcreator-executor-"),
  );

  const jobs = new JobStore(path.join(directory, "jobs"));
  const registry = new PipelineRegistry();

  const job = await jobs.create({
    title: "Integration Test",
    mode: "B",
    durationSeconds: 60,
  });

  return {
    directory,
    jobs,
    registry,
    job,
    outputDirectory: path.join(directory, "output"),
  };
}

describe("JobExecutor", () => {
  it("completes a successful job and saves its report", async () => {
    const env = await setup();

    try {
      env.registry.register({
        id: "script",
        version: "1",
        dependencies: [],

        async execute() {
          return { text: "Hello world" };
        },
      });

      const executor = new JobExecutor(
        env.jobs,
        new PipelineRunner(env.registry),
        env.outputDirectory,
      );

      const result = await executor.execute(env.job.id);
      const savedJob = await env.jobs.get(env.job.id);

      expect(result.status).toBe("completed");
      expect(savedJob?.status).toBe("completed");

      const reportPath = path.join(
        env.outputDirectory,
        env.job.id,
        "execution-report.json",
      );

      const report = JSON.parse(
        await readFile(reportPath, "utf8"),
      );

      expect(report.jobId).toBe(env.job.id);
      expect(report.status).toBe("completed");
      expect(report.stageRuns).toHaveLength(1);
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("marks the job failed when a stage fails", async () => {
    const env = await setup();

    try {
      env.registry.register({
        id: "script",
        version: "1",
        dependencies: [],

        async execute() {
          throw new Error("Provider unavailable");
        },
      });

      const executor = new JobExecutor(
        env.jobs,
        new PipelineRunner(env.registry),
        env.outputDirectory,
      );

      const result = await executor.execute(env.job.id);
      const savedJob = await env.jobs.get(env.job.id);

      expect(result.status).toBe("failed");
      expect(savedJob?.status).toBe("failed");
      expect(savedJob?.error).toBe("Provider unavailable");
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("rejects execution of an already completed job", async () => {
    const env = await setup();

    try {
      await env.jobs.update(env.job.id, {
        status: "running",
      });

      await env.jobs.update(env.job.id, {
        status: "completed",
      });

      const executor = new JobExecutor(
        env.jobs,
        new PipelineRunner(env.registry),
        env.outputDirectory,
      );

      await expect(
        executor.execute(env.job.id),
      ).rejects.toThrow("Cannot execute job");
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("retries a failed job using its existing checkpoints", async () => {
    const env = await setup();

    let scriptExecutions = 0;
    let audioExecutions = 0;
    let failAudio = true;

    try {
      env.registry.register({
        id: "script",
        version: "1",
        dependencies: [],
        async execute() {
          scriptExecutions++;
          return { text: "Hello world" };
        },
      });

      env.registry.register({
        id: "audio",
        version: "1",
        dependencies: ["script"],
        async execute() {
          audioExecutions++;

          if (failAudio) {
            throw new Error("TTS unavailable");
          }

          return { duration: 5 };
        },
      });

      const executor = new JobExecutor(
        env.jobs,
        new PipelineRunner(env.registry),
        env.outputDirectory,
      );

      const first = await executor.execute(env.job.id);

      expect(first.status).toBe("failed");
      expect(scriptExecutions).toBe(1);
      expect(audioExecutions).toBe(1);

      await executor.retry(env.job.id);

      failAudio = false;

      const second = await executor.execute(env.job.id);

      expect(second.status).toBe("completed");
      expect(scriptExecutions).toBe(1);
      expect(audioExecutions).toBe(2);

      expect(second.stageRuns[0]?.status).toBe("skipped");
      expect(second.stageRuns[1]?.status).toBe("completed");

      const savedJob = await env.jobs.get(env.job.id);
      expect(savedJob?.status).toBe("completed");
      expect(savedJob?.error).toBeUndefined();
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("recovers an interrupted running job", async () => {
    const env = await setup();

    try {
      await env.jobs.update(env.job.id, {
        status: "running",
      });

      const executor = new JobExecutor(
        env.jobs,
        new PipelineRunner(env.registry),
        env.outputDirectory,
      );

      await executor.recoverInterrupted(env.job.id);

      const failedJob = await env.jobs.get(env.job.id);

      expect(failedJob?.status).toBe("failed");
      expect(failedJob?.error).toContain(
        "Execution interrupted",
      );

      await executor.retry(env.job.id);

      const queuedJob = await env.jobs.get(env.job.id);

      expect(queuedJob?.status).toBe("queued");
      expect(queuedJob?.error).toBeUndefined();
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });
});
