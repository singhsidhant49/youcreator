import {
  JobStatusSchema,
} from "@youcreator/contracts";

import type { z } from "zod";

export type JobStatus = z.infer<typeof JobStatusSchema>;

const allowedTransitions: Record<
  JobStatus,
  readonly JobStatus[]
> = {
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export class InvalidJobTransitionError extends Error {
  constructor(from: JobStatus, to: JobStatus) {
    super(`Invalid job transition: ${from} -> ${to}`);
    this.name = "InvalidJobTransitionError";
  }
}

export function assertJobTransition(
  from: JobStatus,
  to: JobStatus,
): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new InvalidJobTransitionError(from, to);
  }
}
