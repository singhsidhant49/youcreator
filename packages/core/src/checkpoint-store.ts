import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  PipelineStageIdSchema,
  type PipelineStageId,
} from "@youcreator/contracts";

const CheckpointSchema = z.object({
  version: z.literal(1),
  stageId: PipelineStageIdSchema,
  status: z.literal("completed"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  completedAt: z.string().datetime(),
  output: z.unknown(),
});

export type StageCheckpoint = z.infer<typeof CheckpointSchema>;

export class CheckpointStore {
  constructor(private readonly jobDirectory: string) {}

  private checkpointPath(stageId: PipelineStageId): string {
    PipelineStageIdSchema.parse(stageId);

    return path.join(
      this.jobDirectory,
      "checkpoints",
      `${stageId}.json`,
    );
  }

  async save(
    stageId: PipelineStageId,
    output: unknown,
    hash: string,
  ): Promise<void> {
    const checkpoint = CheckpointSchema.parse({
      version: 1,
      stageId,
      status: "completed",
      inputHash: hash,
      completedAt: new Date().toISOString(),
      output,
    });

    const filename = this.checkpointPath(stageId);
    const temporaryFile = `${filename}.${randomUUID()}.tmp`;

    await mkdir(path.dirname(filename), {
      recursive: true,
    });

    try {
      await writeFile(
        temporaryFile,
        JSON.stringify(checkpoint, null, 2),
        { encoding: "utf8", flag: "wx" },
      );

      await rename(temporaryFile, filename);
    } catch (error) {
      await rm(temporaryFile, { force: true });
      throw error;
    }
  }

  async load(
    stageId: PipelineStageId,
  ): Promise<StageCheckpoint | null> {
    try {
      const content = await readFile(
        this.checkpointPath(stageId),
        "utf8",
      );

      const checkpoint = CheckpointSchema.parse(
        JSON.parse(content),
      );

      if (checkpoint.stageId !== stageId) {
        throw new Error("Checkpoint stage mismatch");
      }

      return checkpoint;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }

      if (
        error instanceof SyntaxError ||
        error instanceof z.ZodError
      ) {
        return null;
      }

      throw error;
    }
  }
}
