import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createStoryboardProductionPackage,
} from "./storyboard-production-package.js";

import {
  productionFixture,
} from "./storyboard-production.test-fixture.js";

import {
  evaluateStoryboardAcceptance,
} from "./storyboard-acceptance.js";

describe("Storyboard acceptance report", () => {
  it("evaluates a valid production package successfully", () => {
    const fixture = productionFixture();
    const pkg =
      createStoryboardProductionPackage(fixture);

    const report = evaluateStoryboardAcceptance(
      fixture.script,
      pkg,
    );

    expect(report.passed).toBe(true);
    expect(report.scriptMatches).toBe(true);
    expect(report.narrationCoveragePassed).toBe(true);
    expect(report.mediaQAPassed).toBe(true);
    expect(report.storyboardSections).toBe(3);
    expect(report.scenes).toBe(3);
    expect(report.shots).toBe(5);
    expect(report.blockers).toEqual([]);
  });

  it("rejects a package that does not match the authoritative final script", () => {
    const fixture = productionFixture();
    const pkg =
      createStoryboardProductionPackage(fixture);

    const differentScript = {
      ...fixture.script,
      title: "Completely Different Script",
    };

    const report = evaluateStoryboardAcceptance(
      differentScript,
      pkg,
    );

    expect(report.passed).toBe(false);
    expect(report.scriptMatches).toBe(false);
    expect(report.blockers).toContain(
      "Package does not match the authoritative final script",
    );
  });

  it("throws on corrupted package content", () => {
    const fixture = productionFixture();
    const pkg =
      createStoryboardProductionPackage(fixture);

    const corruptedPkg = {
      ...pkg,
      packageHash: "f".repeat(64),
    };

    expect(() =>
      evaluateStoryboardAcceptance(
        fixture.script,
        corruptedPkg,
      ),
    ).toThrow(
      "Storyboard production package integrity mismatch",
    );
  });
});
