import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  loadScriptJobArtifacts,
  saveScriptJobArtifacts,
} from "./script-job-artifacts.js";

const script = {
  version: 1 as const,
  title: "Test Video",
  language: "en",
  tone: "educational",
  hook: "Why does this happen?",
  sections: [
    {
      id: "section-001",
      title: "Explanation",
      narration:
        "This is a short explanation of the topic.",
      estimatedDurationSeconds: 10,
    },
  ],
  outro: "Here is the conclusion.",
};

const usage = {
  requests: 4,
  failedRequests: 0,
  reservedOutputTokens: 4096,
  reportedInputTokens: 100,
  reportedOutputTokens: 200,
};

describe("Script generation report validation", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-report-"),
    );

    const directory = await saveScriptJobArtifacts(
      root,
      "report-test",
      {
        originalScript: script,
        finalScript: script,
        llmUsage: usage,
        promotion: {
          promoted: false,
          reason: "Promotion disabled",
        },
        generationFingerprint: "a".repeat(64),
      },
    );

    return path.join(
      directory,
      "generation-report.json",
    );
  }

  async function modifyReport(
    filename: string,
    modify: (report: Record<string, unknown>) => void,
  ) {
    const report = JSON.parse(
      await readFile(filename, "utf8"),
    ) as Record<string, unknown>;

    modify(report);

    await writeFile(
      filename,
      JSON.stringify(report),
      "utf8",
    );
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

  it("loads valid report metadata", async () => {
    await setup();

    const result = await loadScriptJobArtifacts(
      root!,
      "report-test",
    );

    expect(result.llmUsage.requests).toBe(4);
    expect(result.promotion.promoted).toBe(false);

    expect(result.generationFingerprint).toBe(
      "a".repeat(64),
    );
  });

  it("rejects invalid token usage", async () => {
    const filename = await setup();

    await modifyReport(filename, (report) => {
      report.llmUsage = {
        ...usage,
        requests: -10,
      };
    });

    await expect(
      loadScriptJobArtifacts(root!, "report-test"),
    ).rejects.toThrow();
  });

  it("rejects invalid promotion metadata", async () => {
    const filename = await setup();

    await modifyReport(filename, (report) => {
      report.promotion = {
        promoted: "yes",
        reason: "",
      };
    });

    await expect(
      loadScriptJobArtifacts(root!, "report-test"),
    ).rejects.toThrow();
  });

  it("rejects unsupported report versions", async () => {
    const filename = await setup();

    await modifyReport(filename, (report) => {
      report.version = 999;
    });

    await expect(
      loadScriptJobArtifacts(root!, "report-test"),
    ).rejects.toThrow();
  });
});
