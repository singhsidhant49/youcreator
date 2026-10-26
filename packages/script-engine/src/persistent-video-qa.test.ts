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
  PersistentVideoQaStore,
  getVideoQaPaths,
  type VerifiedVideoQaEvidencePort,
} from "./persistent-video-qa.js";

import type {
  CreateUnifiedVideoQaInput,
} from "./video-qa-release-gate.js";

const H = "a".repeat(64);
const JOB = "m8-native-qa-test";

function evidence(): CreateUnifiedVideoQaInput {
  return {
    composition: {
      jobId: JOB,
      compositionHash: H,
    } as CreateUnifiedVideoQaInput["composition"],

    videoSha256: H,

    frames: {
      inspectedFrames: 3,
      findings: [],
    },

    audio: {
      findings: [],
    } as unknown as CreateUnifiedVideoQaInput["audio"],

    subtitles: {
      jobId: JOB,
      compositionHash: H,
      findings: [],
    } as unknown as CreateUnifiedVideoQaInput["subtitles"],

    variety: {
      jobId: JOB,
      compositionHash: H,
      findings: [],
    } as unknown as CreateUnifiedVideoQaInput["variety"],
  };
}

describe("M8.7 immutable video QA persistence", () => {
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
      path.join(os.tmpdir(), "m8-qa-store-"),
    );

    const current = evidence();

    const load = vi.fn(
      async (_jobId: string) => current,
    );

    const sources: VerifiedVideoQaEvidencePort = {
      load,
    };

    function store() {
      return new PersistentVideoQaStore({
        jobDirectory: () => directory!,
        evidence: sources,
      });
    }

    return {
      current,
      load,
      store,
      paths: getVideoQaPaths(directory, JOB),
    };
  }

  it("persists a canonical PASS report", async () => {
    const test = await fixture();

    const result = await test.store().run(JOB);

    expect(result.reused).toBe(false);
    expect(result.record.report.decision).toBe("PASS");
    expect(result.record.recordHash).toMatch(
      /^[a-f0-9]{64}$/,
    );

    expect(
      await readFile(test.paths.recordPath),
    ).toBeTruthy();
  });

  it("reuses the report across store instances", async () => {
    const test = await fixture();

    await test.store().run(JOB);

    const second = await test.store().run(JOB);

    expect(second.reused).toBe(true);
    expect(test.load).toHaveBeenCalledTimes(2);
  });

  it("validates a committed checkpoint", async () => {
    const test = await fixture();

    const result = await test.store().run(JOB);

    expect(
      await test.store().validate(
        JOB,
        result.checkpoint,
      ),
    ).toBe(true);
  });

  it("persists REVIEW without failing execution", async () => {
    const test = await fixture();

    test.current.variety.findings.push({
      code: "LOW_VISUAL_VARIETY",
      severity: "warning",
      shotIds: ["shot-1"],
      detail: "Repeated compositions",
    });

    const result = await test.store().run(JOB);

    expect(result.record.report.decision).toBe(
      "REVIEW",
    );

    expect(
      await test.store().validate(
        JOB,
        result.checkpoint,
      ),
    ).toBe(true);
  });

  it("persists FAIL without losing findings", async () => {
    const test = await fixture();

    test.current.frames.findings.push({
      code: "BLACK_FRAME",
      severity: "error",
      frame: 1,
      shotId: "shot-1",
      detail: "Black output frame",
    });

    const result = await test.store().run(JOB);

    expect(result.record.report.decision).toBe(
      "FAIL",
    );

    expect(
      result.record.report.blockingCount,
    ).toBe(1);
  });

  it("rejects tampered persisted reports", async () => {
    const test = await fixture();

    await test.store().run(JOB);

    const original = JSON.parse(
      await readFile(
        test.paths.recordPath,
        "utf8",
      ),
    ) as Record<string, unknown>;

    await writeFile(
      test.paths.recordPath,
      JSON.stringify({
        ...original,
        recordHash: "b".repeat(64),
      }),
    );

    await expect(
      test.store().run(JOB),
    ).rejects.toThrow(
      "M8 QA record integrity mismatch",
    );
  });

  it("rejects changes to immutable QA evidence", async () => {
    const test = await fixture();

    await test.store().run(JOB);

    test.current.videoSha256 =
      "c".repeat(64);

    await expect(
      test.store().run(JOB),
    ).rejects.toThrow(
      "M8 QA immutable record dependency mismatch",
    );
  });

  it("rejects incorrectly owned checkpoints", async () => {
    const test = await fixture();

    const result = await test.store().run(JOB);

    expect(
      await test.store().validate(
        JOB,
        {
          ...result.checkpoint,
          jobId: "another-job",
        },
      ),
    ).toBe(false);
  });

  it("isolates versioned policy QA records using policyId", async () => {
    const test = await fixture();
    const defaultResult = await test.store().run(JOB);

    const calibratedStore = new PersistentVideoQaStore({
      jobDirectory: () => directory!,
      evidence: { load: vi.fn(async () => test.current) },
      policy: { policyId: "calibrated-v1" },
    });
    const calibratedResult = await calibratedStore.run(JOB);

    expect(calibratedResult.record.report.policyId).toBe("calibrated-v1");
    expect(defaultResult.record.report.policyId).toBeUndefined();

    const reloadedDefault = await test.store().load(JOB);
    expect(reloadedDefault?.recordHash).toBe(defaultResult.record.recordHash);
  });
});
