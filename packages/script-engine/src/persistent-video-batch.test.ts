import {
  mkdtemp,
  readFile,
  readdir,
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
  PersistentVideoBatchCoordinator,
  type VideoJobRunner,
} from "./persistent-video-batch.js";

import {
  sha256Batch,
  type VideoBatchSpec,
} from "./video-batch-contract.js";

const H = "a".repeat(64);

function spec(): VideoBatchSpec {
  return {
    version: 1,
    batchId: "batch-acceptance",
    jobs: [
      {
        jobId: "video-a",
        topic: "AI explainers",
        profileId: "explainer",
      },
      {
        jobId: "video-b",
        topic: "Business documentary",
        profileId: "documentary",
      },
      {
        jobId: "video-c",
        topic: "Science story",
        profileId: "story",
      },
    ],
  };
}

describe("M9.5 persistent batch coordinator", () => {
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

  async function fixture(
    concurrency = 2,
  ) {
    directory = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-batch-",
      ),
    );

    const run = vi.fn<
      VideoJobRunner["run"]
    >(async () => ({
      exportHash: H,
    }));

    const create = () =>
      new PersistentVideoBatchCoordinator({
        rootDirectory: directory!,
        concurrency,
        runner: { run },
      });

    const batchDirectory = path.join(
      directory,
      "batches",
      sha256Batch("batch-acceptance"),
    );

    return {
      run,
      create,
      batchDirectory,
    };
  }

  it("runs all video jobs", async () => {
    const test = await fixture();

    const result = await test.create().run(spec());

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(test.run).toHaveBeenCalledTimes(3);
  });

  it("reuses completed jobs after restart", async () => {
    const test = await fixture();

    await test.create().run(spec());
    const second = await test.create().run(spec());

    expect(second.succeeded).toBe(3);
    expect(test.run).toHaveBeenCalledTimes(3);
  });

  it("isolates individual failures", async () => {
    const test = await fixture();

    test.run.mockImplementation(async (job) => {
      if (job.jobId === "video-b") {
        throw new Error("Render failed");
      }
      return { exportHash: H };
    });

    const result = await test.create().run(spec());

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);

    expect(
      result.results.find(
        (r) => r.jobId === "video-b",
      )?.state,
    ).toBe("FAILED");
  });

  it("does not automatically rerun failed jobs", async () => {
    const test = await fixture();

    test.run.mockRejectedValue(
      new Error("Renderer unavailable"),
    );

    await test.create().run(spec());
    await test.create().run(spec());

    expect(test.run).toHaveBeenCalledTimes(3);
  });

  it("rejects changes to an existing batch", async () => {
    const test = await fixture();

    await test.create().run(spec());

    const changed = spec();
    changed.jobs[0]!.topic =
      "Different video topic";

    await expect(
      test.create().run(changed),
    ).rejects.toThrow(
      "M9 immutable batch specification mismatch",
    );
  });

  it("rejects duplicate job IDs", async () => {
    const test = await fixture();
    const input = spec();

    input.jobs[1]!.jobId = "video-a";

    await expect(
      test.create().run(input),
    ).rejects.toThrow(
      "M9 duplicate job IDs in batch",
    );
  });

  it("rejects corrupted journal records", async () => {
    const test = await fixture();

    await test.create().run(spec());

    const eventsDirectory = path.join(
      test.batchDirectory,
      "events",
    );

    const files = (
      await readdir(eventsDirectory)
    ).sort();

    const target = path.join(
      eventsDirectory,
      files[0]!,
    );

    const event = JSON.parse(
      await readFile(target, "utf8"),
    );

    event.result.state = "FAILED";

    await writeFile(
      target,
      JSON.stringify(event),
    );

    await expect(
      test.create().run(spec()),
    ).rejects.toThrow(
      "M9 batch journal integrity mismatch",
    );
  });

  it("rejects invalid concurrency", async () => {
    const test = await fixture(0);

    expect(() =>
      test.create(),
    ).toThrow(
      "M9 concurrency must be between 1 and 16",
    );
  });

  it("returns stable batch identities", async () => {
    const test = await fixture();

    const first = await test.create().run(spec());
    const second = await test.create().run(spec());

    expect(first.batchHash).toBe(
      second.batchHash,
    );
  });
});
