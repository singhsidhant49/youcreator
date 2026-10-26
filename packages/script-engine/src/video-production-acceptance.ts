import {
  readFile,
  stat,
} from "node:fs/promises";

import path from "node:path";
import { z } from "zod";

import {
  exportSha256,
  verifyVideoExportManifest,
  type VideoExportManifest,
} from "./video-export-contract.js";

import type {
  VideoBatchJob,
} from "./video-batch-contract.js";

import type {
  PersistentVideoExportStore,
} from "./persistent-video-export.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const ProductionAcceptanceSpecSchema =
  z.object({
    version: z.literal(1),
    job: z.object({
      jobId: z.string().min(1),
      topic: z.string().min(1),
      profileId: z.string().min(1),
    }).strict(),
    requireCaptions: z.boolean(),
    requireThumbnail: z.boolean(),
    minimumDurationSeconds: z.number()
      .positive(),
    durationToleranceSeconds: z.number()
      .nonnegative()
      .optional(),
  }).strict();

export type ProductionAcceptanceSpec =
  z.infer<typeof ProductionAcceptanceSpecSchema>;

export interface ProductionVideoExecutor {
  /**
   * Must invoke the real M1 JobExecutor.
   * Must complete through video_export.
   */
  execute(job: VideoBatchJob): Promise<void>;
}

export interface VerifiedProductionArtifacts {
  directory: string;
  manifest: VideoExportManifest;
}

export interface ProductionArtifactReader {
  /**
   * Must use the M9.4 read-only
   * loadVerifiedManifest() operation.
   */
  loadVerified(
    jobId: string,
  ): Promise<VerifiedProductionArtifacts | null>;
}

export interface VideoProductionAcceptanceOptions {
  executor: ProductionVideoExecutor;
  artifacts: ProductionArtifactReader;
}

export interface ProductionAcceptanceResult {
  jobId: string;
  profileId: string;
  topic: string;
  exportHash: string;
  videoSha256: string;
  durationSeconds: number;
  fileCount: number;
  directory: string;
}

export async function verifyProductionExport(
  spec: ProductionAcceptanceSpec,
  committed: VerifiedProductionArtifacts,
): Promise<ProductionAcceptanceResult> {
  const policy =
    ProductionAcceptanceSpecSchema.parse(spec);

  const manifest =
    verifyVideoExportManifest(
      committed.manifest,
    );

  if (
    manifest.jobId !== policy.job.jobId ||
    !Hash.safeParse(
      manifest.videoSha256,
    ).success
  ) {
    throw new Error(
      "M9.7 export identity mismatch",
    );
  }

  const durationSeconds =
    manifest.totalFrames / manifest.fps;

  const minDurationAllowed =
    policy.minimumDurationSeconds -
    (policy.durationToleranceSeconds ?? 0);

  if (
    durationSeconds < minDurationAllowed
  ) {
    throw new Error(
      `M9.7 output video too short: ${durationSeconds}s < ${minDurationAllowed}s (minimum: ${policy.minimumDurationSeconds}s, tolerance: ${policy.durationToleranceSeconds ?? 0}s)`,
    );
  }

  const files = new Map(
    manifest.files.map((file) => [
      file.filename,
      file,
    ]),
  );

  const required = [
    "video.mp4",
    "metadata.json",
    "qa-report.json",
  ];

  if (policy.requireCaptions) {
    required.push(
      "subtitles.srt",
      "subtitles.vtt",
    );
  }

  if (policy.requireThumbnail) {
    required.push("thumbnail.png");
  }

  for (const filename of required) {
    if (!files.has(
      filename as Parameters<
        typeof files.has
      >[0]
    )) {
      throw new Error(
        `M9.7 required artifact missing: ${filename}`,
      );
    }
  }

  if (!path.isAbsolute(committed.directory)) {
    throw new Error(
      "M9.7 export directory must be absolute",
    );
  }

  for (const file of manifest.files) {
    const location = path.join(
      committed.directory,
      file.filename,
    );

    const info = await stat(location);

    if (
      !info.isFile() ||
      info.size !== file.bytes
    ) {
      throw new Error(
        `M9.7 artifact size mismatch: ${file.filename}`,
      );
    }

    const bytes = await readFile(location);

    if (
      exportSha256(bytes) !== file.sha256
    ) {
      throw new Error(
        `M9.7 artifact SHA mismatch: ${file.filename}`,
      );
    }
  }

  if (
    files.get("video.mp4")?.sha256 !==
    manifest.videoSha256
  ) {
    throw new Error(
      "M9.7 MP4 identity mismatch",
    );
  }

  const qa = JSON.parse(
    await readFile(
      path.join(
        committed.directory,
        "qa-report.json",
      ),
      "utf8",
    ),
  ) as {
    decision?: string;
    reportHash?: string;
    videoSha256?: string;
  };

  if (
    qa.decision !== "PASS" ||
    qa.reportHash !==
      manifest.qaReportHash ||
    qa.videoSha256 !==
      manifest.videoSha256
  ) {
    throw new Error(
      "M9.7 QA authorization mismatch",
    );
  }

  if (policy.requireCaptions) {
    const srt = await readFile(
      path.join(
        committed.directory,
        "subtitles.srt",
      ),
      "utf8",
    );

    const vtt = await readFile(
      path.join(
        committed.directory,
        "subtitles.vtt",
      ),
      "utf8",
    );

    if (
      !srt.includes(" --> ") ||
      !vtt.startsWith("WEBVTT") ||
      !vtt.includes(" --> ")
    ) {
      throw new Error(
        "M9.7 external captions missing or invalid",
      );
    }
  }

  return {
    jobId: policy.job.jobId,
    profileId: policy.job.profileId,
    topic: policy.job.topic,
    exportHash: manifest.exportHash,
    videoSha256: manifest.videoSha256,
    durationSeconds,
    fileCount: manifest.files.length,
    directory: committed.directory,
  };
}

export class VideoProductionAcceptanceRunner {
  constructor(
    private readonly options:
      VideoProductionAcceptanceOptions,
  ) {}

  async run(
    candidate: ProductionAcceptanceSpec,
  ): Promise<ProductionAcceptanceResult> {
    const spec =
      ProductionAcceptanceSpecSchema.parse(
        candidate,
      );

    await this.options.executor.execute(
      spec.job,
    );

    const committed =
      await this.options.artifacts.loadVerified(
        spec.job.jobId,
      );

    if (!committed) {
      throw new Error(
        "M9.7 no verified export produced",
      );
    }

    return verifyProductionExport(
      spec,
      committed,
    );
  }
}

export function createProductionAcceptanceRunner(
  executeExistingPipeline:
    ProductionVideoExecutor["execute"],
  exportStore: PersistentVideoExportStore,
  jobDirectory: (jobId: string) => string,
): VideoProductionAcceptanceRunner {
  const executor: ProductionVideoExecutor = {
    execute: executeExistingPipeline,
  };

  const artifacts: ProductionArtifactReader = {
    async loadVerified(jobId) {
      const manifest =
        await exportStore.loadVerifiedManifest(
          jobId,
        );

      if (!manifest) {
        return null;
      }

      return {
        directory:
          path.join(jobDirectory(jobId), "export"),
        manifest,
      };
    },
  };

  return new VideoProductionAcceptanceRunner({
    executor,
    artifacts,
  });
}
