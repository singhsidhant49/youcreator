import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  ScriptGenerationStage,
} from "./script-generation-stage.js";

const script = {
  version: 1 as const,
  title: "Why Humans Procrastinate",
  language: "en",
  tone: "documentary",
  hook: "Why do we delay important tasks?",
  sections: [
    {
      id: "section-001",
      title: "Understanding Procrastination",
      narration:
        "Avoiding difficult tasks can sometimes " +
        "provide temporary emotional relief.",
      estimatedDurationSeconds: 15,
    },
  ],
  outro:
    "Try starting with a manageable action.",
};

function createGenerator() {
  return {
    generate: vi.fn(async () => ({
      script,
      finalScript: {
        ...script,
        outro:
          "Start with a two-minute focused session.",
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
    })),
  };
}

describe("ScriptGenerationStage", () => {
  let root: string | undefined;

  async function setup() {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-stage-"),
    );

    return root;
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

  it("generates and persists job-specific artifacts", async () => {
    const jobsRoot = await setup();
    const generator = createGenerator();

    const stage = new ScriptGenerationStage(generator);

    const output = await stage.execute({
      jobId: "job-001",
      jobsRoot,
      generationKey: "test-model:script-v1",
      brief: {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      },
    });

    expect(generator.generate).toHaveBeenCalledOnce();

    expect(output.jobId).toBe("job-001");
    expect(output.promoted).toBe(true);
    expect(output.llmRequests).toBe(5);

    expect(output.artifactDirectory).toBe(
      path.join(jobsRoot, "job-001", "script"),
    );

    const finalScript = JSON.parse(
      await readFile(
        output.finalScriptPath,
        "utf8",
      ),
    );

    expect(finalScript.outro).toContain(
      "two-minute",
    );
  });

  it("rejects unsafe job IDs before generation", async () => {
    const jobsRoot = await setup();
    const generator = createGenerator();

    const stage = new ScriptGenerationStage(generator);

    await expect(
      stage.execute({
        jobId: "../outside",
        jobsRoot,
        generationKey: "test-model:script-v1",
        brief: {
          topic: "Test",
          durationSeconds: 60,
        },
      }),
    ).rejects.toThrow("Invalid job ID");

    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("propagates generation failures", async () => {
    const jobsRoot = await setup();

    const generator = {
      generate: vi.fn(async () => {
        throw new Error("DeepSeek unavailable");
      }),
    };

    const stage = new ScriptGenerationStage(generator);

    await expect(
      stage.execute({
        jobId: "job-failed",
        jobsRoot,
        generationKey: "test-model:script-v1",
        brief: {
          topic: "Why Humans Procrastinate",
          durationSeconds: 60,
        },
      }),
    ).rejects.toThrow("DeepSeek unavailable");

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("reuses matching existing artifacts without regenerating", async () => {
    const jobsRoot = await setup();
    const generator = createGenerator();

    const stage = new ScriptGenerationStage(generator);

    const input = {
      jobId: "job-duplicate",
      jobsRoot,
      generationKey: "test-model:script-v1",
      brief: {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      },
    };

    const first = await stage.execute(input);
    const second = await stage.execute(input);

    expect(second.finalScriptPath).toBe(
      first.finalScriptPath,
    );

    expect(generator.generate).toHaveBeenCalledOnce();

    const stored = JSON.parse(
      await readFile(
        path.join(
          jobsRoot,
          "job-duplicate",
          "script",
          "original-script.json",
        ),
        "utf8",
      ),
    );

    expect(stored.title).toBe(
      "Why Humans Procrastinate",
    );
  });

  it("rejects changed generation configuration", async () => {
    const jobsRoot = await setup();
    const generator = createGenerator();
    const stage = new ScriptGenerationStage(generator);

    const input = {
      jobId: "job-config",
      jobsRoot,
      brief: {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      },
      generationKey: "model-a:prompts-v1",
    };

    await stage.execute(input);

    await expect(
      stage.execute({
        ...input,
        generationKey: "model-b:prompts-v1",
      }),
    ).rejects.toThrow("fingerprint mismatch");

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("rejects changed briefs instead of reusing stale scripts", async () => {
    const jobsRoot = await setup();
    const generator = createGenerator();
    const stage = new ScriptGenerationStage(generator);

    const input = {
      jobId: "job-brief",
      jobsRoot,
      generationKey: "model-a:prompts-v1",
      brief: {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      },
    };

    await stage.execute(input);

    await expect(
      stage.execute({
        ...input,
        brief: {
          ...input.brief,
          topic: "Why Humans Dream",
        },
      }),
    ).rejects.toThrow("fingerprint mismatch");

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("does not regenerate when existing artifacts are corrupt", async () => {
    const jobsRoot = await setup();
    const generator = createGenerator();
    const stage = new ScriptGenerationStage(generator);

    const input = {
      jobId: "job-corrupt",
      jobsRoot,
      generationKey: "model-a:prompts-v1",
      brief: {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      },
    };

    const first = await stage.execute(input);

    await writeFile(
      first.finalScriptPath,
      "{invalid-json",
      "utf8",
    );

    await expect(
      stage.execute(input),
    ).rejects.toThrow();

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("prevents concurrent generation for the same job", async () => {
    const jobsRoot = await setup();

    let releaseGeneration!: () => void;

    const gate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });

    let notifyStarted!: () => void;

    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    const baseGenerator = createGenerator();

    const generator = {
      generate: vi.fn(async () => {
        notifyStarted();
        await gate;

        return baseGenerator.generate();
      }),
    };

    const stage = new ScriptGenerationStage(generator);

    const input = {
      jobId: "job-concurrent",
      jobsRoot,
      generationKey: "test-model:script-v1",
      brief: {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      },
    };

    const first = stage.execute(input);

    // Wait until the first request has acquired the lock
    // and entered the generation operation.
    await started;

    try {
      await expect(
        stage.execute(input),
      ).rejects.toThrow(
        "already running",
      );

      expect(generator.generate).toHaveBeenCalledOnce();
    } finally {
      // Prevent a hanging test if an assertion fails.
      releaseGeneration();
    }

    await first;

    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it("releases its lock after generation fails", async () => {
    const jobsRoot = await setup();

    const generator = {
      generate: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("Temporary API failure"),
        )
        .mockResolvedValueOnce(
          await createGenerator().generate(),
        ),
    };

    const stage = new ScriptGenerationStage(generator);

    const input = {
      jobId: "job-retry-lock",
      jobsRoot,
      generationKey: "test-model:script-v1",
      brief: {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      },
    };

    await expect(
      stage.execute(input),
    ).rejects.toThrow(
      "Temporary API failure",
    );

    const result = await stage.execute(input);

    expect(result.jobId).toBe("job-retry-lock");
    expect(generator.generate).toHaveBeenCalledTimes(2);
  });

  it("reuses completed artifacts across separate executions", async () => {
    const jobsRoot = await setup();

    const generator = createGenerator();
    const stage = new ScriptGenerationStage(generator);

    const input = {
      jobId: "job-lock-recovery",
      jobsRoot,
      generationKey: "test-model:script-v1",
      brief: {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      },
    };

    const first = await stage.execute(input);
    const second = await stage.execute(input);

    expect(first.finalScriptPath).toBe(
      second.finalScriptPath,
    );

    expect(generator.generate).toHaveBeenCalledOnce();
  });
});
