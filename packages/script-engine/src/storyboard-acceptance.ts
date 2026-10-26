import type {
  VideoScript,
} from "@youcreator/contracts";

import {
  hashScriptContent,
} from "./script-job-artifacts.js";

import {
  verifyStoryboardProductionPackage,
  type StoryboardProductionPackage,
} from "./storyboard-production-package.js";

export interface StoryboardAcceptanceReport {
  passed: boolean;
  scriptMatches: boolean;
  narrationCoveragePassed: boolean;
  mediaQAPassed: boolean;
  storyboardSections: number;
  scenes: number;
  shots: number;
  blockers: string[];
  warnings: string[];
}

export function evaluateStoryboardAcceptance(
  finalScript: VideoScript,
  packageInput: StoryboardProductionPackage,
): StoryboardAcceptanceReport {
  const pkg = verifyStoryboardProductionPackage(
    packageInput,
  );

  const scriptMatches =
    hashScriptContent(finalScript) === pkg.scriptHash;

  const blockers: string[] = [];

  if (!scriptMatches) {
    blockers.push(
      "Package does not match the authoritative final script",
    );
  }

  if (!pkg.coverage.passed) {
    blockers.push("Narration coverage failed");
  }

  if (!pkg.mediaQA.passed) {
    blockers.push(
      ...pkg.mediaQA.blockers.map(
        (issue) => `${issue.code}: ${issue.message}`,
      ),
    );
  }

  return {
    passed: blockers.length === 0,
    scriptMatches,
    narrationCoveragePassed: pkg.coverage.passed,
    mediaQAPassed: pkg.mediaQA.passed,

    storyboardSections: pkg.storyboard.sections.length,

    scenes: pkg.storyboard.sections.reduce(
      (total, section) =>
        total + section.scenes.length,
      0,
    ),

    shots: pkg.storyboard.sections.reduce(
      (total, section) =>
        total +
        section.scenes.reduce(
          (count, scene) =>
            count + scene.shots.length,
          0,
        ),
      0,
    ),

    blockers,

    warnings: pkg.mediaQA.warnings.map(
      (issue) =>
        `${issue.code}: ${issue.message}`,
    ),
  };
}
