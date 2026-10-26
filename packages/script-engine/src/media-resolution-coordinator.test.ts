import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  MediaAsset,
} from "@youcreator/contracts";

import {
  MediaResolutionCoordinator,
} from "./media-resolution-coordinator.js";

import type {
  MediaAssignmentOutcome,
} from "./assigned-media.js";

import type {
  SharedBackgroundRequest,
  ManualMediaRequest,
} from "./manual-shared-media.js";

function asset(
  letter = "a",
): MediaAsset {
  return {
    version: 1,
    id: `asset-${letter}`,
    kind: "image",
    localPath: `/test/objects/${letter}.png`,
    sha256: letter.repeat(64),
    bytes: 100,
    mimeType: "image/png",
    width: 1920,
    height: 1080,
    provenance: {
      source: "local_library",
      license: {
        status: "unknown",
      },
    },
    createdAt: "2026-10-12T10:00:00.000Z",
  };
}

function assigned(
  shotId: string,
  mode: "A" | "B" | "C" | "D",
  image = asset(),
): MediaAssignmentOutcome {
  return {
    status: "assigned",
    assignment: {
      version: 1,
      shotId,
      mode,
      assignmentSource:
        mode === "A"
          ? "shared_background"
          : mode === "B"
            ? "local_library"
            : mode === "C"
              ? "ai_generated"
              : "manual_upload",
      asset: image,
      assignedAt:
        "2026-10-12T10:00:00.000Z",
    },
  };
}

function unresolved(
  shotId: string,
): MediaAssignmentOutcome {
  return {
    status: "unresolved",
    shotId,
    reason: "MISSING_ASSET",
    message: "Image not found",
  };
}

function setup(
  overrides: {
    stockResolver?: (
      shotId: string,
    ) => Promise<MediaAssignmentOutcome>;
    aiResolver?: (
      shotId: string,
    ) => Promise<MediaAssignmentOutcome>;
    verify?: (
      image: MediaAsset,
    ) => Promise<boolean>;
    rights?: (
      image: MediaAsset,
    ) => Promise<
      "approved" | "review_required" | "rejected"
    >;
  } = {},
) {
  const assignSharedBackground = vi.fn(
    async (request: SharedBackgroundRequest) =>
      request.shotIds.map(
        (shotId) => assigned(shotId, "A"),
      ),
  );

  const assignManualMedia = vi.fn(
    async (request: ManualMediaRequest) =>
      request.assignments.map(
        (item) =>
          assigned(item.shotId, "D"),
      ),
  );

  const stockResolve = vi.fn(
    overrides.stockResolver ??
      (async (shotId) =>
        assigned(shotId, "B")),
  );

  const aiResolve = vi.fn(
    overrides.aiResolver ??
      (async (shotId) =>
        assigned(shotId, "C")),
  );

  const verify = vi.fn(
    overrides.verify ??
      (async () => true),
  );

  const rights = vi.fn(
    overrides.rights ??
      (async () => "approved" as const),
  );

  const coordinator =
    new MediaResolutionCoordinator({
      manualShared: {
        assignSharedBackground,
        assignManualMedia,
      },
      stockResolver: {
        resolve: stockResolve,
      },
      aiResolver: {
        resolve: aiResolve,
      },
      assetVerifier: {
        verify,
      },
      rightsChecker: {
        check: rights,
      },
    });

  return {
    coordinator,
    stockResolve,
    aiResolve,
    verify,
    rights,
    assignSharedBackground,
    assignManualMedia,
  };
}

