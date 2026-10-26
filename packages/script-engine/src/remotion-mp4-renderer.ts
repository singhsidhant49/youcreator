import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  selectComposition,
} from "@remotion/renderer";
import webpack from "webpack";

import {
  RemotionCompositionSchema,
  type RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  type RemotionCaptionPlan,
  verifyRemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import type {
  EditorialMotionPlan,
} from "./editorial-motion-plan.js";

import type {
  EditorialAudioPlan,
} from "./editorial-audio-plan.js";

import {
  stageRemotionImages,
} from "./remotion-media-resolver.js";

import {
  stageRemotionAudio,
  stageRemotionMusic,
} from "./remotion-audio-resolver.js";

import {
  verifyRenderedMp4,
} from "./remotion-output-verifier.js";

const COMPOSITION_ID =
  "YouCreatorNarratedV1" as const;

export interface RenderRemotionMp4Input {
  /**
   * Obtained from the authoritative M7 loader.
   * Must already have passed native source
   * verification, including media rights.
   */
  manifest: RemotionComposition;

  captionPlan: RemotionCaptionPlan;
  motionPlan?: EditorialMotionPlan;
  audioPlan?: EditorialAudioPlan;
  musicPath?: string;

  /**
   * Absolute, private directory unique to this
   * rendering attempt.
   */
  workspaceDir: string;

  /**
   * Absolute destination; must not exist.
   */
  outputPath: string;

  /**
   * Absolute path to remotion-entry.tsx.
   */
  entryPoint: string;

  concurrency?: number;
}

export interface RenderRemotionMp4Result {
  jobId: string;
  compositionHash: string;
  captionPlanHash: string;
  motionPlanHash?: string;
  audioPlanHash?: string;
  editorialAudioPlanHash?: string;
  outputPath: string;
  bytes: number;
  codec: "h264";
  audioCodec: "aac";
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
}

/**
 * Publish an already verified temporary MP4.
 * Never replace an existing destination.
 *
 * Hard linking keeps publication on the same
 * filesystem atomic. The temp and destination
 * should be siblings.
 */
export async function publishVerifiedMp4(
  temporaryPath: string,
  outputPath: string,
): Promise<number> {
  if (
    !path.isAbsolute(temporaryPath) ||
    !path.isAbsolute(outputPath)
  ) {
    throw new Error(
      "M7 publication requires absolute paths",
    );
  }

  if (
    path.dirname(temporaryPath) !==
    path.dirname(outputPath)
  ) {
    throw new Error(
      "M7 publication paths must share a directory",
    );
  }

  const temporary = await stat(
    temporaryPath,
  );

  if (
    !temporary.isFile() ||
    temporary.size <= 0
  ) {
    throw new Error(
      "M7 temporary MP4 is empty or invalid",
    );
  }

  // Refuse publication if the destination
  // already exists, including concurrent writers.
  try {
    await link(
      temporaryPath,
      outputPath,
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code ===
      "EEXIST"
    ) {
      throw new Error(
        "M7 final MP4 already exists",
      );
    }

    throw error;
  }

  const published = await stat(
    outputPath,
  );

  if (
    !published.isFile() ||
    published.size !== temporary.size
  ) {
    throw new Error(
      "M7 published MP4 size mismatch",
    );
  }

  return published.size;
}

/**
 * Render a verified YouCreator composition.
 *
 * M7.5 renders once. M7.6 will add durable
 * checkpoints, result hashes and resume.
 */
export async function renderRemotionMp4(
  input: RenderRemotionMp4Input,
): Promise<RenderRemotionMp4Result> {
  const manifest =
    RemotionCompositionSchema.parse(
      input.manifest,
    );

  const captionPlan =
    verifyRemotionCaptionPlan(
      input.captionPlan,
      manifest,
    );

  if (
    !path.isAbsolute(input.workspaceDir) ||
    !path.isAbsolute(input.outputPath) ||
    !path.isAbsolute(input.entryPoint)
  ) {
    throw new Error(
      "M7 renderer requires absolute paths",
    );
  }

  if (
    input.concurrency !== undefined &&
    (
      !Number.isSafeInteger(input.concurrency) ||
      input.concurrency < 1
    )
  ) {
    throw new Error(
      "Invalid M7 renderer concurrency",
    );
  }

  const workspace = path.resolve(
    input.workspaceDir,
  );

  const publicDir = path.join(
    workspace,
    "public",
  );

  const outputDirectory = path.dirname(
    input.outputPath,
  );

  if (
    workspace === outputDirectory ||
    workspace.startsWith(
      `${outputDirectory}${path.sep}`,
    ) ||
    outputDirectory.startsWith(
      `${workspace}${path.sep}`,
    )
  ) {
    throw new Error(
      "M7 workspace and output directory must be separate",
    );
  }

  await mkdir(workspace, {
    recursive: true,
  });

  await mkdir(outputDirectory, {
    recursive: true,
  });

  const temporaryPath = path.join(
    outputDirectory,
    `.youcreator-${randomUUID()}.mp4`,
  );

  try {
    const images = await stageRemotionImages(
      manifest,
      publicDir,
    );

    const audio = await stageRemotionAudio(
      manifest,
      publicDir,
    );

    let musicUrl: string | undefined;
    if (
      input.audioPlan?.musicEnabled &&
      input.musicPath &&
      input.audioPlan.music
    ) {
      const stagedMusic = await stageRemotionMusic(
        input.musicPath,
        input.audioPlan.music.sha256,
        publicDir,
      );
      musicUrl = stagedMusic.musicUrl;
    }

    const inputProps = {
      manifest,
      imageUrls: images.imageUrls,
      audioUrl: audio.audioUrl,
      musicUrl,
      captionPlan,
      motionPlan: input.motionPlan,
      audioPlan: input.audioPlan,
    };

    // Bundling includes the verified images
    // and WAV from this job's dedicated publicDir.
    const serveUrl = await bundle({
      entryPoint: input.entryPoint,
      publicDir,
      outDir: path.join(
        workspace,
        "bundle",
      ),
      webpackOverride: (current) => ({
        ...current,
        plugins: [
          ...(current.plugins ?? []),
          new webpack.NormalModuleReplacementPlugin(
            /^node:/,
            (resource: { request: string }) => {
              resource.request = resource.request.replace(/^node:/, "");
            },
          ),
        ],
        resolve: {
          ...current.resolve,
          alias: {
            ...current.resolve?.alias,
            sharp: false,
          },
          extensionAlias: {
            ".js": [".ts", ".tsx", ".js"],
            ".jsx": [".tsx", ".jsx"],
          },
          fallback: {
            ...current.resolve?.fallback,
            child_process: false,
            fs: false,
            path: false,
            crypto: false,
            os: false,
          },
        },
      }),
    });

    const composition =
      await selectComposition({
        serveUrl,
        id: COMPOSITION_ID,
        inputProps,
      });

    if (
      composition.width !== manifest.width ||
      composition.height !== manifest.height ||
      composition.fps !== manifest.fps ||
      composition.durationInFrames !==
        manifest.totalFrames
    ) {
      throw new Error(
        "M7 selected composition metadata mismatch",
      );
    }

    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      codec: "h264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
      outputLocation: temporaryPath,
      ...(input.concurrency === undefined
        ? {}
        : { concurrency: input.concurrency }),
    });

    await verifyRenderedMp4(
      temporaryPath,
      {
        fps: manifest.fps,
        width: manifest.width,
        height: manifest.height,
        totalFrames: manifest.totalFrames,
      },
    );

    const bytes =
      await publishVerifiedMp4(
        temporaryPath,
        input.outputPath,
      );

    return {
      jobId: manifest.jobId,
      compositionHash:
        manifest.compositionHash,
      captionPlanHash:
        captionPlan.captionPlanHash,
      motionPlanHash:
        input.motionPlan?.planHash,
      audioPlanHash:
        input.audioPlan?.planHash,
      editorialAudioPlanHash:
        input.audioPlan?.planHash,
      outputPath: input.outputPath,
      bytes,
      codec: "h264",
      audioCodec: "aac",
      fps: manifest.fps,
      width: manifest.width,
      height: manifest.height,
      totalFrames: manifest.totalFrames,
    };
  } finally {
    await rm(temporaryPath, {
      force: true,
    });
  }
}
