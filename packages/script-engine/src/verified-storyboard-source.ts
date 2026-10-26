import path from "node:path";
import { readFile } from "node:fs/promises";
import type { PipelineContext } from "@youcreator/core";

import {
  VideoScriptSchema,
  type VideoScript,
} from "@youcreator/contracts";

import {
  hashScriptContent,
  loadScriptJobArtifacts,
} from "./script-job-artifacts.js";

import {
  ScriptStageOutputSchema,
  validateScriptStageOutput,
} from "./script-stage-output.js";

export async function loadVerifiedStoryboardSource(
  context: PipelineContext,
): Promise<VideoScript> {
  if (!context.outputs.has("script")) {
    throw new Error("Missing script stage output");
  }

  const scriptOutput = ScriptStageOutputSchema.parse(
    context.outputs.get("script"),
  );

  if (scriptOutput.jobId !== context.job.id) {
    throw new Error("M2 script artifact job ID mismatch");
  }

  const expectedDirectory = path.join(
    path.resolve(context.jobDirectory),
    "script",
  );

  if (
    path.resolve(scriptOutput.artifactDirectory) !== expectedDirectory
  ) {
    throw new Error(
      "Script stage output points outside expected job directory",
    );
  }

  await validateScriptStageOutput(scriptOutput);

  const stored = await loadScriptJobArtifacts(
    context.jobDirectory,
    "script",
  );

  if (!stored.integrityVerified) {
    throw new Error(
      "M2 final script integrity verification failed",
    );
  }

  if (
    scriptOutput.generationFingerprint &&
    stored.generationFingerprint &&
    scriptOutput.generationFingerprint !== stored.generationFingerprint
  ) {
    throw new Error(
      "M2 script generation fingerprint mismatch",
    );
  }

  const finalScript = VideoScriptSchema.parse(
    stored.finalScript,
  );

  // Validate that the saved final-script content matches disk
  const diskRaw = await readFile(
    scriptOutput.finalScriptPath,
    "utf8",
  );
  const diskFinalScript = VideoScriptSchema.parse(
    JSON.parse(diskRaw),
  );

  if (
    hashScriptContent(finalScript) !==
    hashScriptContent(diskFinalScript)
  ) {
    throw new Error(
      "M2 final script content mismatch between memory and disk",
    );
  }

  // The checked finalScript is the only authoritative
  // input to storyboard planning.
  return finalScript;
}
