import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { DeepSeekClient } from "@youcreator/llm";

import {
  ScriptGenerationService,
} from "@youcreator/script-engine";

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.();
  } catch {
    // .env is optional if environment variables are already set
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Missing DEEPSEEK_API_KEY environment variable",
    );
  }

  const topic =
    process.argv.slice(2).join(" ").trim() ||
    "Why Humans Procrastinate";

  const model = process.env.DEEPSEEK_MODEL ??
    "deepseek-flash";

  const provider = new DeepSeekClient({
    apiKey,
    model,
    timeoutMs: 120000,
  });

  const service = new ScriptGenerationService(provider, {
    budget: {
      maxRequests: 12,
      maxOutputTokens: 30000,
      maxTokensPerRequest: 4096,
    },

    assembler: {
      reviseSections: false,
      enforceQuality: false,
    },
  });

  const brief = {
    topic,
    durationSeconds: 60,
    language: "en",
    tone: "engaging documentary",
    audience: "general",
  };

  console.log("Generating script...");
  console.log("Topic:", topic);
  console.log("Model:", model);

  let result;

  try {
    result = await service.generate(brief);
  } catch (error) {
    console.error("Generation failed:", error);
    console.error(
      "Usage before failure:",
      service.getUsage(),
    );
    throw error;
  }

  const outputDirectory = path.resolve(
    "output",
    "script-smoke",
    randomUUID(),
  );

  await mkdir(outputDirectory, {
    recursive: true,
  });

  await writeFile(
    path.join(outputDirectory, "script.json"),
    JSON.stringify(result.script, null, 2),
    "utf8",
  );

  const fullNarration = [
    result.script.hook,
    ...result.script.sections.map(
      (section) => section.narration,
    ),
    result.script.outro,
  ].join("\n\n");

  await writeFile(
    path.join(outputDirectory, "narration.txt"),
    fullNarration,
    "utf8",
  );

  await writeFile(
    path.join(outputDirectory, "report.json"),
    JSON.stringify(
      {
        brief,
        model,
        quality: result.quality,
        targetWords: result.targetWords,
        actualWords: result.actualWords,
        estimatedDurationSeconds:
          result.estimatedDurationSeconds,
        sectionsGenerated: result.sectionsGenerated,
        llmUsage: result.llmUsage,
        cacheHits: result.cacheHits,
        cacheMisses: result.cacheMisses,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("\nGeneration completed.");
  console.log("Title:", result.script.title);
  console.log("Words:", result.actualWords);
  console.log(
    "Estimated duration:",
    result.estimatedDurationSeconds.toFixed(1),
    "seconds",
  );
  console.log(
    "Quality:",
    result.quality.passed ? "PASS" : "NEEDS REVIEW",
  );
  console.log("Usage:", result.llmUsage);
  console.log("Output:", outputDirectory);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );

  process.exitCode = 1;
});
