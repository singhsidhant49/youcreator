import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createVideoExportManifest,
  exportSha256,
  type ExportFile,
  type VideoExportManifest,
} from "./video-export-contract.js";

import {
  VideoProductionAcceptanceRunner,
  verifyProductionExport,
  type ProductionAcceptanceSpec,
} from "./video-production-acceptance.js";

const H = "a".repeat(64);

const JOB = {
  jobId: "m9-real-file-acceptance",
  topic: "Why Humans Procrastinate",
  profileId: "explainer",
};

function acceptanceSpec():
  ProductionAcceptanceSpec {
  return {
    version: 1,
    job: { ...JOB },
    requireCaptions: true,
    requireThumbnail: false,
    minimumDurationSeconds: 30,
  };
}

describe("M9.7 production export acceptance", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
    directory = undefined;
  });

  async function fixture() {
    directory = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-production-",
      ),
    );

    const video = Buffer.from(
      "test-video-bytes",
    );

    const videoSha = exportSha256(video);

    const qa = {
      decision: "PASS",
      reportHash: H,
      videoSha256: videoSha,
    };

    const entries: Array<{
      filename: ExportFile["filename"];
      bytes: Buffer;
    }> = [
      {
        filename: "video.mp4",
        bytes: video,
      },
      {
        filename: "subtitles.srt",
        bytes: Buffer.from(
          "1\n00:00:00,000 --> 00:00:02,000\nHello world.\n",
        ),
      },
      {
        filename: "subtitles.vtt",
        bytes: Buffer.from(
          "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world.\n",
        ),
      },
      {
        filename: "metadata.json",
        bytes: Buffer.from(
          '{"title":"Test video"}\n',
        ),
      },
      {
        filename: "qa-report.json",
        bytes: Buffer.from(
          JSON.stringify(qa),
        ),
      },
    ];

    for (const entry of entries) {
      await writeFile(
        path.join(
          directory,
          entry.filename,
        ),
        entry.bytes,
      );
    }

    const files = entries.map(
      (entry): ExportFile => ({
        filename: entry.filename,
        sha256: exportSha256(
          entry.bytes,
        ),
        bytes: entry.bytes.length,
      }),
    );

    const manifest =
      createVideoExportManifest({
        version: 1,
        jobId: JOB.jobId,
        releaseHash: H,
        compositionHash: H,
        captionPlanHash: H,
        videoSha256: videoSha,
        qaReportHash: H,
        metadataHash: H,
        fps: 30,
        totalFrames: 1800,
        width: 1920,
        height: 1080,
        files,
      });

    return {
      manifest,
      directory,
      videoSha,
    };
  }

  it("accepts a complete hashed export", async () => {
    const data = await fixture();

    const result = await verifyProductionExport(
      acceptanceSpec(),
      data,
    );

    expect(result.jobId).toBe(
      JOB.jobId,
    );

    expect(result.durationSeconds).toBe(60);
    expect(result.fileCount).toBe(5);
    expect(result.videoSha256).toBe(
      data.videoSha,
    );
  });

  it("rejects MP4 corruption", async () => {
    const data = await fixture();

    await writeFile(
      path.join(data.directory, "video.mp4"),
      Buffer.from("corrupted-video"),
    );

    await expect(
      verifyProductionExport(
        acceptanceSpec(),
        data,
      ),
    ).rejects.toThrow(
      /M9.7 artifact (size|SHA) mismatch/,
    );
  });

  it("rejects caption corruption", async () => {
    const data = await fixture();

    await writeFile(
      path.join(
        data.directory,
        "subtitles.vtt",
      ),
      "WEBVTT\n\ncorrupted",
    );

    await expect(
      verifyProductionExport(
        acceptanceSpec(),
        data,
      ),
    ).rejects.toThrow(
      /M9.7 artifact (size|SHA) mismatch/,
    );
  });

  it("rejects QA decision changes", async () => {
    const data = await fixture();

    const qaPath = path.join(
      data.directory,
      "qa-report.json",
    );

    const qa = JSON.parse(
      await readFile(qaPath, "utf8"),
    );

    qa.decision = "FAIL";

    const altered = Buffer.from(
      JSON.stringify(qa),
    );

    await writeFile(qaPath, altered);

    // Even if a malicious or defective producer
    // updates file inventory, QA PASS is checked
    // independently.
    const files = data.manifest.files.map(
      (file) =>
        file.filename === "qa-report.json"
          ? {
              ...file,
              sha256: exportSha256(altered),
              bytes: altered.length,
            }
          : file,
    );

    const { exportHash: _oldHash, ...payload } =
      data.manifest;

    const forgedManifest =
      createVideoExportManifest({
        ...payload,
        files,
      });

    await expect(
      verifyProductionExport(
        acceptanceSpec(),
        {
          directory: data.directory,
          manifest: forgedManifest,
        },
      ),
    ).rejects.toThrow(
      "M9.7 QA authorization mismatch",
    );
  });

  it("rejects insufficient duration", async () => {
    const data = await fixture();

    await expect(
      verifyProductionExport(
        {
          ...acceptanceSpec(),
          minimumDurationSeconds: 120,
        },
        data,
      ),
    ).rejects.toThrow(
      "M9.7 output video too short",
    );
  });

  it("rejects a missing required thumbnail", async () => {
    const data = await fixture();

    await expect(
      verifyProductionExport(
        {
          ...acceptanceSpec(),
          requireThumbnail: true,
        },
        data,
      ),
    ).rejects.toThrow(
      "M9.7 required artifact missing: thumbnail.png",
    );
  });

  it("calls the injected job executor", async () => {
    const data = await fixture();

    const execute = vi.fn(
      async () => undefined,
    );

    const runner =
      new VideoProductionAcceptanceRunner({
        executor: { execute },
        artifacts: {
          async loadVerified() {
            return data;
          },
        },
      });

    const result = await runner.run(
      acceptanceSpec(),
    );

    expect(execute).toHaveBeenCalledWith(JOB);
    expect(result.exportHash).toBe(
      data.manifest.exportHash,
    );
  });

  it("fails if no verified export exists", async () => {
    const runner =
      new VideoProductionAcceptanceRunner({
        executor: {
          async execute() {},
        },
        artifacts: {
          async loadVerified() {
            return null;
          },
        },
      });

    await expect(
      runner.run(acceptanceSpec()),
    ).rejects.toThrow(
      "M9.7 no verified export produced",
    );
  });

  it("allows export within durationToleranceSeconds", async () => {
    const data = await fixture();
    const spec = acceptanceSpec();
    spec.minimumDurationSeconds = 65;
    spec.durationToleranceSeconds = 6;
    const result = await verifyProductionExport(spec, data);
    expect(result.durationSeconds).toBe(60);
  });

  it("rejects export exceeding durationToleranceSeconds", async () => {
    const data = await fixture();
    const spec = acceptanceSpec();
    spec.minimumDurationSeconds = 65;
    spec.durationToleranceSeconds = 3;
    await expect(verifyProductionExport(spec, data)).rejects.toThrow(
      "M9.7 output video too short",
    );
  });
});
