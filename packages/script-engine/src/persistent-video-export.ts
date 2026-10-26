import {
  constants,
} from "node:fs";

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";

import path from "node:path";

import {
  verifyRemotionCaptionPlan,
  type RemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  verifyVideoReleaseManifest,
  type VideoReleaseManifest,
  type VerifiedReleaseEvidence,
} from "./video-release-manifest.js";

import {
  ExportMetadataSchema,
  createVideoExportManifest,
  exportSha256,
  verifyVideoExportManifest,
  type ExportFile,
  type ExportMetadata,
  type VideoExportManifest,
} from "./video-export-contract.js";

import {
  createExternalSubtitles,
} from "./video-export-subtitles.js";

export interface VerifiedExportSources {
  release: VideoReleaseManifest;
  releaseEvidence: VerifiedReleaseEvidence;
  composition: RemotionComposition;
  captionPlan: RemotionCaptionPlan;

  videoPath: string;
  qaReportJson: string;

  metadata: ExportMetadata;

  /**
   * Optional PNG validated by trusted upstream
   * image metadata and rights checks.
   */
  thumbnailPath?: string;
}

export interface VerifiedExportSourcePort {
  load(jobId: string): Promise<VerifiedExportSources>;
}

export interface VideoExportOptions {
  jobDirectory(jobId: string): string;
  sources: VerifiedExportSourcePort;
}

export interface VideoExportResult {
  reused: boolean;
  directory: string;
  manifest: VideoExportManifest;
}

const REQUIRED_FILES = [
  "video.mp4",
  "subtitles.srt",
  "subtitles.vtt",
  "metadata.json",
  "qa-report.json",
] as const;

function filePath(
  directory: string,
  filename: string,
): string {
  return path.join(directory, filename);
}

async function verifiedFile(
  directory: string,
  filename: ExportFile["filename"],
): Promise<ExportFile> {
  const file = filePath(directory, filename);
  const info = await stat(file);

  if (
    !info.isFile() ||
    (info.size === 0 && filename !== "subtitles.srt")
  ) {
    throw new Error(
      `M9 missing or empty export file: ${filename}`,
    );
  }

  const bytes = await readFile(file);

  return {
    filename,
    sha256: exportSha256(bytes),
    bytes: bytes.length,
  };
}

async function createText(
  destination: string,
  content: string,
): Promise<void> {
  await writeFile(
    destination,
    content,
    { flag: "wx" },
  );
}

export class PersistentVideoExportStore {
  constructor(
    private readonly options: VideoExportOptions,
  ) {}

  private directory(jobId: string): string {
    const base =
      this.options.jobDirectory(jobId);

    if (
      !path.isAbsolute(base) ||
      !jobId.trim()
    ) {
      throw new Error(
        "M9 export requires absolute job directory",
      );
    }

    return path.join(base, "export");
  }

  private async prepare(jobId: string) {
    const source =
      await this.options.sources.load(jobId);

    const release =
      verifyVideoReleaseManifest(
        source.release,
        source.releaseEvidence,
      );

    const captions =
      verifyRemotionCaptionPlan(
        source.captionPlan,
        source.composition,
      );

    const metadata =
      ExportMetadataSchema.parse(
        source.metadata,
      );

    if (
      jobId !== release.jobId ||
      source.composition.jobId !== jobId ||
      source.composition.compositionHash !==
        release.compositionHash ||
      captions.captionPlanHash !==
        release.captionPlanHash
    ) {
      throw new Error(
        "M9 export source identity mismatch",
      );
    }

    if (
      !path.isAbsolute(source.videoPath) ||
      (
        source.thumbnailPath !== undefined &&
        !path.isAbsolute(
          source.thumbnailPath,
        )
      )
    ) {
      throw new Error(
        "M9 export source paths must be absolute",
      );
    }

    const videoBytes = await readFile(
      source.videoPath,
    );

    if (
      videoBytes.length !== release.videoBytes ||
      exportSha256(videoBytes) !==
        release.videoSha256
    ) {
      throw new Error(
        "M9 source video SHA-256 mismatch",
      );
    }

    const qaBytes = Buffer.from(
      source.qaReportJson,
      "utf8",
    );

    const qaReport = JSON.parse(
      qaBytes.toString("utf8"),
    ) as {
      reportHash?: string;
      decision?: string;
      videoSha256?: string;
    };

    if (
      qaReport.decision !== "PASS" ||
      qaReport.reportHash !==
        release.qaReportHash ||
      qaReport.videoSha256 !==
        release.videoSha256
    ) {
      throw new Error(
        "M9 export QA evidence mismatch",
      );
    }

    const subtitles =
      createExternalSubtitles(captions);

    return {
      source,
      release,
      captions,
      metadata,
      subtitles,
    };
  }

