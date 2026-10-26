import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import path from "node:path";

import {
  VideoConfigSchema,
  VideoJobSchema,
  type VideoJob,
} from "@youcreator/contracts";
import { assertJobTransition } from "./job-lifecycle.js";

export class JobStore {
  constructor(private readonly directory: string) {}

  private jobPath(id: string): string {
    // Prevent arbitrary paths from being used as job IDs.
    const validId = VideoJobSchema.shape.id.parse(id);
    return path.join(this.directory, `${validId}.json`);
  }

  async create(config: unknown): Promise<VideoJob> {
    const parsedConfig = VideoConfigSchema.parse(config);
    const now = new Date().toISOString();

    const job: VideoJob = {
      id: randomUUID(),
      config: parsedConfig,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    await this.save(job);
    return job;
  }

  async get(id: string): Promise<VideoJob | null> {
    try {
      const content = await readFile(this.jobPath(id), "utf8");
      return VideoJobSchema.parse(JSON.parse(content));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }

      throw error;
    }
  }

  async update(
    id: string,
    changes: Partial<Pick<VideoJob, "status" | "error">>,
  ): Promise<VideoJob> {
    const job = await this.get(id);

    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }

    if (
      changes.status !== undefined &&
      changes.status !== job.status
    ) {
      assertJobTransition(job.status, changes.status);
    }

    const updated = VideoJobSchema.parse({
      ...job,
      ...changes,
      error:
        changes.status === "queued" ||
        changes.status === "completed"
          ? undefined
          : changes.error !== undefined
            ? changes.error
            : job.error,
      updatedAt: new Date().toISOString(),
    });

    await this.save(updated);
    return updated;
  }

  private async save(job: VideoJob): Promise<void> {
    await mkdir(this.directory, { recursive: true });

    const file = this.jobPath(job.id);
    const temporaryFile = `${file}.${randomUUID()}.tmp`;

    try {
      await writeFile(
        temporaryFile,
        JSON.stringify(job, null, 2),
        { encoding: "utf8", flag: "wx" },
      );

      await rename(temporaryFile, file);
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      await rm(temporaryFile, { force: true });
      throw error;
    }
  }
}