import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

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
  evaluateMediaUsageRights,
  type MediaUsageRightsInput,
} from "./media-usage-rights.js";

import {
  MediaUsageRightsStore,
} from "./media-usage-rights-store.js";

const approvedInput: MediaUsageRightsInput = {
  source: {
    provider: "local_library",
    id: "bank-001-image-001",
  },
  assetHash: "a".repeat(64),
  intendedUse: "commercial_youtube",

  reviewer: "media-rights-reviewer",
  reviewedAt: "2026-10-12T12:00:00.000Z",

  evidenceUrl:
    "https://example.com/rights-evidence/001",

  commercialPermission: "confirmed",
  personRelease: "not_required",
  propertyRelease: "not_required",
  attribution: "not_required",

  notes: "Rights checked for commercial publishing",
};

describe("Media usage rights", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "youcreator-rights-",
      ),
    );

    return new MediaUsageRightsStore(root);
  }

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });

      root = undefined;
    }
  });

  it("approves an explicitly documented assessment", () => {
    const result = evaluateMediaUsageRights(
      approvedInput,
    );

    expect(result.decision).toBe("approved");
    expect(result.issues).toEqual([]);
  });

  it("requires review when license evidence is missing", () => {
    const {
      evidenceUrl: _ignored,
      ...input
    } = approvedInput;

    const result = evaluateMediaUsageRights(
      input,
    );

    expect(result.decision).toBe(
      "review_required",
    );

    expect(result.issues).toContain(
      "LICENSE_EVIDENCE_MISSING",
    );
  });

  it("rejects explicitly denied commercial usage", () => {
    const result = evaluateMediaUsageRights({
      ...approvedInput,
      commercialPermission: "denied",
    });

    expect(result.decision).toBe("rejected");

    expect(result.issues).toContain(
      "COMMERCIAL_PERMISSION_DENIED",
    );
  });

  it("requires review for unknown people or property clearance", () => {
    const result = evaluateMediaUsageRights({
      ...approvedInput,
      personRelease: "unknown",
      propertyRelease: "unknown",
    });

    expect(result.decision).toBe(
      "review_required",
    );

    expect(result.issues).toContain(
      "PERSON_RELEASE_UNKNOWN",
    );

    expect(result.issues).toContain(
      "PROPERTY_RELEASE_UNKNOWN",
    );
  });

  it("rejects unsatisfied attribution requirements", () => {
    const result = evaluateMediaUsageRights({
      ...approvedInput,
      attribution: "unsatisfied",
    });

    expect(result.decision).toBe("rejected");

    expect(result.issues).toContain(
      "ATTRIBUTION_UNSATISFIED",
    );
  });

  it("persists and reloads an immutable assessment", async () => {
    const store = await setup();

    const first = await store.save(
      approvedInput,
    );

    const second = await store.load(
      approvedInput,
    );

    expect(second).toEqual(first);
    expect(second?.decision).toBe("approved");

    const repeated = await store.save(
      approvedInput,
    );

    expect(repeated).toEqual(first);
  });

  it("rejects conflicting reassessments of the same source", async () => {
    const store = await setup();

    await store.save(approvedInput);

    await expect(
      store.save({
        ...approvedInput,
        commercialPermission: "denied",
      }),
    ).rejects.toThrow(
      "already exists",
    );
  });

  it("detects corrupted persisted assessments", async () => {
    const store = await setup();

    await store.save(approvedInput);

    const base = path.join(
      root!,
      "manifests",
      "usage-rights",
    );

    const prefixes = await readdir(base);

    expect(prefixes).toHaveLength(1);

    const directory = path.join(
      base,
      prefixes[0]!,
    );

    const files = await readdir(directory);

    expect(files).toHaveLength(1);

    const filename = path.join(
      directory,
      files[0]!,
    );

    const saved = JSON.parse(
      await readFile(filename, "utf8"),
    );

    saved.assessment.input.commercialPermission =
      "denied";

    await writeFile(
      filename,
      JSON.stringify(saved),
    );

    await expect(
      store.load(approvedInput),
    ).rejects.toThrow(
      "integrity mismatch",
    );
  });
});
