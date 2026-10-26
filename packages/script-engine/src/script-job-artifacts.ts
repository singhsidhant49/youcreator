import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import path from "node:path";
import { z } from "zod";

import {
  VideoScriptSchema,
  type VideoScript,
} from "@youcreator/contracts";

import type {
  LLMBudgetUsage,
} from "@youcreator/llm";

export interface ScriptJobArtifactInput {
  originalScript: VideoScript;
  finalScript: VideoScript;
  llmUsage: LLMBudgetUsage;
  promotion: {
    promoted: boolean;
    reason: string;
  };
  generationFingerprint?: string;
}

export interface ScriptJobArtifacts
  extends ScriptJobArtifactInput {
  jobId: string;
  reportVersion: number;
  integrityVerified: boolean;
}

const LLMBudgetUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  failedRequests: z.number().int().nonnegative(),
  reservedOutputTokens: z.number().int().nonnegative(),
  reportedInputTokens: z.number().int().nonnegative(),
  reportedOutputTokens: z.number().int().nonnegative(),
}).strict().refine(
  (usage) => usage.failedRequests <= usage.requests,
  {
    message: "Failed requests cannot exceed total requests",
  },
);

const PromotionMetadataSchema = z.object({
  promoted: z.boolean(),
  reason: z.string().min(1),
}).strict();

const ScriptContentHashesSchema = z.object({
  originalScript: z.string().regex(/^[a-f0-9]{64}$/),
  finalScript: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function hashScriptContent(
  input: VideoScript,
): string {
  const script = VideoScriptSchema.parse(input);

  return createHash("sha256")
    .update(JSON.stringify(script))
    .digest("hex");
}

export const ScriptGenerationReportSchema = z.object({
  version: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
  ]),

  jobId: z.string().regex(/^[a-zA-Z0-9_-]+$/),

  generationFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),

  contentHashes: ScriptContentHashesSchema.optional(),

  llmUsage: LLMBudgetUsageSchema,

  promotion: PromotionMetadataSchema,
}).strict()
.superRefine((report, context) => {
  if (
    report.version === 3 &&
    report.contentHashes === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Version 3 requires script content hashes",
      path: ["contentHashes"],
    });
  }

  if (
    report.version !== 3 &&
    report.contentHashes !== undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Legacy reports cannot contain content hashes",
      path: ["contentHashes"],
    });
  }
});

export type ScriptGenerationReport = z.infer<
  typeof ScriptGenerationReportSchema
>;

function validateJobId(jobId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    throw new Error("Invalid job ID");
  }
}

async function writeJson(
  filename: string,
  value: unknown,
): Promise<void> {
  await writeFile(
    filename,
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

export async function saveScriptJobArtifacts(
  outputRoot: string,
  jobId: string,
  input: ScriptJobArtifactInput,
): Promise<string> {
  validateJobId(jobId);

  const originalScript =
    VideoScriptSchema.parse(input.originalScript);

  const finalScript =
    VideoScriptSchema.parse(input.finalScript);

  const jobsRoot = path.resolve(outputRoot);

  await mkdir(jobsRoot, {
    recursive: true,
  });

  const jobDirectory = path.join(
    jobsRoot,
    jobId,
  );

  // This initial artifact store is create-only.
  // Do not silently overwrite an existing result.
  try {
    await stat(jobDirectory);
    throw new Error(
      `Script artifacts already exist for job ${jobId}`,
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const temporaryDirectory = await mkdtemp(
    path.join(jobsRoot, ".script-tmp-"),
  );

  try {
    await writeJson(
      path.join(temporaryDirectory, "original-script.json"),
      originalScript,
    );

    await writeJson(
      path.join(temporaryDirectory, "final-script.json"),
      finalScript,
    );

    const generationReport =
      ScriptGenerationReportSchema.parse({
        version: 3,
        jobId,

        generationFingerprint:
          input.generationFingerprint ?? null,

        contentHashes: {
          originalScript: hashScriptContent(originalScript),
          finalScript: hashScriptContent(finalScript),
        },

        llmUsage: input.llmUsage,
        promotion: input.promotion,
      });

    await writeJson(
      path.join(
        temporaryDirectory,
        "generation-report.json",
      ),
      generationReport,
    );

    // Files are prepared before the final directory
    // becomes visible to consumers.
    await rename(
      temporaryDirectory,
      jobDirectory,
    );
  } catch (error) {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });

    throw error;
  }

  return jobDirectory;
}

export async function loadScriptJobArtifacts(
  outputRoot: string,
  jobId: string,
): Promise<ScriptJobArtifacts> {
  validateJobId(jobId);

  const jobDirectory = path.join(
    path.resolve(outputRoot),
    jobId,
  );

  const [originalRaw, finalRaw, reportRaw] =
    await Promise.all([
      readFile(
        path.join(jobDirectory, "original-script.json"),
        "utf8",
      ),
      readFile(
        path.join(jobDirectory, "final-script.json"),
        "utf8",
      ),
      readFile(
        path.join(jobDirectory, "generation-report.json"),
        "utf8",
      ),
    ]);

  const originalScript =
    VideoScriptSchema.parse(JSON.parse(originalRaw));

  const finalScript =
    VideoScriptSchema.parse(JSON.parse(finalRaw));

  const report = ScriptGenerationReportSchema.parse(
    JSON.parse(reportRaw),
  );

  if (report.jobId !== jobId) {
    throw new Error(
      "Script generation report job ID mismatch",
    );
  }

  let integrityVerified = false;

  if (report.version === 3) {
    const expected = report.contentHashes;

    if (!expected) {
      throw new Error(
        "Script content integrity hashes missing",
      );
    }

    const originalHash = hashScriptContent(originalScript);
    const finalHash = hashScriptContent(finalScript);

    if (
      originalHash !== expected.originalScript ||
      finalHash !== expected.finalScript
    ) {
      throw new Error(
        "Script artifact content integrity mismatch",
      );
    }

    integrityVerified = true;
  }

  return {
    jobId,
    originalScript,
    finalScript,

    llmUsage: report.llmUsage,
    promotion: report.promotion,

    generationFingerprint:
      report.generationFingerprint ?? undefined,

    reportVersion: report.version,
    integrityVerified,
  };
}
