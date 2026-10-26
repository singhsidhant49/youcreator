import { randomUUID } from "node:crypto";

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
  StoryboardProductionPackageSchema,
  verifyStoryboardProductionPackage,
  type StoryboardProductionPackage,
} from "./storyboard-production-package.js";

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/);

const JobIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/);

export const StoryboardArtifactEnvelopeSchema =
  z.object({
    version: z.literal(1),

    jobId: JobIdSchema,

    generationFingerprint: Sha256Schema,
    sourceScriptHash: Sha256Schema,

    package: StoryboardProductionPackageSchema,
  }).strict();

export type StoryboardArtifactEnvelope = z.infer<
  typeof StoryboardArtifactEnvelopeSchema
>;

export interface SaveStoryboardArtifactInput {
  jobsRoot: string;
  jobId: string;
  generationFingerprint: string;
  package: StoryboardProductionPackage;
}

export interface LoadStoryboardArtifactInput {
  jobsRoot: string;
  jobId: string;
  expectedGenerationFingerprint: string;
  expectedScriptHash: string;
}

function artifactPath(
  jobsRoot: string,
  jobId: string,
): string {
  JobIdSchema.parse(jobId);

  return path.join(
    path.resolve(jobsRoot),
    jobId,
    "storyboard",
    "production-package.json",
  );
}

export function getStoryboardArtifactPath(
  jobsRoot: string,
  jobId: string,
): string {
  return artifactPath(jobsRoot, jobId);
}

export async function saveStoryboardJobArtifact(
  input: SaveStoryboardArtifactInput,
): Promise<string> {
  JobIdSchema.parse(input.jobId);

  const generationFingerprint =
    Sha256Schema.parse(input.generationFingerprint);

  const productionPackage =
    verifyStoryboardProductionPackage(input.package);

  const envelope = StoryboardArtifactEnvelopeSchema.parse({
    version: 1,

    jobId: input.jobId,

    generationFingerprint,

    sourceScriptHash:
      productionPackage.scriptHash,

    package: productionPackage,
  });

  const filename = artifactPath(
    input.jobsRoot,
    input.jobId,
  );

  const directory = path.dirname(filename);

  await mkdir(directory, {
    recursive: true,
  });

  const temporaryFilename = path.join(
    directory,
    `.production-package.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(
      temporaryFilename,
      JSON.stringify(envelope, null, 2),
      {
        encoding: "utf8",
        flag: "wx",
      },
    );

    // A hard link provides an atomic, create-only
    // publication on supported local filesystems.
    //
    // EEXIST means another package was published.
    // Never replace it.
    await link(temporaryFilename, filename);

    return filename;
  } finally {
    await unlink(temporaryFilename).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }

      throw error;
    });
  }
}

export type LoadedStoryboardJobArtifact =
  Omit<StoryboardArtifactEnvelope, "package"> & {
    package: StoryboardProductionPackage;
  };

export async function loadStoryboardJobArtifact(
  input: LoadStoryboardArtifactInput,
): Promise<LoadedStoryboardJobArtifact> {
  const expectedFingerprint =
    Sha256Schema.parse(
      input.expectedGenerationFingerprint,
    );

  const expectedScriptHash =
    Sha256Schema.parse(input.expectedScriptHash);

  const filename = artifactPath(
    input.jobsRoot,
    input.jobId,
  );

  const raw = await readFile(filename, "utf8");

  const envelope =
    StoryboardArtifactEnvelopeSchema.parse(
      JSON.parse(raw),
    );

  if (envelope.jobId !== input.jobId) {
    throw new Error(
      "Storyboard artifact job ID mismatch",
    );
  }

  if (
    envelope.generationFingerprint !==
    expectedFingerprint
  ) {
    throw new Error(
      "Storyboard generation fingerprint mismatch",
    );
  }

  if (
    envelope.sourceScriptHash !==
    expectedScriptHash
  ) {
    throw new Error(
      "Storyboard source script hash mismatch",
    );
  }

  const verifiedPackage =
    verifyStoryboardProductionPackage(
      envelope.package,
    );

  if (
    verifiedPackage.scriptHash !==
    envelope.sourceScriptHash
  ) {
    throw new Error(
      "Storyboard artifact source/package mismatch",
    );
  }

  return {
    ...envelope,
    package: verifiedPackage,
  };
}
