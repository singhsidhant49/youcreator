import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  RemotionCompositionSchema,
  type RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  verifyRemotionCaptionPlan,
  type RemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import type {
  EditorialMotionPlan,
} from "./editorial-motion-plan.js";

import type {
  EditorialAudioPlan,
} from "./editorial-audio-plan.js";

import {
  renderRemotionMp4,
} from "./remotion-mp4-renderer.js";

import {
  verifyRenderedMp4,
} from "./remotion-output-verifier.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const PositiveInt = z.number().int().safe().positive();

export const PersistedRemotionVideoSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),

  compositionHash: Hash,
  captionPlanHash: Hash,
  motionPlanHash: Hash.optional(),
  audioPlanHash: Hash.optional(),
  editorialAudioPlanHash: Hash.optional(),

  videoSha256: Hash,
  videoBytes: PositiveInt,

  fps: PositiveInt,
  width: PositiveInt,
  height: PositiveInt,
  totalFrames: PositiveInt,

  codec: z.literal("h264"),
  audioCodec: z.literal("aac"),

  recordHash: Hash,
}).strict();

export const RemotionVideoCheckpointSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  recordHash: Hash,
  videoSha256: Hash,
  compositionHash: Hash,
  captionPlanHash: Hash,
  motionPlanHash: Hash.optional(),
  audioPlanHash: Hash.optional(),
  editorialAudioPlanHash: Hash.optional(),
}).strict();

export type PersistedRemotionVideo = z.infer<
  typeof PersistedRemotionVideoSchema
>;

export type RemotionVideoCheckpoint = z.infer<
  typeof RemotionVideoCheckpointSchema
>;

export interface VerifiedM7VideoSources {
  manifest: RemotionComposition;
  captionPlan: RemotionCaptionPlan;
  motionPlan?: EditorialMotionPlan;
  audioPlan?: EditorialAudioPlan;
  musicPath?: string;
}

export interface RemotionVideoSourcePort {
  /**
   * Must load and independently verify the
   * authoritative M7 and upstream M6 artifacts.
   *
   * Must not regenerate narration or media.
   */
  load(jobId: string): Promise<VerifiedM7VideoSources>;
}

export interface RemotionVideoRenderPort {
  render(input: {
    manifest: RemotionComposition;
    captionPlan: RemotionCaptionPlan;
    motionPlan?: EditorialMotionPlan;
    audioPlan?: EditorialAudioPlan;
    musicPath?: string;
    outputPath: string;
    workspaceDir: string;
  }): Promise<void>;
}

export interface RemotionVideoVerificationPort {
  verify(
    outputPath: string,
    expected: {
      fps: number;
      width: number;
      height: number;
      totalFrames: number;
    },
  ): Promise<void>;
}

export interface PersistentRemotionVideoOptions {
  jobDirectory(jobId: string): string;
  sources: RemotionVideoSourcePort;
  renderer: RemotionVideoRenderPort;
  verifier: RemotionVideoVerificationPort;
}

