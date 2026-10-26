import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ScriptAssembler } from "./script-assembler.js";
import {
  ScriptPartCache,
  scriptPartHash,
} from "./script-part-cache.js";
import { VideoBriefSchema } from "@youcreator/contracts";

const outline = {
  version: 1,
  title: "Why Humans Procrastinate",
  centralIdea: "Procrastination involves emotional regulation.",
  hookPlan: "Open with a relatable question.",
  hookTargetWords: 20,
  sections: [
    {
      id: "section-001",
      title: "Understanding Procrastination",
      objective: "Explain why we delay tasks.",
      keyPoints: ["Emotions", "Short-term rewards"],
      targetWords: 100,
    },
  ],
  outroPlan: "Conclude with a practical takeaway.",
  outroTargetWords: 15,
};

describe("ScriptAssembler", () => {
  it("assembles a complete script", async () => {
    const responses = [
      outline,
      { narration: "Why do we delay things?" },
      {
        narration:
          "Procrastination can be connected to emotional avoidance.",
      },
      {
        narration:
          "Understanding this pattern can help us improve.",
      },
    ];

    const generate = vi.fn(async () => ({
      text: JSON.stringify(responses.shift()),
      model: "test-model",
    }));

    const assembler = new ScriptAssembler({ generate });

    const result = await assembler.assemble({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.script.hook).toContain("delay");
    expect(result.script.sections).toHaveLength(1);
    expect(result.script.outro).toContain("improve");
    expect(result.sectionsGenerated).toBe(1);
    expect(result.actualWords).toBeGreaterThan(0);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it("preserves section order", async () => {
    const multiSectionOutline = {
      ...outline,
      sections: [
        {
          ...outline.sections[0],
          targetWords: 50,
        },
        {
          id: "section-002",
          title: "Building Better Habits",
          objective: "Explain practical techniques.",
          keyPoints: ["Small steps"],
          targetWords: 50,
        },
      ],
    };

    const responses = [
      multiSectionOutline,
      { narration: "Opening hook." },
      { narration: "First section narration." },
      { narration: "Second section narration." },
      { narration: "Closing narration." },
    ];

    const assembler = new ScriptAssembler({
      async generate() {
        return {
          text: JSON.stringify(responses.shift()),
          model: "test-model",
        };
      },
    });

    const result = await assembler.assemble({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(
      result.script.sections.map((s) => s.id),
    ).toEqual(["section-001", "section-002"]);
  });

  it("fails when a section returns invalid narration", async () => {
    const responses = [
      outline,
      { narration: "Opening hook." },
      { narration: "" },
    ];

    const assembler = new ScriptAssembler({
      async generate() {
        return {
          text: JSON.stringify(responses.shift()),
          model: "test-model",
        };
      },
    });

    await expect(
      assembler.assemble({
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      }),
    ).rejects.toThrow();
  });

  it("returns a script quality report", async () => {
    const responses = [
      outline,
      { narration: "Opening hook." },
      { narration: "Short section narration." },
      { narration: "Closing narration." },
    ];

    const assembler = new ScriptAssembler({
      async generate() {
        return {
          text: JSON.stringify(responses.shift()),
          model: "test-model",
        };
      },
    });

    const result = await assembler.assemble({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.quality).toBeDefined();
    expect(result.quality.totalWords).toBe(result.actualWords);
    expect(result.quality.passed).toBe(false);

    expect(
      result.quality.issues.some(
        (issue) => issue.code === "TOO_SHORT",
      ),
    ).toBe(true);
  });

  it("rejects a short script when quality enforcement is enabled", async () => {
    const responses = [
      outline,
      { narration: "Opening hook." },
      { narration: "Short section narration." },
      { narration: "Closing narration." },
    ];

    const assembler = new ScriptAssembler(
      {
        async generate() {
          return {
            text: JSON.stringify(responses.shift()),
            model: "test-model",
          };
        },
      },
      {
        enforceQuality: true,
      },
    );

    await expect(
      assembler.assemble({
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      }),
    ).rejects.toThrow("Script quality validation failed");
  });

  it("allows quality failures in non-enforcing mode", async () => {
    const responses = [
      outline,
      { narration: "Opening hook." },
      { narration: "Short narration." },
      { narration: "The end." },
    ];

    const assembler = new ScriptAssembler(
      {
        async generate() {
          return {
            text: JSON.stringify(responses.shift()),
            model: "test-model",
          };
        },
      },
      { enforceQuality: false },
    );

    const result = await assembler.assemble({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.quality.passed).toBe(false);
    expect(result.script.sections).toHaveLength(1);
  });

  it("revises an undersized section", async () => {
    const revisedNarration = Array(20)
      .fill("This explanation explores human behaviour.")
      .join(" ");

    const responses = [
      outline,
      { narration: "Opening hook." },
      { narration: "Very short section." },
      { narration: revisedNarration },
      { narration: "Closing narration." },
    ];

    const generate = vi.fn(async () => ({
      text: JSON.stringify(responses.shift()),
      model: "test-model",
    }));

    const assembler = new ScriptAssembler(
      { generate },
      {
        reviseSections: true,
        maxRevisionCalls: 1,
      },
    );

    const result = await assembler.assemble({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.revisionCalls).toBe(1);
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]?.accepted).toBe(true);

    expect(result.script.sections[0]?.narration).toBe(
      revisedNarration,
    );

    expect(generate).toHaveBeenCalledTimes(5);
  });

  it("preserves original narration when revision fails", async () => {
    const responses = [
      outline,
      { narration: "Opening hook." },
      { narration: "Original short section." },
      { narration: "Still short." },
      { narration: "Closing narration." },
    ];

    const assembler = new ScriptAssembler(
      {
        async generate() {
          return {
            text: JSON.stringify(responses.shift()),
            model: "test-model",
          };
        },
      },
      {
        reviseSections: true,
        maxRevisionCalls: 1,
      },
    );

    const result = await assembler.assemble({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.revisionCalls).toBe(1);
    expect(result.revisions[0]?.accepted).toBe(false);

    expect(result.script.sections[0]?.narration).toBe(
      "Original short section.",
    );
  });

  it("does not revise when the call budget is zero", async () => {
    const responses = [
      outline,
      { narration: "Opening hook." },
      { narration: "Short section." },
      { narration: "Closing narration." },
    ];

    const generate = vi.fn(async () => ({
      text: JSON.stringify(responses.shift()),
      model: "test-model",
    }));

    const assembler = new ScriptAssembler(
      { generate },
      {
        reviseSections: true,
        maxRevisionCalls: 0,
      },
    );

    const result = await assembler.assemble({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.revisionCalls).toBe(0);
    expect(result.revisions).toHaveLength(0);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it("reuses the same outline across repeated runs", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-outline-cache-"),
    );

    try {
      let outlineCalls = 0;

      const generate = vi.fn(async (messages: {
        role: string;
        content: string;
      }[]) => {
        const prompt = messages
          .map((m) => m.content)
          .join("\n");

        if (prompt.includes("Create an engaging, coherent narration outline")) {
          outlineCalls++;

          return {
            text: JSON.stringify(outline),
            model: "test-model",
          };
        }

        return {
          text: JSON.stringify({
            narration: "Valid generated narration.",
          }),
          model: "test-model",
        };
      });

      const assembler = new ScriptAssembler(
        { generate },
        {
          cache: new ScriptPartCache(directory),
          cacheModelKey: "test-model",
        },
      );

      const brief = {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      };

      await assembler.assemble(brief);
      await assembler.assemble(brief);

      expect(outlineCalls).toBe(1);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("makes zero LLM calls on second run when same brief is executed twice", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-narration-cache-"),
    );

    try {
      const generate = vi.fn(async (messages: {
        role: string;
        content: string;
      }[]) => {
        const prompt = messages
          .map((m) => m.content)
          .join("\n");

        if (prompt.includes("Create an engaging, coherent narration outline")) {
          return {
            text: JSON.stringify(outline),
            model: "test-model",
          };
        }

        return {
          text: JSON.stringify({
            narration: "Valid generated narration.",
          }),
          model: "test-model",
        };
      });

      const assembler = new ScriptAssembler(
        { generate },
        {
          cache: new ScriptPartCache(directory),
          cacheModelKey: "test-model",
        },
      );

      const brief = {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      };

      const firstResult = await assembler.assemble(brief);
      expect(firstResult.cacheHits).toBe(0);
      expect(firstResult.cacheMisses).toBe(3);
      const firstCalls = generate.mock.calls.length;

      const secondResult = await assembler.assemble(brief);
      expect(secondResult.cacheHits).toBe(3);
      expect(secondResult.cacheMisses).toBe(0);
      expect(generate.mock.calls.length).toBe(firstCalls);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("reuses completed parts when generation fails halfway through sections", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-interrupted-cache-"),
    );

    const twoSectionOutline = {
      version: 1,
      title: "Why Humans Procrastinate",
      centralIdea: "Procrastination involves emotional regulation.",
      hookPlan: "Open with a relatable question.",
      hookTargetWords: 20,
      sections: [
        {
          id: "section-001",
          title: "Understanding Procrastination",
          objective: "Explain why we delay tasks.",
          keyPoints: ["Emotions", "Short-term rewards"],
          targetWords: 50,
        },
        {
          id: "section-002",
          title: "Actionable Solutions",
          objective: "Techniques to start working.",
          keyPoints: ["Micro-steps", "Time boxing"],
          targetWords: 50,
        },
      ],
      outroPlan: "Conclude with a practical takeaway.",
      outroTargetWords: 15,
    };

    try {
      let section1Calls = 0;
      let shouldFailSection2 = true;

      const generate = vi.fn(async (messages: {
        role: string;
        content: string;
      }[]) => {
        const prompt = messages
          .map((m) => m.content)
          .join("\n");

        if (prompt.includes("Create an engaging, coherent narration outline")) {
          return {
            text: JSON.stringify(twoSectionOutline),
            model: "test-model",
          };
        }

        if (prompt.includes("Understanding Procrastination")) {
          section1Calls++;
          return {
            text: JSON.stringify({
              narration: "Section one narration about understanding delay.",
            }),
            model: "test-model",
          };
        }

        if (prompt.includes("Actionable Solutions")) {
          if (shouldFailSection2) {
            throw new Error("Simulated LLM failure on section 2");
          }
          return {
            text: JSON.stringify({
              narration: "Section two narration about actionable solutions.",
            }),
            model: "test-model",
          };
        }

        return {
          text: JSON.stringify({
            narration: "Opening hook or outro narration.",
          }),
          model: "test-model",
        };
      });

      const cache = new ScriptPartCache(directory);
      const assembler = new ScriptAssembler(
        { generate },
        {
          cache,
          cacheModelKey: "test-model",
        },
      );

      const brief = {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      };

      // First run: should fail on section 2
      await expect(assembler.assemble(brief)).rejects.toThrow(
        "Simulated LLM failure on section 2",
      );
      expect(section1Calls).toBe(1);

      // Second run (retry): section 2 now succeeds
      shouldFailSection2 = false;
      const retryResult = await assembler.assemble(brief);

      // Section 1 should NOT be called again (reused from cache)
      expect(section1Calls).toBe(1);
      expect(retryResult.script.sections).toHaveLength(2);
      expect(retryResult.cacheHits).toBe(2);
      expect(retryResult.cacheMisses).toBe(2);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("invalidates downstream section cache when preceding section narration changes", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-invalidate-cache-"),
    );

    const baseOutline = {
      version: 1,
      title: "Why Humans Procrastinate",
      centralIdea: "Procrastination involves emotional regulation.",
      hookPlan: "Open with a relatable question.",
      hookTargetWords: 20,
      sections: [
        {
          id: "section-001",
          title: "Understanding Procrastination",
          objective: "Original objective A.",
          keyPoints: ["Emotions", "Short-term rewards"],
          targetWords: 50,
        },
        {
          id: "section-002",
          title: "Actionable Solutions",
          objective: "Techniques to start working.",
          keyPoints: ["Micro-steps", "Time boxing"],
          targetWords: 50,
        },
      ],
      outroPlan: "Conclude with a practical takeaway.",
      outroTargetWords: 15,
    };

    try {
      let section2Calls = 0;

      const generate = vi.fn(async (messages: {
        role: string;
        content: string;
      }[]) => {
        const prompt = messages
          .map((m) => m.content)
          .join("\n");

        if (prompt.includes("Create an engaging, coherent narration outline")) {
          return {
            text: JSON.stringify(baseOutline),
            model: "test-model",
          };
        }

        if (prompt.includes("Original objective A")) {
          return {
            text: JSON.stringify({
              narration: "Narration based on original objective A.",
            }),
            model: "test-model",
          };
        }

        if (prompt.includes("Revised objective B")) {
          return {
            text: JSON.stringify({
              narration: "Narration based on revised objective B.",
            }),
            model: "test-model",
          };
        }

        if (prompt.includes("Actionable Solutions")) {
          section2Calls++;
          return {
            text: JSON.stringify({
              narration: "Narration for actionable solutions section.",
            }),
            model: "test-model",
          };
        }

        return {
          text: JSON.stringify({
            narration: "Hook or outro narration.",
          }),
          model: "test-model",
        };
      });

      const cache = new ScriptPartCache(directory);
      const assembler = new ScriptAssembler(
        { generate },
        {
          cache,
          cacheModelKey: "test-model",
        },
      );

      const brief = {
        topic: "Why Humans Procrastinate",
        durationSeconds: 60,
      };

      // Run 1: initial assembly
      const firstResult = await assembler.assemble(brief);
      expect(firstResult.script.sections[0]?.narration).toBe(
        "Narration based on original objective A.",
      );
      expect(section2Calls).toBe(1);

      // Controlled fixture: replace the cached outline with an updated objective for section 1,
      // preserving the outline cache key contract for this brief.
      const outlineHash = scriptPartHash({
        kind: "outline",
        id: "main",
        promptVersion: "outline-v1",
        model: "test-model",
        context: VideoBriefSchema.parse(brief),
      });

      const updatedOutline = {
        ...baseOutline,
        sections: [
          {
            ...baseOutline.sections[0],
            objective: "Revised objective B.",
          },
          baseOutline.sections[1],
        ],
      };

      await cache.save(outlineHash, JSON.stringify(updatedOutline));

      // Run 2: assemble again with the same brief.
      // Section 1 objective changed -> Section 1 generates new narration.
      // Because Section 1 narration changed -> Section 2's previousNarration changed -> Section 2 cache is invalidated and regenerates.
      const secondResult = await assembler.assemble(brief);
      expect(secondResult.script.sections[0]?.narration).toBe(
        "Narration based on revised objective B.",
      );
      expect(section2Calls).toBe(2);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("returns editorial QA when enabled", async () => {
    const responses = [
      outline,
      { narration: "Short hook." },
      { narration: "Brief section narration." },
      { narration: "Start with one small step." },
    ];

    const assembler = new ScriptAssembler(
      {
        async generate() {
          return {
            text: JSON.stringify(responses.shift()),
            model: "test-model",
          };
        },
      },
      {
        editorial: {
          enabled: true,
          requireExample: true,
        },
      },
    );

    const result = await assembler.assemble({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.editorialQuality).toBeDefined();

    expect(
      result.editorialQuality?.issues.some(
        (issue) => issue.code === "WEAK_HOOK",
      ),
    ).toBe(true);

    expect(
      result.editorialQuality?.issues.some(
        (issue) => issue.code === "GENERIC_OUTRO",
      ),
    ).toBe(true);

    expect(
      result.editorialQuality?.issues.some(
        (issue) => issue.code === "MISSING_EXAMPLE",
      ),
    ).toBe(true);
  });

  it("skips editorial evaluation when disabled", async () => {
    const responses = [
      outline,
      { narration: "Opening narration." },
      { narration: "Section narration." },
      { narration: "Closing narration." },
    ];

    const assembler = new ScriptAssembler(
      {
        async generate() {
          return {
            text: JSON.stringify(responses.shift()),
            model: "test-model",
          };
        },
      },
      {
        editorial: {
          enabled: false,
        },
      },
    );

    const result = await assembler.assemble({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.editorialQuality).toBeUndefined();
  });

  it("does not trigger LLM revisions for editorial warnings", async () => {
    const responses = [
      outline,
      { narration: "Short hook." },
      { narration: "Short section." },
      { narration: "Start with one small step." },
    ];

    const generate = vi.fn(async () => ({
      text: JSON.stringify(responses.shift()),
      model: "test-model",
    }));

    const assembler = new ScriptAssembler(
      { generate },
      {
        reviseSections: false,
        editorial: {
          enabled: true,
          requireExample: true,
        },
      },
    );

    const result = await assembler.assemble({
      topic: "Why Humans Procrastinate",
      durationSeconds: 60,
    });

    expect(result.editorialQuality?.issues.length).toBeGreaterThan(0);

    // One outline, one hook, one section, one outro.
    expect(generate).toHaveBeenCalledTimes(4);
  });
});


