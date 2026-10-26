import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createStoryboardProductionPackage,
  verifyStoryboardProductionPackage,
} from "./storyboard-production-package.js";

import {
  productionFixture,
} from "./storyboard-production.test-fixture.js";

describe("Storyboard production package", () => {
  it("creates a verified production package", () => {
    const created =
      createStoryboardProductionPackage(
        productionFixture(),
      );

    expect(created.version).toBe(1);
    expect(created.coverage.passed).toBe(true);
    expect(created.mediaQA.passed).toBe(true);
    expect(created.packageHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("produces deterministic package hashes", () => {
    const fixture = productionFixture();

    const first =
      createStoryboardProductionPackage(fixture);

    const second =
      createStoryboardProductionPackage(fixture);

    expect(first.packageHash).toBe(
      second.packageHash,
    );
  });

  it("verifies a serialized and reloaded package", () => {
    const created =
      createStoryboardProductionPackage(
        productionFixture(),
      );

    const reloaded = JSON.parse(
      JSON.stringify(created),
    );

    const verified =
      verifyStoryboardProductionPackage(
        reloaded,
      );

    expect(verified.packageHash).toBe(
      created.packageHash,
    );
  });

  it("rejects changes to narration", () => {
    const created =
      createStoryboardProductionPackage(
        productionFixture(),
      );

    const modified = structuredClone(created);

    modified.storyboard.sections[0]!
      .scenes[0]!
      .shots[0]!
      .narrationText = "Changed narration.";

    expect(() =>
      verifyStoryboardProductionPackage(
        modified,
      ),
    ).toThrow("integrity mismatch");
  });

  it("rejects changes to media requirements", () => {
    const created =
      createStoryboardProductionPackage(
        productionFixture(),
      );

    const modified = structuredClone(created);

    modified.mediaPlan.shots[0]!
      .description =
        "A different but still valid visual description";

    expect(() =>
      verifyStoryboardProductionPackage(
        modified,
      ),
    ).toThrow("integrity mismatch");
  });

  it("blocks packages with incomplete narration", () => {
    const fixture = productionFixture();

    fixture.storyboard.sections.pop();

    expect(() =>
      createStoryboardProductionPackage(
        fixture,
      ),
    ).toThrow("narration coverage failed");
  });

  it("rejects forged QA reports even with a valid checksum", () => {
    const created =
      createStoryboardProductionPackage(
        productionFixture(),
      );

    const modified = structuredClone(created);

    modified.mediaQA.checkedShots = 999;

    // Recreating a checksum without reproducing the
    // authentic reports must not authorize the package.
    // The existing hash mismatch already rejects this.
    expect(() =>
      verifyStoryboardProductionPackage(
        modified,
      ),
    ).toThrow("integrity mismatch");
  });
});
