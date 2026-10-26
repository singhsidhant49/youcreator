import path from "node:path";
import { z } from "zod";

import {
  loadScriptJobArtifacts,
} from "./script-job-artifacts.js";

export const ScriptStageOutputSchema = z.object({
  jobId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  artifactDirectory: z.string().min(1),
  originalScriptPath: z.string().min(1),
  finalScriptPath: z.string().min(1),
  reportPath: z.string().min(1),
  promoted: z.boolean(),
  llmRequests: z.number().int().nonnegative(),
  generationFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
}).strict();

export type ValidatedScriptStageOutput = z.infer<
  typeof ScriptStageOutputSchema
>;

export async function validateScriptStageOutput(
  value: unknown,
): Promise<ValidatedScriptStageOutput> {
  const output = ScriptStageOutputSchema.parse(value);

  const expectedDirectory = path.resolve(
    output.artifactDirectory,
  );

  // Derive the expected paths instead of trusting
  // arbitrary paths from a saved checkpoint.
  const expectedFiles = {
    originalScriptPath: path.join(
      expectedDirectory,
      "original-script.json",
    ),
    finalScriptPath: path.join(
      expectedDirectory,
      "final-script.json",
    ),
    reportPath: path.join(
      expectedDirectory,
      "generation-report.json",
    ),
  };

  if (
    !path.isAbsolute(output.artifactDirectory) ||
    output.originalScriptPath !==
      expectedFiles.originalScriptPath ||
    output.finalScriptPath !==
      expectedFiles.finalScriptPath ||
    output.reportPath !== expectedFiles.reportPath
  ) {
    throw new Error(
      "Script stage output contains inconsistent artifact paths",
    );
  }

  const stored = await loadScriptJobArtifacts(
    path.dirname(expectedDirectory),
    path.basename(expectedDirectory),
  );

  if (
    stored.promotion.promoted !== output.promoted ||
    stored.llmUsage.requests !== output.llmRequests
  ) {
    throw new Error(
      "Script checkpoint metadata does not match stored artifacts",
    );
  }

  return output;
}
