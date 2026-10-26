import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  assembleTrustedVisualPackage,
  type VerifiedM3VisualArtifact,
  type VerifiedM4VisualArtifact,
  type TrustedVisualArtifactSources,
} from "./trusted-visual-artifact-assembly.js";

const JOB_ID = "job-m5-trusted";
const PACKAGE_HASH = "a".repeat(64);

function m3Artifact(): VerifiedM3VisualArtifact {
  return {
    jobId: JOB_ID,
    packageHash: PACKAGE_HASH,
    mode: "B",
    shotIds: ["shot-001", "shot-002"],
    timings: [
      {
        shotId: "shot-001",
        startSeconds: 0,
        endSeconds: 3,
      },
      {
        shotId: "shot-002",
        startSeconds: 3,
        endSeconds: 7,
      },
    ],
  };
}

function m4Artifact(): VerifiedM4VisualArtifact {
  return {
    jobId: JOB_ID,
    mode: "B",
    productionPackageHash: PACKAGE_HASH,
    manifestHash: "b".repeat(64),

    report: {
      version: 1,
      jobId: JOB_ID,
      mode: "B",
      expectedShots: 2,
      assignedShots: 0,
      outcomes: [],
      assignments: [],
      issues: [],
      passed: false,
    },
  };
}

function fixture(
  m3 = m3Artifact(),
  m4 = m4Artifact(),
) {
  const m3Load = vi.fn(async () => m3);
  const m4Load = vi.fn(async () => m4);

  const sources: TrustedVisualArtifactSources = {
    m3: { load: m3Load },
    m4: { load: m4Load },
  };

  return {
    sources,
    m3Load,
    m4Load,
    input: {
      jobId: JOB_ID,
      jobDirectory: "/tmp/m5-trusted/jobs/job-001",
      storageRoot: "/tmp/m5-trusted/media",
      sources,
    },
  };
}

describe("Trusted M3/M4 visual artifact assembly", () => {
  it("rejects a mismatched verified M3 job", async () => {
    const test = fixture({
      ...m3Artifact(),
      jobId: "another-job",
    });

    await expect(
      assembleTrustedVisualPackage(test.input),
    ).rejects.toThrow(
      "Verified M3 job identity",
    );

    expect(test.m4Load).not.toHaveBeenCalled();
  });

  it("rejects reordered M3 timeline shots", async () => {
    const m3 = m3Artifact();

    m3.timings.reverse();

    const test = fixture(m3);

    await expect(
      assembleTrustedVisualPackage(test.input),
    ).rejects.toThrow(
      "M3 timeline shot order",
    );

    expect(test.m4Load).not.toHaveBeenCalled();
  });

  it("rejects M3 timeline gaps", async () => {
    const m3 = m3Artifact();

    m3.timings[1]!.startSeconds = 3.5;

    const test = fixture(m3);

    await expect(
      assembleTrustedVisualPackage(test.input),
    ).rejects.toThrow(
      "M3 timeline discontinuity",
    );

    expect(test.m4Load).not.toHaveBeenCalled();
  });

  it("rejects mismatched M4 package identity", async () => {
    const m4 = m4Artifact();

    m4.productionPackageHash = "c".repeat(64);

    const test = fixture(m3Artifact(), m4);

    await expect(
      assembleTrustedVisualPackage(test.input),
    ).rejects.toThrow(
      "Verified M4 artifact identity mismatch",
    );

    expect(test.m4Load).toHaveBeenCalledOnce();
  });

  it("rejects incomplete M4 reports", async () => {
    const test = fixture();

    await expect(
      assembleTrustedVisualPackage(test.input),
    ).rejects.toThrow(
      "Verified M4 report is incomplete",
    );
  });

  it("rejects duplicate M3 shot IDs", async () => {
    const m3 = m3Artifact();

    m3.shotIds[1] = "shot-001";

    const test = fixture(m3);

    await expect(
      assembleTrustedVisualPackage(test.input),
    ).rejects.toThrow(
      "M3 shot sequence is empty or contains duplicates",
    );

    expect(test.m4Load).not.toHaveBeenCalled();
  });
});
