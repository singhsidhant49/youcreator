import {
  readFile,
  stat,
} from "node:fs/promises";

import path from "node:path";
import os from "node:os";
import { z } from "zod";

export const ScriptLockOwnerSchema = z.object({
  version: z.literal(1),
  jobId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  acquiredAt: z.string().datetime(),
}).strict();

export type ScriptLockOwner = z.infer<
  typeof ScriptLockOwnerSchema
>;

export type ScriptLockStatus =
  | "unlocked"
  | "active"
  | "possibly_stale"
  | "unknown";

export interface ScriptLockInspection {
  status: ScriptLockStatus;
  lockDirectory: string;
  owner?: ScriptLockOwner;
  reason: string;
}

function lockPath(
  jobsRoot: string,
  jobId: string,
): string {
  ScriptLockOwnerSchema.shape.jobId.parse(jobId);

  return path.join(
    path.resolve(jobsRoot),
    jobId,
    ".script-generation.lock",
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function inspectScriptLock(
  jobsRoot: string,
  jobId: string,
): Promise<ScriptLockInspection> {
  const directory = lockPath(jobsRoot, jobId);

  try {
    await stat(directory);
  } catch (error) {
    if (isMissing(error)) {
      return {
        status: "unlocked",
        lockDirectory: directory,
        reason: "No script generation lock exists",
      };
    }

    throw error;
  }

  let raw: string;

  try {
    raw = await readFile(
      path.join(directory, "owner.json"),
      "utf8",
    );
  } catch (error) {
    if (isMissing(error)) {
      return {
        status: "unknown",
        lockDirectory: directory,
        reason: "Lock exists without owner metadata",
      };
    }

    throw error;
  }

  let owner: ScriptLockOwner;

  try {
    owner = ScriptLockOwnerSchema.parse(
      JSON.parse(raw),
    );
  } catch {
    return {
      status: "unknown",
      lockDirectory: directory,
      reason: "Invalid lock owner metadata",
    };
  }

  if (owner.jobId !== jobId) {
    return {
      status: "unknown",
      lockDirectory: directory,
      owner,
      reason: "Lock owner job ID mismatch",
    };
  }

  if (owner.hostname !== os.hostname()) {
    return {
      status: "unknown",
      lockDirectory: directory,
      owner,
      reason: "Lock belongs to another hostname",
    };
  }

  try {
    process.kill(owner.pid, 0);

    return {
      status: "active",
      lockDirectory: directory,
      owner,
      reason: "Lock owner process ID exists",
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return {
        status: "possibly_stale",
        lockDirectory: directory,
        owner,
        reason: "Recorded process no longer exists",
      };
    }

    return {
      status: "unknown",
      lockDirectory: directory,
      owner,
      reason:
        "Unable to determine lock owner process status",
    };
  }
}
