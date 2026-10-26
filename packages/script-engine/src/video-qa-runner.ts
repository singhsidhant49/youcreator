import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  RemotionCompositionSchema,
  type RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  PersistedRemotionVideoSchema,
  type PersistedRemotionVideo,
} from "./persistent-remotion-video.js";

import {
  verifyFinalVideo,
} from "./remotion-ffprobe-verifier.js";

import {
  createVideoQaFramePlan,
  verifyVideoQaFramePlan,
  type VideoQaFramePlanOptions,
} from "./video-qa-frame-plan.js";

import {
  analyzeVideoQaFrames,
  VideoQaFrameFindingSchema,
  type VideoQaFrameThresholds,
  type DecodedQaFrame,
} from "./video-qa-frame-analyzer.js";

import {
  extractVideoQaFrames,
  type QaFrameExtractorOptions,
} from "./video-qa-frame-extractor.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const VideoQaReportSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),

  compositionHash: Hash,
  videoSha256: Hash,
  framePlanHash: Hash,

  sampledFrames: z.number().int().safe().positive(),

  findings: z.array(
    VideoQaFrameFindingSchema,
  ),

  reportHash: Hash,
}).strict();

export type VideoQaReport = z.infer<
  typeof VideoQaReportSchema
>;

export interface VideoQaRunnerOptions {
  framePlan?: VideoQaFramePlanOptions;
  thresholds?: VideoQaFrameThresholds;
  extractor?: QaFrameExtractorOptions;
}

export interface VideoQaRunnerPorts {
  extract(
    path: string,
    frames: readonly number[],
    options: QaFrameExtractorOptions,
  ): Promise<DecodedQaFrame[]>;

  verifyVideo(
    path: string,
    expected: {
      fps: number;
      width: number;
      height: number;
      totalFrames: number;
    },
  ): Promise<void>;
}

export const productionVideoQaPorts: VideoQaRunnerPorts = {
  extract: extractVideoQaFrames,

  async verifyVideo(path, expected) {
    await verifyFinalVideo(
      path,
      expected,
    );
  },
};

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export async function runVideoQa(
  input: {
    videoPath: string;
    composition: RemotionComposition;
    record: PersistedRemotionVideo;
  },
  options: VideoQaRunnerOptions = {},
  ports: VideoQaRunnerPorts =
    productionVideoQaPorts,
): Promise<VideoQaReport> {
  const composition =
    RemotionCompositionSchema.parse(
      input.composition,
    );

  const record =
    PersistedRemotionVideoSchema.parse(
      input.record,
    );

  if (
    composition.jobId !== record.jobId ||
    composition.compositionHash !==
      record.compositionHash ||
    composition.fps !== record.fps ||
    composition.width !== record.width ||
    composition.height !== record.height ||
    composition.totalFrames !==
      record.totalFrames
  ) {
    throw new Error(
      "M8 video QA upstream dependency mismatch",
    );
  }

  const videoBytes = await readFile(
    input.videoPath,
  );

  if (videoBytes.length !== record.videoBytes) {
    throw new Error(
      "M8 video QA byte length mismatch",
    );
  }

  const actualSha256 = createHash("sha256")
    .update(videoBytes)
    .digest("hex");

  if (actualSha256 !== record.videoSha256) {
    throw new Error(
      "M8 video QA SHA-256 mismatch",
    );
  }

  await ports.verifyVideo(
    input.videoPath,
    {
      fps: composition.fps,
      width: composition.width,
      height: composition.height,
      totalFrames: composition.totalFrames,
    },
  );

  const framePlan =
    createVideoQaFramePlan(
      composition,
      options.framePlan,
    );

  verifyVideoQaFramePlan(
    framePlan,
    composition,
    options.framePlan,
  );

  const frames = await ports.extract(
    input.videoPath,
    framePlan.samples.map(
      (sample) => sample.frame,
    ),
    options.extractor ?? {},
  );

  const analysis =
    await analyzeVideoQaFrames(
      composition,
      framePlan,
      frames,
      options.thresholds,
    );

  const finalVideoBytes = await readFile(
    input.videoPath,
  );

  if (
    finalVideoBytes.length !== record.videoBytes ||
    createHash("sha256")
      .update(finalVideoBytes)
      .digest("hex") !== record.videoSha256
  ) {
    throw new Error(
      "M8 video changed during QA extraction",
    );
  }

  const payload = {
    version: 1 as const,
    jobId: composition.jobId,
    compositionHash:
      composition.compositionHash,
    videoSha256:
      record.videoSha256,
    framePlanHash:
      framePlan.planHash,
    sampledFrames:
      analysis.inspectedFrames,
    findings: analysis.findings,
  };

  return VideoQaReportSchema.parse({
    ...payload,
    reportHash: hash(payload),
  });
}