describe("Media resolution coordinator", () => {
  it("assigns a shared background to all requested shots", async () => {
    const env = setup();

    const report = await env.coordinator.run({
      jobId: "job-001",
      mode: "A",
      shotIds: [
        "shot-001",
        "shot-002",
      ],
      backgroundId: "background-001",
      localPath: "/test/background.png",
    });

    expect(report.passed).toBe(true);
    expect(report.assignedShots).toBe(2);
    expect(report.issues).toEqual([]);

    expect(
      env.assignSharedBackground,
    ).toHaveBeenCalledTimes(1);
  });

  it("reports missing manual assignments without passing QA", async () => {
    const env = setup();

    const report = await env.coordinator.run({
      jobId: "job-001",
      mode: "D",
      shotIds: [
        "shot-001",
        "shot-002",
      ],
      assignments: [{
        shotId: "shot-001",
        assetId: "manual-001",
        localPath: "/test/manual.png",
      }],
    });

    expect(report.passed).toBe(false);

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_SHOT",
          shotId: "shot-002",
        }),
      ]),
    );
  });

  it("resolves Mode B shots through the stock resolver", async () => {
    const env = setup();

    const report = await env.coordinator.run({
      jobId: "job-001",
      mode: "B",
      shotIds: ["shot-001"],
    });

    expect(report.passed).toBe(true);

    expect(
      env.stockResolve,
    ).toHaveBeenCalledWith("shot-001");

    expect(
      env.aiResolve,
    ).not.toHaveBeenCalled();
  });

  it("never invokes paid AI generation without authorization", async () => {
    const env = setup();

    const report = await env.coordinator.run({
      jobId: "job-001",
      mode: "C",
      shotIds: ["shot-001"],
      allowPaidGeneration: false,
    });

    expect(report.passed).toBe(false);

    expect(
      env.aiResolve,
    ).not.toHaveBeenCalled();

    expect(report.issues.some(
      (issue) =>
        issue.code === "RESOLUTION_FAILED",
    )).toBe(true);
  });

  it("invokes the AI resolver only when explicitly authorized", async () => {
    const env = setup();

    const report = await env.coordinator.run({
      jobId: "job-001",
      mode: "C",
      shotIds: ["shot-001"],
      allowPaidGeneration: true,
    });

    expect(report.passed).toBe(true);

    expect(
      env.aiResolve,
    ).toHaveBeenCalledTimes(1);
  });

  it("rejects assignments with a different mode", async () => {
    const env = setup({
      stockResolver: async (shotId) =>
        assigned(shotId, "C"),
    });

    const report = await env.coordinator.run({
      jobId: "job-001",
      mode: "B",
      shotIds: ["shot-001"],
    });

    expect(report.passed).toBe(false);

    expect(report.issues[0]?.code).toBe(
      "MODE_MISMATCH",
    );
  });

  it("rejects assignments when content verification fails", async () => {
    const env = setup({
      verify: async () => false,
    });

    const report = await env.coordinator.run({
      jobId: "job-001",
      mode: "B",
      shotIds: ["shot-001"],
    });

    expect(report.passed).toBe(false);

    expect(report.issues[0]?.code).toBe(
      "ASSET_VERIFICATION_FAILED",
    );
  });

  it("fails closed when rights are not approved", async () => {
    const env = setup({
      rights: async () => "review_required",
    });

    const report = await env.coordinator.run({
      jobId: "job-001",
      mode: "B",
      shotIds: ["shot-001"],
    });

    expect(report.passed).toBe(false);

    expect(report.issues[0]?.code).toBe(
      "RIGHTS_NOT_APPROVED",
    );
  });

  it("reports repeated media without automatically failing", async () => {
    const env = setup();

    const report = await env.coordinator.run({
      jobId: "job-001",
      mode: "B",
      shotIds: [
        "shot-001",
        "shot-002",
      ],
    });

    expect(report.passed).toBe(true);

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REPEATED_ASSET",
          severity: "warning",
        }),
      ]),
    );
  });

  it("rejects duplicate expected shot IDs", async () => {
    const env = setup();

    await expect(
      env.coordinator.run({
        jobId: "job-001",
        mode: "B",
        shotIds: [
          "shot-001",
          "shot-001",
        ],
      }),
    ).rejects.toThrow();
  });
});
