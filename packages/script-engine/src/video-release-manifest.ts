import { createHash } from "node:crypto";
import { z } from "zod";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const PositiveInt = z.number().int().safe().positive();

export const VideoReleaseManifestSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),

  compositionHash: Hash,
  captionPlanHash: Hash,

  videoSha256: Hash,
  videoBytes: PositiveInt,

  qaReportHash: Hash,
  qaRecordHash: Hash,

  decision: z.literal("PASS"),

  codec: z.literal("h264"),
  audioCodec: z.literal("aac"),

  fps: PositiveInt,
  width: PositiveInt,
  height: PositiveInt,
  totalFrames: PositiveInt,

  releaseHash: Hash,
}).strict();

export type VideoReleaseManifest = z.infer<
  typeof VideoReleaseManifestSchema
>;

export interface VerifiedReleaseEvidence {
  jobId: string;

  compositionHash: string;
  captionPlanHash: string;

  videoSha256: string;
  videoBytes: number;

  qaReportHash: string;
  qaRecordHash: string;

  qaDecision: "PASS" | "REVIEW" | "FAIL";

  codec: "h264";
  audioCodec: "aac";

  fps: number;
  width: number;
  height: number;
  totalFrames: number;
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function createVideoReleaseManifest(
  evidence: VerifiedReleaseEvidence,
): VideoReleaseManifest {
  if (evidence.qaDecision !== "PASS") {
    throw new Error(
      `M9 publication blocked: ${evidence.qaDecision}`,
    );
  }

  const payload = {
    version: 1 as const,
    jobId: evidence.jobId,

    compositionHash: evidence.compositionHash,
    captionPlanHash: evidence.captionPlanHash,

    videoSha256: evidence.videoSha256,
    videoBytes: evidence.videoBytes,

    qaReportHash: evidence.qaReportHash,
    qaRecordHash: evidence.qaRecordHash,

    decision: "PASS" as const,

    codec: evidence.codec,
    audioCodec: evidence.audioCodec,

    fps: evidence.fps,
    width: evidence.width,
    height: evidence.height,
    totalFrames: evidence.totalFrames,
  };

  const manifest = VideoReleaseManifestSchema.parse({
    ...payload,
    releaseHash: hashJson(payload),
  });

  return manifest;
}

export function verifyVideoReleaseManifest(
  candidate: unknown,
  evidence: VerifiedReleaseEvidence,
): VideoReleaseManifest {
  const saved =
    VideoReleaseManifestSchema.parse(candidate);

  const expected =
    createVideoReleaseManifest(evidence);

  if (
    JSON.stringify(saved) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      "M9 release manifest reconstruction mismatch",
    );
  }

  return saved;
}
