import { createHash } from "node:crypto";
import { z } from "zod";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const VideoBatchJobSchema = z.object({
  jobId: z.string().trim().min(1).max(200),
  topic: z.string().trim().min(1).max(5000),
  profileId: z.string().trim().min(1),
}).strict();

export const VideoBatchSpecSchema = z.object({
  version: z.literal(1),
  batchId: z.string().min(1),
  jobs: z.array(VideoBatchJobSchema).min(1).max(1000),
}).strict();

export const VideoBatchStateSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
]);

export const VideoBatchResultSchema = z.object({
  jobId: z.string().min(1),
  state: VideoBatchStateSchema,
  attempt: z.number().int().safe().nonnegative(),
  exportHash: Hash.nullable(),
  errorCode: z.string().nullable(),
}).strict();

export type VideoBatchJob =
  z.infer<typeof VideoBatchJobSchema>;

export type VideoBatchSpec =
  z.infer<typeof VideoBatchSpecSchema>;

export type VideoBatchResult =
  z.infer<typeof VideoBatchResultSchema>;

export function sha256Batch(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function validateVideoBatchSpec(
  candidate: unknown,
): VideoBatchSpec {
  const spec = VideoBatchSpecSchema.parse(candidate);

  const ids = spec.jobs.map((job) => job.jobId);

  if (new Set(ids).size !== ids.length) {
    throw new Error(
      "M9 duplicate job IDs in batch",
    );
  }

  return spec;
}

export function createVideoBatchIdentity(
  spec: VideoBatchSpec,
): string {
  return sha256Batch(
    validateVideoBatchSpec(spec),
  );
}
