import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import type {
  VideoJob,
  PipelineStageId,
} from "@youcreator/contracts";

import { PipelineRegistry } from "./pipeline-registry.js";
import { PipelineRunner } from "./pipeline-runner.js";
import type { PipelineStage } from "./pipeline-stage.js";

let testDirectory: string;

beforeEach(async () => {
  testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "youcreator-runner-"),
  );
});

afterEach(async () => {
  await rm(testDirectory, {
    recursive: true,
    force: true,
  });
});

const createJob = (): VideoJob => ({
  id: randomUUID(),
  config: {
    title: "Test Video",
    mode: "B",
    durationSeconds: 60,
    resolution: "1920x1080",
    fps: 30,
  },
  status: "queued",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

function createStage(
  id: PipelineStageId,
  dependencies: PipelineStageId[],
  execute: PipelineStage["execute"],
): PipelineStage {
  return {
    id,
    version: "1",
    dependencies,
    execute,
  };
}

describe("PipelineRunner", () => {
  it("executes stages in dependency order", async () => {
    const registry = new PipelineRegistry();
    const executionOrder: string[] = [];

    registry.register(
      createStage("storyboard", ["script"], async () => {
        executionOrder.push("storyboard");
        return { scenes: 3 };
      }),
    );

    registry.register(
      createStage("script", [], async () => {
        executionOrder.push("script");
        return { text: "Hello world" };
      }),
    );

    const runner = new PipelineRunner(registry);
    const result = await runner.run(createJob(), testDirectory);

    expect(result.status).toBe("completed");
    expect(executionOrder).toEqual(["script", "storyboard"]);
    expect(result.stageRuns).toHaveLength(2);
  });

  it("makes upstream outputs available to dependencies", async () => {
    const registry = new PipelineRegistry();

    registry.register(
      createStage("script", [], async () => ({
        text: "Hello world",
      })),
    );

    registry.register(
      createStage("storyboard", ["script"], async (context) => {
        const script = context.outputs.get("script") as {
          text: string;
        };

        expect(script.text).toBe("Hello world");

        return { scenes: 1 };
      }),
    );

    const result = await new PipelineRunner(registry).run(
      createJob(),
      testDirectory,
    );

    expect(result.status).toBe("completed");
    expect(result.outputs.get("storyboard")).toEqual({
      scenes: 1,
    });
  });

  it("stops execution when a stage fails", async () => {
    const registry = new PipelineRegistry();

    let renderExecuted = false;

    registry.register(
      createStage("script", [], async () => {
        throw new Error("Script API unavailable");
      }),
    );

    registry.register(
      createStage("render", ["script"], async () => {
        renderExecuted = true;
        return { file: "video.mp4" };
      }),
    );

    const result = await new PipelineRunner(registry).run(
      createJob(),
      testDirectory,
    );

    expect(result.status).toBe("failed");
    expect(result.stageRuns[0]?.error).toBe(
      "Script API unavailable",
    );
    expect(renderExecuted).toBe(false);
  });

  it("supports empty pipelines", async () => {
    const registry = new PipelineRegistry();

    const result = await new PipelineRunner(registry).run(
      createJob(),
      testDirectory,
    );

    expect(result.status).toBe("completed");
    expect(result.stageRuns).toHaveLength(0);
  });

  it("reuses unchanged checkpoints and invalidates changed inputs", async () => {
    const registry = new PipelineRegistry();

    let executions = 0;

    registry.register(
      createStage("script", [], async (context) => {
        executions++;

        return {
          text: context.job.config.title,
        };
      }),
    );

    const runner = new PipelineRunner(registry);
    const job = createJob();

    const first = await runner.run(job, testDirectory);

    expect(first.status).toBe("completed");
    expect(executions).toBe(1);
    expect(first.stageRuns[0]?.status).toBe("completed");

    const second = await runner.run(job, testDirectory);

    expect(second.status).toBe("completed");
    expect(executions).toBe(1);
    expect(second.stageRuns[0]?.status).toBe("skipped");

    const modifiedJob = {
      ...job,
      config: {
        ...job.config,
        title: "Updated Video Title",
      },
    };

    const third = await runner.run(
      modifiedJob,
      testDirectory,
    );

    expect(third.status).toBe("completed");
    expect(executions).toBe(2);
    expect(third.stageRuns[0]?.status).toBe("completed");
  });

  it("regenerates a missing output artifact", async () => {
    const registry = new PipelineRegistry();

    let executions = 0;

    registry.register({
      id: "render",
      version: "1",
      dependencies: [],

      async execute(context) {
        executions++;

        const file = path.join(
          context.jobDirectory,
          "test-video.mp4",
        );

        await writeFile(file, "fake video");

        return { file };
      },

      async validateOutput(output) {
        if (
          typeof output !== "object" ||
          output === null ||
          !("file" in output) ||
          typeof output.file !== "string"
        ) {
          return false;
        }

        try {
          await access(output.file);
          return true;
        } catch {
          return false;
        }
      },
    });

    const runner = new PipelineRunner(registry);
    const job = createJob();

    const first = await runner.run(job, testDirectory);

    expect(first.status).toBe("completed");
    expect(executions).toBe(1);

    const second = await runner.run(job, testDirectory);

    expect(second.stageRuns[0]?.status).toBe("skipped");
    expect(executions).toBe(1);

    await unlink(
      path.join(testDirectory, "test-video.mp4"),
    );

    const third = await runner.run(job, testDirectory);

    expect(third.status).toBe("completed");
    expect(third.stageRuns[0]?.status).toBe("completed");
    expect(executions).toBe(2);
  });

  it("rejects invalid newly generated stage outputs", async () => {
    const registry = new PipelineRegistry();

    registry.register({
      id: "script",
      version: "1",
      dependencies: [],
      outputSchema: z.object({
        text: z.string().min(1),
      }),

      async execute() {
        return { text: "" };
      },
    });

    const result = await new PipelineRunner(registry).run(
      createJob(),
      testDirectory,
    );

    expect(result.status).toBe("failed");
    expect(result.stageRuns[0]?.status).toBe("failed");
  });

  it("regenerates a checkpoint with an invalid output schema", async () => {
    const registry = new PipelineRegistry();
    let executions = 0;

    registry.register({
      id: "script",
      version: "1",
      dependencies: [],
      outputSchema: z.object({
        text: z.string().min(1),
      }),

      async execute() {
        executions++;
        return { text: "Valid script" };
      },
    });

    const runner = new PipelineRunner(registry);
    const job = createJob();

    await runner.run(job, testDirectory);

    const checkpointFile = path.join(
      testDirectory,
      "checkpoints",
      "script.json",
    );

    const checkpoint = JSON.parse(
      await readFile(checkpointFile, "utf8"),
    );

    checkpoint.output = { text: "" };

    await writeFile(
      checkpointFile,
      JSON.stringify(checkpoint),
    );

    const result = await runner.run(job, testDirectory);

    expect(result.status).toBe("completed");
    expect(executions).toBe(2);
    expect(result.stageRuns[0]?.status).toBe("completed");
  });
});