import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { inputHash } from "@youcreator/core";

function narrationHash(text: string): string {
  return createHash("sha256")
    .update(text, "utf8")
    .digest("hex");
}

const CachedPartSchema = z.object({
  version: z.literal(2),

  inputHash: z.string().regex(/^[a-f0-9]{64}$/),

  contentHash: z.string().regex(/^[a-f0-9]{64}$/),

  narration: z.string().trim().min(1),

  createdAt: z.string().datetime(),
});

export interface ScriptPartInput {
  kind: "outline" | "hook" | "section" | "outro";
  id: string;
  promptVersion: string;
  model: string;
  context: unknown;
}

export function scriptPartHash(
  input: ScriptPartInput,
): string {
  return inputHash(input);
}

export class ScriptPartCache {
  constructor(private readonly directory: string) {}

  private getPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("Invalid script part hash");
    }

    return path.join(this.directory, `${hash}.json`);
  }

  async load(hash: string): Promise<string | null> {
    const file = this.getPath(hash);

    try {
      const content = await readFile(file, "utf8");

      const parsed = CachedPartSchema.parse(
        JSON.parse(content),
      );

      if (parsed.inputHash !== hash) {
        return null;
      }

      if (
        narrationHash(parsed.narration) !== parsed.contentHash
      ) {
        return null;
      }

      return parsed.narration;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        error instanceof z.ZodError
      ) {
        return null;
      }

      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }

      throw error;
    }
  }

  async save(hash: string, narration: string): Promise<void> {
    const file = this.getPath(hash);

    const checkpoint = CachedPartSchema.parse({
      version: 2,
      inputHash: hash,
      contentHash: narrationHash(narration),
      narration,
      createdAt: new Date().toISOString(),
    });

    await mkdir(this.directory, { recursive: true });

    const temporary = `${file}.${randomUUID()}.tmp`;

    try {
      await writeFile(
        temporary,
        JSON.stringify(checkpoint, null, 2),
        {
          encoding: "utf8",
          flag: "wx",
        },
      );

      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
