import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import { z } from "zod";

const JobIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/);

export const StoryboardLockOwnerSchema = z.object({
  version: z.literal(1),
  jobId: JobIdSchema,
  token: z.string().uuid(),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  acquiredAt: z.string().datetime(),
}).strict();

export type StoryboardLockOwner = z.infer<
  typeof StoryboardLockOwnerSchema
>;

export function getStoryboardLockPath(
  jobsRoot: string,
  jobId: string,
): string {
  JobIdSchema.parse(jobId);

  return path.join(
    path.resolve(jobsRoot),
    jobId,
    "storyboard",
    ".generation.lock",
  );
}

export async function withStoryboardGenerationLock<T>(
  jobsRoot: string,
  jobId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockDirectory = getStoryboardLockPath(
    jobsRoot,
    jobId,
  );

  const parentDirectory = path.dirname(
    lockDirectory,
  );

  await mkdir(parentDirectory, {
    recursive: true,
  });

  try {
    // mkdir is atomic for a single lock path.
    // Do not use recursive: true here.
    await mkdir(lockDirectory);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error(
        `Storyboard generation already locked for job ${jobId}`,
      );
    }

    throw error;
  }

  const owner = StoryboardLockOwnerSchema.parse({
    version: 1,
    jobId,
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  });

  const ownerFile = path.join(
    lockDirectory,
    "owner.json",
  );

  try {
    await writeFile(
      ownerFile,
      JSON.stringify(owner, null, 2),
      {
        encoding: "utf8",
        flag: "wx",
      },
    );

    return await operation();
  } finally {
    // Never deliberately remove a lock if its owner
    // metadata no longer matches this execution.
    let matchingOwner = false;

    try {
      const saved = StoryboardLockOwnerSchema.parse(
        JSON.parse(
          await readFile(ownerFile, "utf8"),
        ),
      );

      matchingOwner =
        saved.token === owner.token &&
        saved.jobId === jobId;
    } catch {
      // Missing/invalid owner metadata is unsafe
      // to interpret as proof of ownership.
    }

    if (matchingOwner) {
      await rm(lockDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
}