export interface PersistedVideoResult {
  reused: boolean;
  record: PersistedRemotionVideo;
  checkpoint: RemotionVideoCheckpoint;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256")
    .update(data)
    .digest("hex");
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function jobStorageKey(jobId: string): string {
  if (!jobId.trim()) {
    throw new Error("M7 requires a job ID");
  }

  return sha256(jobId);
}

export function getRemotionVideoPaths(
  jobDirectory: string,
  jobId: string,
) {
  if (!path.isAbsolute(jobDirectory)) {
    throw new Error(
      "M7 requires an absolute job directory",
    );
  }

  const directory = path.join(
    jobDirectory,
    "remotion-video",
    jobStorageKey(jobId),
  );

  return {
    directory,
    videoPath: path.join(
      directory,
      "final-video.mp4",
    ),
    recordPath: path.join(
      directory,
      "video-record.json",
    ),
    workspaceDir: path.join(
      jobDirectory,
      "remotion-workspace",
      jobStorageKey(jobId),
    ),
  };
}

function makeCheckpoint(
  record: PersistedRemotionVideo,
): RemotionVideoCheckpoint {
  return {
    version: 1,
    jobId: record.jobId,
    recordHash: record.recordHash,
    videoSha256: record.videoSha256,
    compositionHash: record.compositionHash,
    captionPlanHash: record.captionPlanHash,
    ...(record.motionPlanHash
      ? { motionPlanHash: record.motionPlanHash }
      : {}),
    ...(record.audioPlanHash
      ? { audioPlanHash: record.audioPlanHash }
      : {}),
    ...(record.editorialAudioPlanHash
      ? { editorialAudioPlanHash: record.editorialAudioPlanHash }
      : {}),
  };
}

async function exists(
  file: string,
): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code ===
      "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

async function publishRecord(
  destination: string,
  record: PersistedRemotionVideo,
): Promise<void> {
  const temporary = path.join(
    path.dirname(destination),
    `.video-record-${randomUUID()}.tmp`,
  );

  try {
    await writeFile(
      temporary,
      JSON.stringify(record),
      { flag: "wx" },
    );

    try {
      await link(temporary, destination);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !==
        "EEXIST"
      ) {
        throw error;
      }

      // Another writer published first.
      // The caller must subsequently verify it.
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export class PersistentRemotionVideoStore {
  constructor(
    private readonly options:
      PersistentRemotionVideoOptions,
  ) {}

  private paths(jobId: string) {
    return getRemotionVideoPaths(
      this.options.jobDirectory(jobId),
      jobId,
    );
  }

  private async loadSources(jobId: string) {
    const source = await this.options.sources.load(
      jobId,
    );

    const manifest =
      RemotionCompositionSchema.parse(
        source.manifest,
      );

    const captionPlan =
      verifyRemotionCaptionPlan(
        source.captionPlan,
        manifest,
      );

    if (manifest.jobId !== jobId) {
      throw new Error(
        "M7 video source job identity mismatch",
      );
    }

    return {
      manifest,
      captionPlan,
      ...(source.motionPlan
        ? { motionPlan: source.motionPlan }
        : {}),
      ...(source.audioPlan
        ? { audioPlan: source.audioPlan }
        : {}),
      ...(source.musicPath
        ? { musicPath: source.musicPath }
        : {}),
    };
  }

  private async verifyExisting(
    jobId: string,
    source: VerifiedM7VideoSources,
  ): Promise<PersistedRemotionVideo> {
    const paths = this.paths(jobId);

    const bytes = await readFile(
      paths.recordPath,
    );

    const record =
      PersistedRemotionVideoSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );

    const { recordHash, ...payload } = record;

    if (recordHash !== hashJson(payload)) {
      throw new Error(
        "M7 video record integrity mismatch",
      );
    }

    const expectedAudioHash = source.audioPlan?.planHash;
    const recordAudioHash =
      record.editorialAudioPlanHash ?? record.audioPlanHash;

    if (
      record.jobId !== jobId ||
      record.compositionHash !==
        source.manifest.compositionHash ||
      record.captionPlanHash !==
        source.captionPlan.captionPlanHash ||
      record.motionPlanHash !==
        source.motionPlan?.planHash ||
      recordAudioHash !== expectedAudioHash ||
      record.fps !== source.manifest.fps ||
      record.width !== source.manifest.width ||
      record.height !== source.manifest.height ||
      record.totalFrames !==
        source.manifest.totalFrames
    ) {
      throw new Error(
        "M7 persisted video dependency mismatch",
      );
    }

    const video = await readFile(
      paths.videoPath,
    );

    if (
      video.length !== record.videoBytes ||
      sha256(video) !== record.videoSha256
    ) {
      throw new Error(
        "M7 persisted MP4 SHA-256 mismatch",
      );
    }

    await this.options.verifier.verify(
      paths.videoPath,
      {
        fps: source.manifest.fps,
        width: source.manifest.width,
        height: source.manifest.height,
        totalFrames:
          source.manifest.totalFrames,
      },
    );

    return record;
  }

  async run(
    jobId: string,
  ): Promise<PersistedVideoResult> {
    const source = await this.loadSources(
      jobId,
    );

    const paths = this.paths(jobId);

    // The record is the publication commit marker.
    if (await exists(paths.recordPath)) {
      const record = await this.verifyExisting(
        jobId,
        source,
      );

      return {
        reused: true,
        record,
        checkpoint: makeCheckpoint(record),
      };
    }

    // An orphaned MP4 is not permission to overwrite
    // or silently adopt an uncommitted render.
    if (await exists(paths.videoPath)) {
      throw new Error(
        "M7 uncommitted video artifact exists",
      );
    }

    await mkdir(paths.directory, {
      recursive: true,
    });

    await this.options.renderer.render({
      ...source,
      outputPath: paths.videoPath,
      workspaceDir: paths.workspaceDir,
    });

    const video = await readFile(
      paths.videoPath,
    );

    if (video.length === 0) {
      throw new Error(
        "M7 rendered MP4 is empty",
      );
    }

    await this.options.verifier.verify(
      paths.videoPath,
      {
        fps: source.manifest.fps,
        width: source.manifest.width,
        height: source.manifest.height,
        totalFrames:
          source.manifest.totalFrames,
      },
    );

    const audioPlanHash = source.audioPlan?.planHash;

    const payload = {
      version: 1 as const,
      jobId,
      compositionHash:
        source.manifest.compositionHash,
      captionPlanHash:
        source.captionPlan.captionPlanHash,
      ...(source.motionPlan
        ? { motionPlanHash: source.motionPlan.planHash }
        : {}),
      ...(audioPlanHash
        ? {
            audioPlanHash,
            editorialAudioPlanHash: audioPlanHash,
          }
        : {}),
      videoSha256: sha256(video),
      videoBytes: video.length,
      fps: source.manifest.fps,
      width: source.manifest.width,
      height: source.manifest.height,
      totalFrames:
        source.manifest.totalFrames,
      codec: "h264" as const,
      audioCodec: "aac" as const,
    };

    const record =
      PersistedRemotionVideoSchema.parse({
        ...payload,
        recordHash: hashJson(payload),
      });

    await publishRecord(
      paths.recordPath,
      record,
    );

    // Re-read the published record and MP4.
    // This also handles a concurrent publisher
    // without blindly accepting its result.
    const verified = await this.verifyExisting(
      jobId,
      source,
    );

    return {
      reused: false,
      record: verified,
      checkpoint: makeCheckpoint(verified),
    };
  }

  async validate(
    jobId: string,
    candidate: unknown,
  ): Promise<boolean> {
    const parsed =
      RemotionVideoCheckpointSchema.safeParse(
        candidate,
      );

    if (
      !parsed.success ||
      parsed.data.jobId !== jobId
    ) {
      return false;
    }

    try {
      const source = await this.loadSources(
        jobId,
      );

      const record = await this.verifyExisting(
        jobId,
        source,
      );

      return (
        JSON.stringify(makeCheckpoint(record)) ===
        JSON.stringify(parsed.data)
      );
    } catch {
      return false;
    }
  }
}

/**
 * Production ports based on the verified M7.5
 * renderer and encoded output validator.
 */
export function createProductionVideoPorts(
  entryPoint: string,
  concurrency = 2,
) {
  return {
    renderer: {
      async render(input: {
        manifest: RemotionComposition;
        captionPlan: RemotionCaptionPlan;
        motionPlan?: EditorialMotionPlan;
        audioPlan?: EditorialAudioPlan;
        musicPath?: string;
        outputPath: string;
        workspaceDir: string;
      }) {
        await renderRemotionMp4({
          ...input,
          entryPoint,
          concurrency,
        });
      },
    } satisfies RemotionVideoRenderPort,

    verifier: {
      async verify(
        outputPath: string,
        expected: {
          fps: number;
          width: number;
          height: number;
          totalFrames: number;
        },
      ) {
        await verifyRenderedMp4(
          outputPath,
          expected,
        );
      },
    } satisfies RemotionVideoVerificationPort,
  };
}
