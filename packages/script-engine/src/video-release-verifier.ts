import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  type PersistentRemotionVideoStore,
  getRemotionVideoPaths,
} from "./persistent-remotion-video.js";

import {
  type PersistentVideoQaStore,
} from "./persistent-video-qa.js";

import {
  verifyFinalVideo,
} from "./remotion-ffprobe-verifier.js";

import {
  createVideoReleaseManifest,
  type VerifiedReleaseEvidence,
  type VideoReleaseManifest,
} from "./video-release-manifest.js";

export interface VideoReleaseVerifierOptions {
  jobDirectory(jobId: string): string;
  videoStore: PersistentRemotionVideoStore;
  qaStore: PersistentVideoQaStore;

  /**
   * Optional for environments where the
   * ffprobe executable is not on PATH.
   */
  ffprobePath?: string;
}

export class VideoReleaseVerifier {
  constructor(
    private readonly options:
      VideoReleaseVerifierOptions,
  ) {}

  async verify(
    jobId: string,
  ): Promise<{
    manifest: VideoReleaseManifest;
    videoPath: string;
  }> {
    if (!jobId.trim()) {
      throw new Error(
        "M9 release requires job ID",
      );
    }

    const videoRecordResult =
      await this.options.videoStore.run(jobId);

    const videoRecord =
      videoRecordResult.record;

    const videoCheckpointValid =
      await this.options.videoStore.validate(
        jobId,
        videoRecordResult.checkpoint,
      );

    if (!videoCheckpointValid) {
      throw new Error(
        "M9 video checkpoint invalid",
      );
    }

    // Do not create missing QA at release time.
    const qaRecord =
      await this.options.qaStore.load(jobId);

    if (!qaRecord) {
      throw new Error(
        "M9 QA report is missing",
      );
    }

    const qaCheckpoint = {
      version: 1 as const,
      jobId: qaRecord.jobId,
      videoSha256: qaRecord.videoSha256,
      compositionHash: qaRecord.compositionHash,
      reportHash: qaRecord.report.reportHash,
      recordHash: qaRecord.recordHash,
      decision: qaRecord.report.decision,
    };

    const qaCheckpointValid =
      await this.options.qaStore.validate(
        jobId,
        qaCheckpoint,
      );

    if (!qaCheckpointValid) {
      throw new Error(
        "M9 QA checkpoint invalid",
      );
    }

    if (
      videoRecord.jobId !== jobId ||
      qaRecord.jobId !== jobId ||
      qaRecord.report.jobId !== jobId ||
      qaRecord.videoSha256 !==
        videoRecord.videoSha256 ||
      qaRecord.compositionHash !==
        videoRecord.compositionHash ||
      qaRecord.report.videoSha256 !==
        videoRecord.videoSha256
    ) {
      throw new Error(
        "M9 release dependency mismatch",
      );
    }

    if (
      qaRecord.report.decision !== "PASS"
    ) {
      throw new Error(
        `M9 publication blocked: ${qaRecord.report.decision}`,
      );
    }

    const paths = getRemotionVideoPaths(
      this.options.jobDirectory(jobId),
      jobId,
    );

    const before = await stat(
      paths.videoPath,
    );

    if (
      !before.isFile() ||
      before.size !==
        videoRecord.videoBytes
    ) {
      throw new Error(
        "M9 video file size mismatch",
      );
    }

    const bytes = await readFile(
      paths.videoPath,
    );

    const currentSha = createHash("sha256")
      .update(bytes)
      .digest("hex");

    if (
      bytes.length !== videoRecord.videoBytes ||
      currentSha !== videoRecord.videoSha256
    ) {
      throw new Error(
        "M9 video SHA-256 mismatch",
      );
    }

    await verifyFinalVideo(
      paths.videoPath,
      {
        width: videoRecord.width,
        height: videoRecord.height,
        fps: videoRecord.fps,
        totalFrames: videoRecord.totalFrames,
      },
      this.options.ffprobePath,
    );

    const after = await stat(
      paths.videoPath,
    );

    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      throw new Error(
        "M9 video changed during verification",
      );
    }

    const evidence: VerifiedReleaseEvidence = {
      jobId,
      compositionHash:
        videoRecord.compositionHash,
      captionPlanHash:
        videoRecord.captionPlanHash,
      videoSha256:
        videoRecord.videoSha256,
      videoBytes:
        videoRecord.videoBytes,
      qaReportHash:
        qaRecord.report.reportHash,
      qaRecordHash:
        qaRecord.recordHash,
      qaDecision:
        qaRecord.report.decision,
      codec: videoRecord.codec,
      audioCodec: videoRecord.audioCodec,
      fps: videoRecord.fps,
      width: videoRecord.width,
      height: videoRecord.height,
      totalFrames: videoRecord.totalFrames,
    };

    return {
      manifest:
        createVideoReleaseManifest(evidence),
      videoPath: paths.videoPath,
    };
  }
}
