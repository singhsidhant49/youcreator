import {
  describe,
  expect,
  it,
} from "vitest";

import type { MediaAsset } from "@youcreator/contracts";

import type {
  AssignedMedia,
} from "./assigned-media.js";

import type {
  MediaResolutionReport,
} from "./media-resolution-coordinator.js";

import {
  createShotMediaBindings,
} from "./shot-media-binding.js";

const JOB_ID = "job-m5-001";
const PACKAGE_HASH = "a".repeat(64);
const MANIFEST_HASH = "b".repeat(64);

function asset(letter: string): MediaAsset {
  return {
    version: 1,
    id: `asset-${letter}`,
    kind: "image",
    localPath: `/objects/${letter}.png`,
    sha256: letter.repeat(64),
    bytes: 100,
    mimeType: "image/png",
    width: 1920,
    height: 1080,
    provenance: {
      source: "local_library",
      providerAssetId: `bank-${letter}`,
      license: {
        status: "unknown",
      },
    },
    createdAt: "2026-10-13T10:00:00.000Z",
  };
}

function assignment(
  shotId: string,
  letter: string,
): AssignedMedia {
  return {
    version: 1,
    shotId,
    mode: "B",
    assignmentSource: "local_library",
    assignedAt: "2026-10-13T10:00:00.000Z",
    asset: asset(letter),
  };
}

function fixture() {
  const request = {
    jobId: JOB_ID,
    mode: "B" as const,
    shotIds: [
      "shot-002",
      "shot-001",
    ],
  };

  const second = assignment("shot-002", "c");
  const first = assignment("shot-001", "d");

  const report: MediaResolutionReport = {
    version: 1,
    jobId: JOB_ID,
    mode: "B",
    expectedShots: 2,
    assignedShots: 2,

    outcomes: [
      {
        status: "assigned",
        assignment: first,
      },
      {
        status: "assigned",
        assignment: second,
      },
    ],

    assignments: [first, second],
    issues: [],
    passed: true,
  };

  return {
    request,
    report,
    productionPackageHash: PACKAGE_HASH,
    mediaManifestHash: MANIFEST_HASH,
  };
}

describe("Canonical shot-to-media binding", () => {
  it("preserves authoritative shot ordering", () => {
    const result = createShotMediaBindings(
      fixture(),
    );

    expect(
      result.bindings.map((item) => item.shotId),
    ).toEqual([
      "shot-002",
      "shot-001",
    ]);

    expect(
      result.bindings.map((item) => item.shotIndex),
    ).toEqual([0, 1]);
  });

  it("creates deterministic binding hashes", () => {
    const first = createShotMediaBindings(
      fixture(),
    );

    const second = createShotMediaBindings(
      fixture(),
    );

    expect(first.bindingPackageHash).toBe(
      second.bindingPackageHash,
    );

    expect(first.bindings[0]?.bindingHash).toBe(
      second.bindings[0]?.bindingHash,
    );
  });

  it("changes identity when manifest hash changes", () => {
    const original = fixture();

    const first = createShotMediaBindings(
      original,
    );

    const second = createShotMediaBindings({
      ...original,
      mediaManifestHash: "e".repeat(64),
    });

    expect(first.bindingPackageHash).not.toBe(
      second.bindingPackageHash,
    );
  });

  it("preserves source and content hash", () => {
    const result = createShotMediaBindings(
      fixture(),
    );

    expect(
      result.bindings[0]?.asset.sha256,
    ).toBe("c".repeat(64));

    expect(
      result.bindings[0]?.asset.provenance
        .providerAssetId,
    ).toBe("bank-c");
  });

  it("rejects incomplete reports", () => {
    const input = fixture();

    input.report.passed = false;

    expect(() =>
      createShotMediaBindings(input),
    ).toThrow();
  });

  it("rejects missing shot assignments", () => {
    const input = fixture();

    input.report.assignments.pop();
    input.report.assignedShots = 1;

    expect(() =>
      createShotMediaBindings(input),
    ).toThrow();
  });

  it("rejects duplicate assignment IDs", () => {
    const input = fixture();

    input.report.assignments[1] =
      input.report.assignments[0]!;

    expect(() =>
      createShotMediaBindings(input),
    ).toThrow();
  });

  it("rejects invalid production hashes", () => {
    const input = fixture();

    expect(() =>
      createShotMediaBindings({
        ...input,
        productionPackageHash: "invalid",
      }),
    ).toThrow();
  });
});
