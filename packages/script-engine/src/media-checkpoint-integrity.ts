import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  AssignedMediaSchema,
} from "./assigned-media.js";

const ManifestSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),

  report: z.object({
    passed: z.literal(true),
    assignments: z.array(
      AssignedMediaSchema,
    ).min(1),
  }).passthrough(),
}).passthrough();

export interface MediaCheckpointInspection {
  jobId: string;
  inputHash: string;
  manifestHash: string;

  shotIds: string[];
  assetPaths: string[];
  assetHashes: string[];
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

/**
 * Inspect persisted assignments.
 *
 * This is a read-only diagnostic helper.
 * It does not approve rights or claim that media
 * bytes are valid.
 */
export async function inspectMediaCheckpoint(
  manifestPath: string,
): Promise<MediaCheckpointInspection> {
  const raw = await readFile(
    manifestPath,
    "utf8",
  );

  const manifest = ManifestSchema.parse(
    JSON.parse(raw),
  );

  const assignments =
    manifest.report.assignments;

  const shotIds = assignments.map(
    (assignment) => assignment.shotId,
  );

  if (
    new Set(shotIds).size !== shotIds.length
  ) {
    throw new Error(
      "Media checkpoint contains duplicate shot assignments",
    );
  }

  return {
    jobId: manifest.jobId,
    inputHash: manifest.inputHash,
    manifestHash: hash(manifest),

    shotIds,

    assetPaths: assignments.map(
      (assignment) =>
        assignment.asset.localPath,
    ),

    assetHashes: assignments.map(
      (assignment) =>
        assignment.asset.sha256,
    ),
  };
}
