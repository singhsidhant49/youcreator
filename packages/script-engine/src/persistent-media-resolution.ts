import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type {
  MediaAsset,
} from "@youcreator/contracts";

import {
  AssignedMediaSchema,
  MediaAssignmentOutcomeSchema,
} from "./assigned-media.js";

import {
  MediaResolutionRequestSchema,
  type MediaResolutionRequest,
  type MediaResolutionReport,
  type MediaQAIssue,
} from "./media-resolution-coordinator.js";

import {
  verifyMediaResolutionReport,
} from "./media-report-integrity.js";

const HashSchema = z.string().regex(
  /^[a-f0-9]{64}$/,
);

const IdSchema = z.string().trim().min(1);

export const PersistentMediaInputSchema = z.object({
  jobId: IdSchema,

  storyboardSha256: HashSchema,
  mediaPlanSha256: HashSchema,

  stageVersion: z.literal("m4-resolution-v1"),

  request: MediaResolutionRequestSchema,
}).strict().superRefine((value, ctx) => {
  if (value.request.jobId !== value.jobId) {
    ctx.addIssue({
      code: "custom",
      message: "Job ID mismatch",
    });
  }
});

export type PersistentMediaInput = z.infer<
  typeof PersistentMediaInputSchema
>;

const IssueSchema = z.object({
  code: z.enum([
    "MISSING_SHOT",
    "DUPLICATE_SHOT",
    "UNKNOWN_SHOT",
    "MODE_MISMATCH",
    "ASSIGNMENT_INVALID",
    "ASSET_VERIFICATION_FAILED",
    "RIGHTS_NOT_APPROVED",
    "RESOLUTION_FAILED",
    "REPEATED_ASSET",
  ]),
  severity: z.enum([
    "blocker",
    "warning",
  ]),
  shotId: z.string().optional(),
  message: z.string().min(1),
}).strict();

const ReportSchema = z.object({
  version: z.literal(1),
  jobId: IdSchema,
  mode: z.enum(["A", "B", "C", "D"]),
  expectedShots: z.number().int().nonnegative(),
  assignedShots: z.number().int().nonnegative(),
  outcomes: z.array(
    MediaAssignmentOutcomeSchema,
  ),
  assignments: z.array(
    AssignedMediaSchema,
  ),
  issues: z.array(IssueSchema),
  passed: z.boolean(),
}).strict();

const ManifestSchema = z.object({
  version: z.literal(1),

  inputHash: HashSchema,
  jobId: IdSchema,

  storyboardSha256: HashSchema,
  mediaPlanSha256: HashSchema,

  stageVersion: z.literal("m4-resolution-v1"),

  report: ReportSchema,

  completedAt: z.string().datetime(),
}).strict();

const AttemptSchema = z.object({
  version: z.literal(1),
  inputHash: HashSchema,
  jobId: IdSchema,
  startedAt: z.string().datetime(),
}).strict();

export type PersistentMediaManifest = z.infer<
  typeof ManifestSchema
>;

export interface PersistentMediaResolutionOptions {
  storageRoot: string;

  allowNonBillableRecovery?: boolean;

  resolveJobDirectory?: (jobId: string) => string;

  coordinator: {
    run(
      request: MediaResolutionRequest,
    ): Promise<MediaResolutionReport>;
  };

  assetVerifier: {
    verify(asset: MediaAsset): Promise<boolean>;
  };

  rightsChecker: {
    check(
      asset: MediaAsset,
    ): Promise<
      "approved" | "review_required" | "rejected"
    >;
  };
}

