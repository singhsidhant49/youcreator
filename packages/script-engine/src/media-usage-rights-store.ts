import {
  createHash,
  randomUUID,
} from "node:crypto";

import {
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";

import path from "node:path";
import { z } from "zod";

import {
  MediaUsageAssessmentSchema,
  MediaUsageRightsInputSchema,
  evaluateMediaUsageRights,
  type MediaUsageAssessment,
  type MediaUsageRightsInput,
} from "./media-usage-rights.js";

const HashSchema = z.string().regex(
  /^[a-f0-9]{64}$/,
);

const StoredAssessmentSchema = z.object({
  version: z.literal(1),
  recordHash: HashSchema,
  assessment: MediaUsageAssessmentSchema,
}).strict();

function sha256(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function isCode(
  error: unknown,
  code: string,
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}

export class MediaUsageRightsStore {
  private readonly root: string;

  constructor(storageRoot: string) {
    if (!storageRoot.trim()) {
      throw new Error("storageRoot is required");
    }

    this.root = path.resolve(storageRoot);
  }

  private getPath(
    input: MediaUsageRightsInput,
  ): string {
    const checked =
      MediaUsageRightsInputSchema.parse(input);

    const key = sha256(
      JSON.stringify([
        checked.source.provider,
        checked.source.id,
        checked.assetHash,
        checked.intendedUse,
      ]),
    );

    return path.join(
      this.root,
      "manifests",
      "usage-rights",
      key.slice(0, 2),
      `${key}.json`,
    );
  }

  async load(
    input: MediaUsageRightsInput,
  ): Promise<MediaUsageAssessment | null> {
    const filename = this.getPath(input);

    let raw: string;

    try {
      raw = await readFile(
        filename,
        "utf8",
      );
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return null;
      }

      throw error;
    }

    const stored = StoredAssessmentSchema.parse(
      JSON.parse(raw),
    );

    const expectedHash = sha256(
      JSON.stringify(stored.assessment),
    );

    if (stored.recordHash !== expectedHash) {
      throw new Error(
        "Media usage assessment integrity mismatch",
      );
    }

    const expected =
      evaluateMediaUsageRights(
        stored.assessment.input,
      );

    if (
      JSON.stringify(expected) !==
      JSON.stringify(stored.assessment)
    ) {
      throw new Error(
        "Media usage assessment policy mismatch",
      );
    }

    const requested =
      MediaUsageRightsInputSchema.parse(input);

    const savedInput = stored.assessment.input;

    if (
      savedInput.source.provider !==
        requested.source.provider ||
      savedInput.source.id !==
        requested.source.id ||
      savedInput.assetHash !==
        requested.assetHash ||
      savedInput.intendedUse !==
        requested.intendedUse
    ) {
      throw new Error(
        "Media usage assessment identity mismatch",
      );
    }

    return stored.assessment;
  }

  async save(
    input: MediaUsageRightsInput,
  ): Promise<MediaUsageAssessment> {
    const assessment =
      evaluateMediaUsageRights(input);

    const filename = this.getPath(
      assessment.input,
    );

    const existing = await this.load(
      assessment.input,
    );

    if (existing) {
      if (
        JSON.stringify(existing) !==
        JSON.stringify(assessment)
      ) {
        throw new Error(
          "Media usage assessment already exists",
        );
      }

      return existing;
    }

    const directory = path.dirname(filename);

    await mkdir(directory, {
      recursive: true,
    });

    const stored = StoredAssessmentSchema.parse({
      version: 1,
      recordHash: sha256(
        JSON.stringify(assessment),
      ),
      assessment,
    });

    const temporary = path.join(
      directory,
      `.${randomUUID()}.tmp`,
    );

    await writeFile(
      temporary,
      JSON.stringify(stored, null, 2),
      { flag: "wx" },
    );

    try {
      try {
        await link(
          temporary,
          filename,
        );
      } catch (error) {
        if (!isCode(error, "EEXIST")) {
          throw error;
        }

        const winner = await this.load(
          assessment.input,
        );

        if (
          !winner ||
          JSON.stringify(winner) !==
            JSON.stringify(assessment)
        ) {
          throw new Error(
            "Concurrent media usage assessment conflict",
          );
        }

        return winner;
      }
    } finally {
      await unlink(temporary).catch(
        (error: unknown) => {
          if (!isCode(error, "ENOENT")) {
            throw error;
          }
        },
      );
    }

    return assessment;
  }
}
