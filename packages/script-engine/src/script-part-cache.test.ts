import { describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ScriptPartCache,
  scriptPartHash,
} from "./script-part-cache.js";

async function createTestCache() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "youcreator-script-cache-"),
  );

  return {
    directory,
    cache: new ScriptPartCache(directory),
  };
}

const input = {
  kind: "section" as const,
  id: "section-001",
  promptVersion: "1",
  model: "test-model",
  context: {
    title: "Why Humans Procrastinate",
    targetWords: 150,
  },
};

describe("ScriptPartCache", () => {
  it("saves and restores narration", async () => {
    const env = await createTestCache();

    try {
      const hash = scriptPartHash(input);

      await env.cache.save(
        hash,
        "Complete section narration.",
      );

      const restored = await env.cache.load(hash);

      expect(restored).toBe(
        "Complete section narration.",
      );
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("returns null when the checkpoint is missing", async () => {
    const env = await createTestCache();

    try {
      const hash = scriptPartHash(input);

      expect(await env.cache.load(hash)).toBeNull();
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("changes the hash when context changes", () => {
    const first = scriptPartHash(input);

    const second = scriptPartHash({
      ...input,
      context: {
        title: "Why Humans Procrastinate",
        targetWords: 250,
      },
    });

    expect(first).not.toBe(second);
  });

  it("ignores corrupted cache entries", async () => {
    const env = await createTestCache();

    try {
      const hash = scriptPartHash(input);

      await env.cache.save(
        hash,
        "Valid narration.",
      );

      const file = path.join(
        env.directory,
        `${hash}.json`,
      );

      await writeFile(file, "{invalid-json");

      expect(await env.cache.load(hash)).toBeNull();
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("rejects empty narration", async () => {
    const env = await createTestCache();

    try {
      await expect(
        env.cache.save(
          scriptPartHash(input),
          "",
        ),
      ).rejects.toThrow();
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("rejects narration modified after caching", async () => {
    const env = await createTestCache();

    try {
      const hash = scriptPartHash(input);

      await env.cache.save(
        hash,
        "Original valid narration.",
      );

      const file = path.join(
        env.directory,
        `${hash}.json`,
      );

      const checkpoint = JSON.parse(
        await readFile(file, "utf8"),
      );

      checkpoint.narration =
        "Someone modified this narration.";

      await writeFile(
        file,
        JSON.stringify(checkpoint),
      );

      const restored = await env.cache.load(hash);

      expect(restored).toBeNull();
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("stores and validates the narration content hash", async () => {
    const env = await createTestCache();

    try {
      const hash = scriptPartHash(input);

      await env.cache.save(
        hash,
        "An important documentary narration.",
      );

      const file = path.join(
        env.directory,
        `${hash}.json`,
      );

      const checkpoint = JSON.parse(
        await readFile(file, "utf8"),
      );

      expect(checkpoint.version).toBe(2);
      expect(checkpoint.contentHash).toMatch(
        /^[a-f0-9]{64}$/,
      );

      expect(await env.cache.load(hash)).toBe(
        "An important documentary narration.",
      );
    } finally {
      await rm(env.directory, {
        recursive: true,
        force: true,
      });
    }
  });
});