function sha256(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function isCode(
  error: unknown,
  code: string,
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}

export function createMediaStageInputHash(
  input: PersistentMediaInput,
): string {
  const checked =
    PersistentMediaInputSchema.parse(input);

  return sha256(
    JSON.stringify(checked),
  );
}

async function publishOnce(
  filename: string,
  value: unknown,
): Promise<boolean> {
  const directory = path.dirname(filename);

  await mkdir(directory, {
    recursive: true,
  });

  const temporary = path.join(
    directory,
    `.${randomUUID()}.tmp`,
  );

  await writeFile(
    temporary,
    JSON.stringify(value, null, 2),
    { flag: "wx" },
  );

  try {
    try {
      await link(temporary, filename);
      return true;
    } catch (error) {
      if (isCode(error, "EEXIST")) {
        return false;
      }

      throw error;
    }
  } finally {
    await unlink(temporary).catch(
      (error: unknown) => {
        if (!isCode(error, "ENOENT")) {
          throw error;
        }
      },
    );
  }
}

export class PersistentMediaResolutionStage {
  private readonly root: string;

  constructor(
    private readonly options:
      PersistentMediaResolutionOptions,
  ) {
    if (!options.storageRoot.trim()) {
      throw new Error("storageRoot is required");
    }

    this.root = path.resolve(
      options.storageRoot,
    );
  }

  private jobDirectory(jobId: string): string {
    if (this.options.resolveJobDirectory) {
      return this.options.resolveJobDirectory(jobId);
    }

    // Avoid user-controlled filenames and traversal.
    const key = sha256(jobId);

    return path.join(
      this.root,
      "media-resolution",
      key,
    );
  }

  private attemptPath(jobId: string): string {
    return path.join(
      this.jobDirectory(jobId),
      "attempt.json",
    );
  }

  private manifestPath(jobId: string): string {
    return path.join(
      this.jobDirectory(jobId),
      "manifest.json",
    );
  }

  private async loadManifest(
    jobId: string,
  ): Promise<PersistentMediaManifest | null> {
    let raw: string;

    try {
      raw = await readFile(
        this.manifestPath(jobId),
        "utf8",
      );
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return null;
      }

      throw error;
    }

    return ManifestSchema.parse(
      JSON.parse(raw),
    );
  }

  private async loadAttempt(
    jobId: string,
  ): Promise<z.infer<typeof AttemptSchema> | null> {
    let raw: string;

    try {
      raw = await readFile(
        this.attemptPath(jobId),
        "utf8",
      );
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return null;
      }

      throw error;
    }

    return AttemptSchema.parse(
      JSON.parse(raw),
    );
  }

  private validateReport(
    input: PersistentMediaInput,
    report: MediaResolutionReport,
  ): void {
    const checked = ReportSchema.parse(report);

    verifyMediaResolutionReport(
      input.request,
      checked,
    );

    if (
      checked.jobId !== input.jobId ||
      checked.mode !== input.request.mode ||
      checked.expectedShots !==
        input.request.shotIds.length
    ) {
      throw new Error(
        "Media report does not match stage input",
      );
    }

    const expected = new Set(
      input.request.shotIds,
    );

    const assignedIds = new Set<string>();

    for (const assignment of checked.assignments) {
      if (
        !expected.has(assignment.shotId) ||
        assignedIds.has(assignment.shotId) ||
        assignment.mode !== checked.mode
      ) {
        throw new Error(
          "Media report contains invalid shot assignments",
        );
      }

      assignedIds.add(
        assignment.shotId,
      );
    }

    if (
      checked.assignedShots !==
        checked.assignments.length
    ) {
      throw new Error(
        "Media report assignment count mismatch",
      );
    }

    if (checked.passed) {
      if (
        assignedIds.size !== expected.size ||
        checked.issues.some(
          (issue) =>
            issue.severity === "blocker",
        )
      ) {
        throw new Error(
          "Media report falsely claims completion",
        );
      }
    }
  }

  private async reverify(
    manifest: PersistentMediaManifest,
  ): Promise<void> {
    if (!manifest.report.passed) {
      throw new Error(
        "Cannot reuse failed media resolution",
      );
    }

    for (const assignment of manifest.report.assignments) {
      const verified =
        await this.options.assetVerifier.verify(
          assignment.asset,
        );

      if (!verified) {
        throw new Error(
          `Stored media verification failed: ${assignment.shotId}`,
        );
      }

      const rights =
        await this.options.rightsChecker.check(
          assignment.asset,
        );

      if (rights !== "approved") {
        throw new Error(
          `Stored media rights not approved: ${assignment.shotId}`,
        );
      }
    }
  }

  async run(
    input: PersistentMediaInput,
  ): Promise<{
    reused: boolean;
    manifest: PersistentMediaManifest;
  }> {
    const checked =
      PersistentMediaInputSchema.parse(input);

    const inputHash =
      createMediaStageInputHash(checked);

    const existing = await this.loadManifest(
      checked.jobId,
    );

    if (existing) {
      if (
        existing.inputHash !== inputHash ||
        existing.storyboardSha256 !==
          checked.storyboardSha256 ||
        existing.mediaPlanSha256 !==
          checked.mediaPlanSha256
      ) {
        throw new Error(
          "Media resolution input changed for existing job",
        );
      }

      this.validateReport(
        checked,
        existing.report,
      );

      await this.reverify(existing);

      return {
        reused: true,
        manifest: existing,
      };
    }

    const priorAttempt = await this.loadAttempt(
      checked.jobId,
    );

    if (priorAttempt) {
      const isPaid =
        (checked.request.mode === "C" && "allowPaidGeneration" in checked.request && checked.request.allowPaidGeneration) ||
        (checked.request.mode === "B" && "allowPaidGeneration" in checked.request && Boolean(checked.request.allowPaidGeneration));

      if (isPaid || !this.options.allowNonBillableRecovery) {
        throw new Error(
          "Media resolution has an incomplete prior attempt; manual recovery required",
        );
      }

      // Safe recovery for non-billable mode: remove stale attempt marker so a new attempt can be recorded
      await unlink(this.attemptPath(checked.jobId)).catch(() => {});
    }

    const attempt = AttemptSchema.parse({
      version: 1,
      inputHash,
      jobId: checked.jobId,
      startedAt: new Date().toISOString(),
    });

    const acquired = await publishOnce(
      this.attemptPath(checked.jobId),
      attempt,
    );

    if (!acquired) {
      throw new Error(
        "Concurrent or incomplete media resolution attempt",
      );
    }

    // The marker is intentionally retained if anything
    // fails. This prevents automatic replay of a possibly
    // billed Mode C request after a crash.
    const report =
      await this.options.coordinator.run(
        checked.request,
      );

    this.validateReport(
      checked,
      report,
    );

    if (!report.passed) {
      const issueSummary = report.issues.map((i) => `[${i.code}] ${i.message}`).join("; ");
      throw new Error(
        `Media resolution failed QA; inspect stage attempt before retry (${issueSummary})`,
      );
    }

    const manifest = ManifestSchema.parse({
      version: 1,
      inputHash,
      jobId: checked.jobId,

      storyboardSha256:
        checked.storyboardSha256,

      mediaPlanSha256:
        checked.mediaPlanSha256,

      stageVersion:
        checked.stageVersion,

      report,
      completedAt: new Date().toISOString(),
    });

    const published = await publishOnce(
      this.manifestPath(checked.jobId),
      manifest,
    );

    if (!published) {
      throw new Error(
        "Media resolution manifest already exists",
      );
    }

    await this.reverify(manifest);

    return {
      reused: false,
      manifest,
    };
  }
}
