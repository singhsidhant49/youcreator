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
  hashScriptContent,
  loadScriptJobArtifacts,
  saveScriptJobArtifacts,
} from "./script-job-artifacts.js";

const script = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook: "Why do people delay important tasks?",
  sections: [
    {
      id: "section-001",
      title: "Emotional Avoidance",
      narration:
        "Avoiding uncomfortable tasks sometimes " +
        "provides temporary emotional relief.",
      estimatedDurationSeconds: 12,
    },
  ],
  outro: "Begin with one manageable action.",
};

describe("Script artifact integrity", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-integrity-"),
    );

    const directory = await saveScriptJobArtifacts(
      root,
      "integrity-test",
      {
        originalScript: script,
        finalScript: script,
        llmUsage: {
          requests: 4,
          failedRequests: 0,
          reservedOutputTokens: 4096,
          reportedInputTokens: 100,
          reportedOutputTokens: 200,
        },
        promotion: {
          promoted: false,
          reason: "Promotion disabled",
        },
        generationFingerprint: "a".repeat(64),
      },
    );

    return directory;
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

  it("verifies valid version 3 script artifacts", async () => {
    await setup();

    const stored = await loadScriptJobArtifacts(
      root!,
      "integrity-test",
    );

    expect(stored.reportVersion).toBe(3);
    expect(stored.integrityVerified).toBe(true);
  });

  it("detects modified but schema-valid narration", async () => {
    const directory = await setup();

    const filename = path.join(
      directory,
      "final-script.json",
    );

    const parsed = JSON.parse(
      await readFile(filename, "utf8"),
    );

    parsed.outro =
      "This is different but still valid narration.";

    await writeFile(
      filename,
      JSON.stringify(parsed, null, 2),
      "utf8",
    );

    await expect(
      loadScriptJobArtifacts(root!, "integrity-test"),
    ).rejects.toThrow("content integrity mismatch");
  });

  it("detects modified original script content", async () => {
    const directory = await setup();

    const filename = path.join(
      directory,
      "original-script.json",
    );

    const parsed = JSON.parse(
      await readFile(filename, "utf8"),
    );

    parsed.hook = "A different opening hook.";

    await writeFile(
      filename,
      JSON.stringify(parsed),
      "utf8",
    );

    await expect(
      loadScriptJobArtifacts(root!, "integrity-test"),
    ).rejects.toThrow("content integrity mismatch");
  });

  it("does not reject formatting-only JSON changes", async () => {
    const directory = await setup();

    const filename = path.join(
      directory,
      "final-script.json",
    );

    const parsed = JSON.parse(
      await readFile(filename, "utf8"),
    );

    await writeFile(
      filename,
      JSON.stringify(parsed),
      "utf8",
    );

    const stored = await loadScriptJobArtifacts(
      root!,
      "integrity-test",
    );

    expect(stored.integrityVerified).toBe(true);
  });

  it("produces deterministic content hashes", () => {
    const first = hashScriptContent(script);
    const second = hashScriptContent({
      ...script,
      sections: script.sections.map(
        (section) => ({ ...section }),
      ),
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reads legacy reports without marking them verified", async () => {
    const directory = await setup();

    const filename = path.join(
      directory,
      "generation-report.json",
    );

    const report = JSON.parse(
      await readFile(filename, "utf8"),
    );

    report.version = 2;
    delete report.contentHashes;

    await writeFile(
      filename,
      JSON.stringify(report),
      "utf8",
    );

    const stored = await loadScriptJobArtifacts(
      root!,
      "integrity-test",
    );

    expect(stored.reportVersion).toBe(2);
    expect(stored.integrityVerified).toBe(false);
  });
});
