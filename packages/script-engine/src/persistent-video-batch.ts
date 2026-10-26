import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  createVideoBatchIdentity,
  validateVideoBatchSpec,
  VideoBatchResultSchema,
  sha256Batch,
  type VideoBatchJob,
  type VideoBatchResult,
  type VideoBatchSpec,
} from "./video-batch-contract.js";

import {
  selectFailedJobsForRetry,
} from "./video-batch-recovery.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

const BatchEventSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().safe().nonnegative(),
  batchHash: Hash,
  jobId: z.string().min(1),
  result: VideoBatchResultSchema,
  previousHash: Hash.nullable(),
  eventHash: Hash,
}).strict();

type BatchEvent = z.infer<typeof BatchEventSchema>;

export interface VideoJobRunner {
  /**
   * Execute/resume a real M1 job until the native
   * video_export stage succeeds.
   *
   * On success, independently verify the committed
   * export checkpoint and return its exportHash.
   */
  run(job: VideoBatchJob): Promise<{
    exportHash: string;
  }>;
}

export interface PersistentVideoBatchOptions {
  rootDirectory: string;
  runner: VideoJobRunner;
  concurrency?: number;

  verifyCommittedExport?(
    jobId: string,
    expectedExportHash: string,
  ): Promise<boolean>;
}

export interface BatchRunOptions {
  retryFailedJobIds?: string[];
  maxAttemptsPerJob?: number;
}

export interface VideoBatchSummary {
  batchId: string;
  batchHash: string;
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  results: VideoBatchResult[];
}

function eventName(sequence: number): string {
  return `${String(sequence).padStart(10, "0")}.json`;
}

function hashEvent(
  event: Omit<BatchEvent, "eventHash">,
): BatchEvent {
  return BatchEventSchema.parse({
    ...event,
    eventHash: sha256Batch(event),
  });
}

function validateConcurrency(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 16
  ) {
    throw new Error(
      "M9 concurrency must be between 1 and 16",
    );
  }

  return value;
}

async function createOnlyJson(
  destination: string,
  data: unknown,
): Promise<void> {
  const temp = `${destination}.${randomUUID()}.tmp`;

  try {
    await writeFile(
      temp,
      JSON.stringify(data),
      { flag: "wx", mode: 0o600 },
    );
    await link(temp, destination);
  } finally {
    await rm(temp, { force: true });
  }
}

export class PersistentVideoBatchCoordinator {
  private readonly concurrency: number;

  constructor(
    private readonly options:
      PersistentVideoBatchOptions,
  ) {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw new Error(
        "M9 batch storage path must be absolute",
      );
    }

