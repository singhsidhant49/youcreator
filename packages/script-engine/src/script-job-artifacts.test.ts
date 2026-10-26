import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";

import path from "node:path";
import os from "node:os";

import {
  loadScriptJobArtifacts,
  saveScriptJobArtifacts,
  type ScriptJobArtifactInput,
} from "./script-job-artifacts.js";

const script = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook:
    "Why do we delay important tasks?",
  sections: [
    {
      id: "section-001",
      title: "The Psychology",
      narration:
        "Procrastination can involve avoiding uncomfortable feelings.",
      estimatedDurationSeconds: 10,
    },
  ],
  outro:
    "Try starting with a manageable action.",
};

const input: ScriptJobArtifactInput = {
  originalScript: script,
  finalScript: {
    ...script,
    outro:
      "Set a two-minute timer and begin the easiest part.",
  },
  llmUsage: {
    requests: 5,
    failedRequests: 0,
    reservedOutputTokens: 7168,
    reportedInputTokens: 1375,
    reportedOutputTokens: 507,
  },
  promotion: {
    promoted: true,
    reason: "Candidate passed promotion validation",
  },
};

describe("Script job artifact storage", () => {
  let root: string;

  async function createRoot() {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-script-"),
    );

    return root;
  }

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  });

  it("saves and loads original and final scripts", async () => {
    const outputRoot = await createRoot();

    await saveScriptJobArtifacts(
      outputRoot,
      "job-001",
      input,
    );

    const loaded = await loadScriptJobArtifacts(
      outputRoot,
      "job-001",
    );

    expect(loaded.originalScript).toEqual(
      input.originalScript,
    );

    expect(loaded.finalScript).toEqual(
      input.finalScript,
    );

    expect(loaded.llmUsage.requests).toBe(5);
    expect(loaded.promotion.promoted).toBe(true);
  });

  it("creates readable JSON artifacts", async () => {
    const outputRoot = await createRoot();

    const directory = await saveScriptJobArtifacts(
      outputRoot,
      "job-002",
      input,
    );

    const raw = await readFile(
      path.join(directory, "final-script.json"),
      "utf8",
    );

    expect(JSON.parse(raw).outro).toContain(
      "two-minute timer",
    );
  });

  it("refuses to overwrite an existing job", async () => {
    const outputRoot = await createRoot();

    await saveScriptJobArtifacts(
      outputRoot,
      "job-003",
      input,
    );

    await expect(
      saveScriptJobArtifacts(
        outputRoot,
        "job-003",
        input,
      ),
    ).rejects.toThrow(
      "already exist",
    );
  });

  it("rejects unsafe job IDs", async () => {
    const outputRoot = await createRoot();

    await expect(
      saveScriptJobArtifacts(
        outputRoot,
        "../outside",
        input,
      ),
    ).rejects.toThrow(
      "Invalid job ID",
    );
  });
});