  private async verifyDirectory(
    directory: string,
    expected: ReturnType<
      PersistentVideoExportStore["prepare"]
    > extends Promise<infer T> ? T : never,
  ): Promise<VideoExportManifest> {
    const raw = await readFile(
      filePath(directory, "manifest.json"),
      "utf8",
    );

    const manifest =
      verifyVideoExportManifest(
        JSON.parse(raw),
      );

    const { release, captions, metadata } =
      expected;

    if (
      manifest.jobId !== release.jobId ||
      manifest.releaseHash !==
        release.releaseHash ||
      manifest.compositionHash !==
        release.compositionHash ||
      manifest.captionPlanHash !==
        captions.captionPlanHash ||
      manifest.videoSha256 !==
        release.videoSha256 ||
      manifest.qaReportHash !==
        release.qaReportHash ||
      manifest.metadataHash !==
        exportSha256(
          JSON.stringify(metadata),
        ) ||
      manifest.fps !== release.fps ||
      manifest.totalFrames !==
        release.totalFrames ||
      manifest.width !== release.width ||
      manifest.height !== release.height
    ) {
      throw new Error(
        "M9 export dependency mismatch",
      );
    }

    const allowed = new Set([
      "manifest.json",
      ...manifest.files.map(
        (file) => file.filename,
      ),
    ]);

    const names = await readdir(directory);

    if (
      names.length !== allowed.size ||
      names.some((name) => !allowed.has(name))
    ) {
      throw new Error(
        "M9 export directory inventory mismatch",
      );
    }

    for (const file of manifest.files) {
      const actual = await verifiedFile(
        directory,
        file.filename,
      );

      if (
        actual.sha256 !== file.sha256 ||
        actual.bytes !== file.bytes
      ) {
        throw new Error(
          `M9 exported file integrity mismatch: ${file.filename}`,
        );
      }
    }

    if (
      manifest.files.find(
        (file) => file.filename === "video.mp4",
      )?.sha256 !== release.videoSha256
    ) {
      throw new Error(
        "M9 exported MP4 identity mismatch",
      );
    }

    const expectedText = new Map([
      [
        "subtitles.srt",
        expected.subtitles.srt,
      ],
      [
        "subtitles.vtt",
        expected.subtitles.vtt,
      ],
      [
        "metadata.json",
        JSON.stringify(metadata, null, 2) + "\n",
      ],
      [
        "qa-report.json",
        expected.source.qaReportJson,
      ],
    ]);

    for (const [filename, content] of expectedText) {
      const actual = await readFile(
        filePath(directory, filename),
        "utf8",
      );

      if (actual !== content) {
        throw new Error(
          `M9 export source dependency changed: ${filename}`,
        );
      }
    }

    return manifest;
  }

  async run(jobId: string): Promise<VideoExportResult> {
    const expected = await this.prepare(jobId);
    const directory = this.directory(jobId);

    try {
      const manifest =
        await this.verifyDirectory(
          directory,
          expected,
        );

      return {
        reused: true,
        directory,
        manifest,
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !==
        "ENOENT"
      ) {
        throw error;
      }
    }

    // Never adopt or silently repair a partially
    // exported directory after a worker crash.
    const parent = path.dirname(directory);

    await mkdir(parent, { recursive: true });

    try {
      await mkdir(directory);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "EEXIST"
      ) {
        throw new Error(
          "M9 export already exists but is incomplete",
        );
      }

      throw error;
    }

    const { source, release, captions, metadata } =
      expected;

    await copyFile(
      source.videoPath,
      filePath(directory, "video.mp4"),
      constants.COPYFILE_EXCL,
    );

    await createText(
      filePath(directory, "subtitles.srt"),
      expected.subtitles.srt,
    );

    await createText(
      filePath(directory, "subtitles.vtt"),
      expected.subtitles.vtt,
    );

    await createText(
      filePath(directory, "metadata.json"),
      JSON.stringify(metadata, null, 2) + "\n",
    );

    await createText(
      filePath(directory, "qa-report.json"),
      source.qaReportJson,
    );

    const filenames: ExportFile["filename"][] = [
      ...REQUIRED_FILES,
    ];

    if (source.thumbnailPath) {
      await copyFile(
        source.thumbnailPath,
        filePath(directory, "thumbnail.png"),
        constants.COPYFILE_EXCL,
      );

      filenames.push("thumbnail.png");
    }

    const files = await Promise.all(
      filenames.map(
        (name) => verifiedFile(directory, name),
      ),
    );

    if (
      files.find(
        (file) => file.filename === "video.mp4",
      )?.sha256 !== release.videoSha256
    ) {
      throw new Error(
        "M9 MP4 changed during export",
      );
    }

    const payload = {
      version: 1 as const,
      jobId,
      releaseHash: release.releaseHash,
      compositionHash: release.compositionHash,
      captionPlanHash:
        captions.captionPlanHash,
      videoSha256: release.videoSha256,
      qaReportHash: release.qaReportHash,
      metadataHash: exportSha256(
        JSON.stringify(metadata),
      ),
      fps: release.fps,
      totalFrames: release.totalFrames,
      width: release.width,
      height: release.height,
      files,
    };

    const manifest =
      createVideoExportManifest(payload);

    // Commit marker written last. Never overwrite.
    await createText(
      filePath(directory, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );

    const verified =
      await this.verifyDirectory(
        directory,
        expected,
      );

    return {
      reused: false,
      directory,
      manifest: verified,
    };
  }

  async validate(jobId: string): Promise<boolean> {
    try {
      const expected = await this.prepare(jobId);

      await this.verifyDirectory(
        this.directory(jobId),
        expected,
      );

      return true;
    } catch {
      return false;
    }
  }

  async loadVerifiedManifest(
    jobId: string,
  ): Promise<VideoExportManifest | null> {
    try {
      const expected = await this.prepare(jobId);
      return await this.verifyDirectory(
        this.directory(jobId),
        expected,
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "ENOENT"
      ) {
        return null;
      }

      throw error;
    }
  }
}