    this.concurrency = validateConcurrency(
      options.concurrency ?? 2,
    );
  }

  private directory(batchId: string): string {
    return path.join(
      this.options.rootDirectory,
      "batches",
      sha256Batch(batchId),
    );
  }

  private async loadSpec(
    directory: string,
    expected: VideoBatchSpec,
  ): Promise<void> {
    const file = path.join(directory, "spec.json");
    const expectedHash =
      createVideoBatchIdentity(expected);

    try {
      const saved =
        validateVideoBatchSpec(
          JSON.parse(await readFile(file, "utf8")),
        );

      if (
        createVideoBatchIdentity(saved) !==
          expectedHash
      ) {
        throw new Error(
          "M9 immutable batch specification mismatch",
        );
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !==
        "ENOENT"
      ) {
        throw error;
      }

      try {
        await createOnlyJson(file, expected);
      } catch (createError) {
        if (
          (createError as NodeJS.ErrnoException)
            .code !== "EEXIST"
        ) {
          throw createError;
        }
      }

      const saved =
        validateVideoBatchSpec(
          JSON.parse(await readFile(file, "utf8")),
        );

      if (
        createVideoBatchIdentity(saved) !==
        expectedHash
      ) {
        throw new Error(
          "M9 concurrent batch specification conflict",
        );
      }
    }
  }

  private async readEvents(
    directory: string,
    batchHash: string,
    jobIds: Set<string>,
  ): Promise<BatchEvent[]> {
    const eventDirectory =
      path.join(directory, "events");

    await mkdir(eventDirectory, {
      recursive: true,
    });

    const names = (
      await readdir(eventDirectory)
    )
      .filter((name) => name.endsWith(".json"))
      .sort();

    const events: BatchEvent[] = [];
    let previousHash: string | null = null;

    for (let i = 0; i < names.length; i++) {
      if (names[i] !== eventName(i)) {
        throw new Error(
          "M9 batch journal sequence gap",
        );
      }

      const value = BatchEventSchema.parse(
        JSON.parse(
          await readFile(
            path.join(eventDirectory, names[i]!),
            "utf8",
          ),
        ),
      );

      const { eventHash, ...payload } = value;

      if (
        value.sequence !== i ||
        value.batchHash !== batchHash ||
        !jobIds.has(value.jobId) ||
        value.result.jobId !== value.jobId ||
        value.previousHash !== previousHash ||
        sha256Batch(payload) !== eventHash
      ) {
        throw new Error(
          "M9 batch journal integrity mismatch",
        );
      }

      events.push(value);
      previousHash = value.eventHash;
    }

    return events;
  }

  private async appendEvent(
    directory: string,
    events: BatchEvent[],
    batchHash: string,
    result: VideoBatchResult,
  ): Promise<void> {
    const event = hashEvent({
      version: 1,
      sequence: events.length,
      batchHash,
      jobId: result.jobId,
      result,
      previousHash:
        events.at(-1)?.eventHash ?? null,
    });

    await createOnlyJson(
      path.join(
        directory,
        "events",
        eventName(event.sequence),
      ),
      event,
    );

    events.push(event);
  }

  private summary(
    spec: VideoBatchSpec,
    batchHash: string,
    events: BatchEvent[],
  ): VideoBatchSummary {
    const latest = new Map<string, VideoBatchResult>();

    for (const event of events) {
      latest.set(event.jobId, event.result);
    }

    const results = spec.jobs.map(
      (job): VideoBatchResult =>
        latest.get(job.jobId) ?? {
          jobId: job.jobId,
          state: "PENDING",
          attempt: 0,
          exportHash: null,
          errorCode: null,
        },
    );

    return {
      batchId: spec.batchId,
      batchHash,
      total: results.length,
      succeeded: results.filter(
        (r) => r.state === "SUCCEEDED",
      ).length,
      failed: results.filter(
        (r) => r.state === "FAILED",
      ).length,
      pending: results.filter(
        (r) =>
          r.state === "PENDING" ||
          r.state === "RUNNING",
      ).length,
      results,
    };
  }

  async run(
    candidate: VideoBatchSpec,
    runOptions: BatchRunOptions = {},
  ): Promise<VideoBatchSummary> {
    const spec = validateVideoBatchSpec(candidate);
    const batchHash = createVideoBatchIdentity(spec);
    const directory = this.directory(spec.batchId);

    await mkdir(directory, { recursive: true });

    // Single coordinator per batch on one
    // filesystem. Multi-host leases are not
    // supported by this milestone.
    const lock = path.join(directory, ".batch-lock");

    try {
      await mkdir(lock);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "EEXIST"
      ) {
        throw new Error(
          "M9 batch already has an active coordinator",
        );
      }

      throw error;
    }

    try {
      await this.loadSpec(directory, spec);

      const events = await this.readEvents(
        directory,
        batchHash,
        new Set(spec.jobs.map((j) => j.jobId)),
      );

      const previous = this.summary(
        spec,
        batchHash,
        events,
      );

      for (const result of previous.results) {
        if (result.state !== "SUCCEEDED") {
          continue;
        }

        if (!result.exportHash) {
          throw new Error(
            `M9 successful job lacks export identity: ${result.jobId}`,
          );
        }

        if (this.options.verifyCommittedExport) {
          const valid =
            await this.options.verifyCommittedExport(
              result.jobId,
              result.exportHash,
            );

          if (!valid) {
            throw new Error(
              `M9 committed export invalid: ${result.jobId}`,
            );
          }
        }
      }

      const previousById = new Map(
        previous.results.map((r) => [r.jobId, r]),
      );

      const retryIds = runOptions.retryFailedJobIds ?? [];

      const retrySelection =
        retryIds.length > 0
          ? selectFailedJobsForRetry(
              spec,
              previous.results,
              {
                jobIds: retryIds,
                maxAttemptsPerJob:
                  runOptions.maxAttemptsPerJob ?? 3,
              },
            )
          : {
              selected: [] as string[],
              rejected: [],
            };

      if (retrySelection.rejected.length > 0) {
        throw new Error(
          "M9 retry request contains ineligible jobs",
        );
      }

      const explicitlyRetry = new Set(
        retrySelection.selected,
      );

      // Preserve completed jobs. Failed jobs do
      // not auto-retry; an explicit retry policy
      // will be introduced separately.
      const pending = spec.jobs.filter((job) => {
        const state =
          previousById.get(job.jobId)!.state;

        return (
          state === "PENDING" ||
          state === "RUNNING" ||
          (
            state === "FAILED" &&
            explicitlyRetry.has(job.jobId)
          )
        );
      });

      let cursor = 0;

      const worker = async (): Promise<void> => {
        while (cursor < pending.length) {
          const job = pending[cursor++]!;
          const previousResult =
            previousById.get(job.jobId)!;
          const attempt =
            previousResult.attempt + 1;

          // Event append is serialized, even while
          // individual jobs run concurrently.
          await enqueue({
            jobId: job.jobId,
            state: "RUNNING",
            attempt,
            exportHash: null,
            errorCode: null,
          });

          let completed:
            | { exportHash: string }
            | undefined;

          let jobFailed = false;

          try {
            completed =
              await this.options.runner.run(job);

            if (
              !Hash.safeParse(
                completed.exportHash,
              ).success
            ) {
              throw new Error(
                "M9 runner returned invalid export hash",
              );
            }
          } catch {
            jobFailed = true;
          }

          if (jobFailed) {
            await enqueue({
              jobId: job.jobId,
              state: "FAILED",
              attempt,
              exportHash: null,
              errorCode: "VIDEO_JOB_FAILED",
            });
          } else {
            // Journal failure propagates to the
            // coordinator instead of being converted
            // into a video-render failure.
            await enqueue({
              jobId: job.jobId,
              state: "SUCCEEDED",
              attempt,
              exportHash: completed!.exportHash,
              errorCode: null,
            });
          }
        }
      };

      // Chain journal mutations to prevent two
      // workers selecting the same sequence number.
      let journalTail = Promise.resolve();

      const enqueue = (
        result: VideoBatchResult,
      ): Promise<void> => {
        const operation = journalTail.then(() =>
          this.appendEvent(
            directory,
            events,
            batchHash,
            result,
          ),
        );

        journalTail = operation;
        return operation;
      };

      await Promise.all(
        Array.from(
          {
            length: Math.min(
              this.concurrency,
              pending.length,
            ),
          },
          () => worker(),
        ),
      );

      return this.summary(
        spec,
        batchHash,
        events,
      );
    } finally {
      await rm(lock, { recursive: true });
    }
  }
}

export function createVideoJobRunner(
  runExistingJob: (
    jobId: string,
    topic: string,
    profileId: string,
  ) => Promise<void>,
  loadVerifiedExport: (
    jobId: string,
  ) => Promise<{ exportHash: string } | null>,
): VideoJobRunner {
  return {
    async run(job) {
      await runExistingJob(
        job.jobId,
        job.topic,
        job.profileId,
      );

      const exported =
        await loadVerifiedExport(job.jobId);

      if (!exported) {
        throw new Error(
          "M9 batch job has no verified final export",
        );
      }

      return {
        exportHash: exported.exportHash,
      };
    },
  };
}
