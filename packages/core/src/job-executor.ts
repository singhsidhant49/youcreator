import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { PipelineExecutionResult, PipelineRunOptions } from "./pipeline-runner.js";
import { PipelineRunner } from "./pipeline-runner.js";
import { JobStore } from "./job-store.js";
import type { VideoJob } from "@youcreator/contracts";

export class JobExecutor {
  constructor(
    private readonly jobs: JobStore,
    private readonly runner: PipelineRunner,
    private readonly outputDirectory: string,
  ) {}

  async execute(jobId: string, options?: PipelineRunOptions): Promise<PipelineExecutionResult> {
    const job = await this.jobs.get(jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== "queued") {
      throw new Error(
        `Cannot execute job ${jobId} with status ${job.status}`,
      );
    }

    const jobDirectory = path.join(
      this.outputDirectory,
      job.id,
    );

    await mkdir(jobDirectory, { recursive: true });

    const runningJob = await this.jobs.update(jobId, {
      status: "running",
    });

    let result: PipelineExecutionResult;

    try {
      result = await this.runner.run(
        runningJob,
        jobDirectory,
        {
          checkCancelled: async () => {
            const current = await this.jobs.get(jobId);
            return current?.status === "cancelled";
          },
          ...options,
        },
      );
    } catch (error) {
      const current = await this.jobs.get(jobId);
      if (current?.status !== "cancelled") {
        await this.jobs.update(jobId, {
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }

      throw error;
    }

    const failedStage = result.stageRuns.find(
      (stage) => stage.status === "failed",
    );

    await this.saveReport(jobDirectory, {
      jobId,
      status: result.status,
      stageRuns: result.stageRuns,
      finishedAt: new Date().toISOString(),
    });

    await this.jobs.update(jobId, {
      status: result.status,
      error:
        result.status === "failed"
          ? failedStage?.error ?? "Pipeline execution failed"
          : undefined,
    });

    return result;
  }

  async retry(jobId: string): Promise<void> {
    const job = await this.jobs.get(jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== "failed") {
      throw new Error(
        `Cannot retry job with status ${job.status}`,
      );
    }

    await this.jobs.update(jobId, {
      status: "queued",
      error: undefined,
    });
  }

  async recoverInterrupted(jobId: string): Promise<void> {
    const job = await this.jobs.get(jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== "running") {
      throw new Error(
        `Cannot recover job with status ${job.status}`,
      );
    }

    await this.jobs.update(jobId, {
      status: "failed",
      error: "Execution interrupted; retry required",
    });
  }

  async cancel(jobId: string): Promise<VideoJob> {
    const job = await this.jobs.get(jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      throw new Error(`Cannot cancel job with status ${job.status}`);
    }

    return await this.jobs.update(jobId, {
      status: "cancelled",
      error: "Cancelled by user",
    });
  }

  private async saveReport(
    jobDirectory: string,
    report: unknown,
  ): Promise<void> {
    const file = path.join(
      jobDirectory,
      "execution-report.json",
    );

    const temporary = `${file}.${randomUUID()}.tmp`;

    try {
      await writeFile(
        temporary,
        JSON.stringify(report, null, 2),
        { encoding: "utf8", flag: "wx" },
      );

      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
