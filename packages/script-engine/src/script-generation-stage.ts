import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  VideoBriefSchema,
  type VideoBriefInput,
} from "@youcreator/contracts";

import type {
  ScriptGenerationServiceResult,
} from "./script-generation-service.js";

import {
  loadScriptJobArtifacts,
  saveScriptJobArtifacts,
} from "./script-job-artifacts.js";

import {
  ScriptLockOwnerSchema,
} from "./script-lock-inspector.js";

export interface ScriptStageGenerator {
  generate(
    brief: VideoBriefInput,
  ): Promise<
    Pick<
      ScriptGenerationServiceResult,
      | "script"
      | "finalScript"
      | "llmUsage"
      | "promotion"
    >
  >;
}

export interface ScriptStageInput {
  jobId: string;
  brief: VideoBriefInput;
  jobsRoot: string;

  // Must change whenever the model, prompts, generation
  // parameters, or relevant implementation changes.
  generationKey: string;
}

export interface ScriptStageOutput {
  jobId: string;
  artifactDirectory: string;
  originalScriptPath: string;
  finalScriptPath: string;
  reportPath: string;
  promoted: boolean;
  llmRequests: number;
}

function validateJobId(jobId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    throw new Error("Invalid job ID");
  }
}

export function generationFingerprint(
  brief: VideoBriefInput,
  generationKey: string,
): string {
  if (!generationKey.trim()) {
    throw new Error("Generation key is required");
  }

  return createHash("sha256")
    .update(
      JSON.stringify({
        stageVersion: 2,
        brief: VideoBriefSchema.parse(brief),
        generationKey,
      }),
    )
    .digest("hex");
}

export class ScriptGenerationStage {
  constructor(
    private readonly generator: ScriptStageGenerator,
  ) {}

  async execute(
    input: ScriptStageInput,
  ): Promise<ScriptStageOutput> {
    // Validate before accessing the filesystem.
    validateJobId(input.jobId);

    const brief = VideoBriefSchema.parse(input.brief);

    // Validate configuration before acquiring the lock.
    generationFingerprint(
      brief,
      input.generationKey,
    );

    const jobRoot = path.join(
      path.resolve(input.jobsRoot),
      input.jobId,
    );

    await mkdir(jobRoot, {
      recursive: true,
    });

    const lockDirectory = path.join(
      jobRoot,
      ".script-generation.lock",
    );

    try {
      // mkdir without recursive:true is atomic for an
      // individual directory path on the local filesystem.
      await mkdir(lockDirectory);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new Error(
          `Script generation already running for job ${input.jobId}`,
        );
      }

      throw error;
    }

    try {
      const owner = ScriptLockOwnerSchema.parse({
        version: 1,
        jobId: input.jobId,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      });

      await writeFile(
        path.join(lockDirectory, "owner.json"),
        JSON.stringify(owner, null, 2),
        { encoding: "utf8", flag: "wx" },
      );

      return await this.executeUnlocked(input);
    } finally {
      await rm(lockDirectory, {
        recursive: true,
        force: true,
      });
    }
  }

  private async executeUnlocked(
    input: ScriptStageInput,
  ): Promise<ScriptStageOutput> {
    validateJobId(input.jobId);

    const brief = VideoBriefSchema.parse(input.brief);

    const fingerprint = generationFingerprint(
      brief,
      input.generationKey,
    );

    const jobRoot = path.join(
      path.resolve(input.jobsRoot),
      input.jobId,
    );

    const artifactDirectory = path.join(
      jobRoot,
      "script",
    );

    const toOutput = (
      promoted: boolean,
      requests: number,
    ): ScriptStageOutput => ({
      jobId: input.jobId,
      artifactDirectory,
      originalScriptPath: path.join(
        artifactDirectory,
        "original-script.json",
      ),
      finalScriptPath: path.join(
        artifactDirectory,
        "final-script.json",
      ),
      reportPath: path.join(
        artifactDirectory,
        "generation-report.json",
      ),
      promoted,
      llmRequests: requests,
    });

    let artifactsExist = false;

    try {
      await access(artifactDirectory);
      artifactsExist = true;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }

    if (artifactsExist) {
      // Never regenerate just because an existing
      // artifact fails validation.
      const stored = await loadScriptJobArtifacts(
        jobRoot,
        "script",
      );

      if (!stored.integrityVerified) {
        throw new Error(
          "Legacy script artifacts require integrity migration",
        );
      }

      if (
        stored.generationFingerprint !== fingerprint
      ) {
        throw new Error(
          "Script artifact fingerprint mismatch",
        );
      }

      return toOutput(
        stored.promotion.promoted,
        stored.llmUsage.requests,
      );
    }

    const result = await this.generator.generate(brief);

    await saveScriptJobArtifacts(
      jobRoot,
      "script",
      {
        originalScript: result.script,
        finalScript: result.finalScript,
        llmUsage: result.llmUsage,
        promotion: {
          promoted: result.promotion.promoted,
          reason: result.promotion.reason,
        },
        generationFingerprint: fingerprint,
      },
    );

    const stored = await loadScriptJobArtifacts(
      jobRoot,
      "script",
    );

    if (
      !stored.integrityVerified ||
      stored.generationFingerprint !== fingerprint
    ) {
      throw new Error(
        "Script artifact verification failed",
      );
    }

    return toOutput(
      stored.promotion.promoted,
      stored.llmUsage.requests,
    );
  }
}
