import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  loadVerifiedProductionPackage,
  type VerifiedM3PackageAdapter,
} from "./verified-production-package.js";

import {
  createModeBMediaServices,
} from "./mode-b-media-services.js";

import type {
  MediaCandidateProvider,
  MediaRequirement,
} from "./media-resolver.js";

import type {
  PersistentMediaInput,
  PersistentMediaManifest,
} from "./persistent-media-resolution.js";

import type {
  AIImageProvider,
} from "./ai-image-generation.js";

import type {
  ShotMediaResolver,
} from "./media-resolution-coordinator.js";

export interface ModeBProductionPackage {
  storyboard: unknown;

  mediaPlan: {
    mode: "A" | "B" | "C" | "D";
    shots: MediaRequirement[];
  };

  packageHash: string;
}

export interface ModeBPersistentRunnerOptions<
  TPackage extends ModeBProductionPackage,
> {
  storageRoot: string;

  jobDirectory(jobId: string): string;

  m3Adapter: VerifiedM3PackageAdapter<TPackage>;

  providers?(
    jobId: string,
  ): MediaCandidateProvider[];

  aiProvider?(
    jobId: string,
  ): AIImageProvider | undefined;

  aiResolver?(
    jobId: string,
  ): ShotMediaResolver | undefined;

  allowedLocalRoots(
    jobId: string,
  ): string[];

  targetAspectRatio?: number;

  styleGuide?(
    jobId: string,
  ): string | undefined;

  profile?(
    jobId: string,
  ): "explainer" | "documentary" | "story" | undefined;
}

export class ModeBPersistentRunner<
  TPackage extends ModeBProductionPackage,
> {
  constructor(
    private readonly options:
      ModeBPersistentRunnerOptions<TPackage>,
  ) {}

  async run(
    input: PersistentMediaInput,
  ): Promise<{
    reused: boolean;
    manifest: PersistentMediaManifest;
  }> {
    if (
      input.request.mode !== "B" &&
      input.request.mode !== "A" &&
      (input.request.mode !== "C" || !("assignments" in input.request) || !Array.isArray((input.request as any).assignments))
    ) {
      throw new Error(
        "Mode B runner cannot execute another media mode",
      );
    }

    const verified =
      await loadVerifiedProductionPackage({
        jobDirectory:
          this.options.jobDirectory(input.jobId),

        jobId: input.jobId,
        expectedMode: input.request.mode,

        adapter: this.options.m3Adapter,
      });

    if (
      verified.storyboardSha256 !==
        input.storyboardSha256 ||
      verified.mediaPlanSha256 !==
        input.mediaPlanSha256
    ) {
      throw new Error(
        "Persistent media input does not match authoritative M3 hashes",
      );
    }

    if (
      verified.shotIds.length !==
        input.request.shotIds.length ||
      verified.shotIds.some(
        (shotId, index) =>
          shotId !== input.request.shotIds[index],
      )
    ) {
      throw new Error(
        "Persistent media input does not match authoritative M3 shots",
      );
    }

    const requirements =
      verified.package.mediaPlan.shots;

    if (
      requirements.length !==
      verified.shotIds.length
    ) {
      throw new Error(
        "M3 media requirements are incomplete",
      );
    }

    let styleGuide = this.options.styleGuide ? this.options.styleGuide(input.jobId) : undefined;
    let profile = this.options.profile ? this.options.profile(input.jobId) : undefined;

    if (!styleGuide || !profile) {
      try {
        const jobDir = this.options.jobDirectory(input.jobId);
        const candidates = [
          path.join(path.dirname(jobDir), `${input.jobId}.json`),
          path.join(jobDir, `${input.jobId}.json`),
          path.join(jobDir, "job.json"),
        ];
        for (const candidate of candidates) {
          try {
            const raw = await readFile(candidate, "utf8");
            const parsed = JSON.parse(raw);
            const cfg = parsed?.config ?? parsed;
            if (cfg?.styleGuide && !styleGuide) styleGuide = String(cfg.styleGuide);
            if (cfg?.profile && !profile) profile = cfg.profile;
            if (styleGuide && profile) break;
          } catch {}
        }
      } catch {}
    }

    const services = createModeBMediaServices({
      jobId: input.jobId,

      requirements,

      storageRoot: this.options.storageRoot,

      allowedLocalRoots:
        this.options.allowedLocalRoots(
          input.jobId,
        ),

      providers: this.options.providers ? this.options.providers(input.jobId) : [],
      aiProvider: this.options.aiProvider ? this.options.aiProvider(input.jobId) : undefined,
      aiResolver: this.options.aiResolver ? this.options.aiResolver(input.jobId) : undefined,
      targetAspectRatio: this.options.targetAspectRatio,
      styleGuide,
      profile,
    });

    return services.persistentStage.run(input);
  }
}
