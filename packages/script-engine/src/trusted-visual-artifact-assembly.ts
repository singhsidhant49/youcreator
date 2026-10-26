import path from "node:path";
import { z } from "zod";

import type {
  MediaResolutionReport,
} from "./media-resolution-coordinator.js";

import type {
  CanonicalShotTiming,
} from "./shot-frame-geometry.js";

import {
  reconstructAuthoritativeVisualPackage,
  type AuthoritativeVisualResult,
  type ExpectedVisualPackages,
} from "./authoritative-visual-reconstruction.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().min(1);

const TimingSchema = z.object({
  shotId: IdSchema,
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
}).strict();

export interface VerifiedM3VisualArtifact {
  jobId: string;
  packageHash: string;
  mode: "A" | "B" | "C" | "D";
  shotIds: string[];
  timings: CanonicalShotTiming[];
}

/**
 * The adapter implementing this interface MUST:
 *
 * - Parse the real persisted M3 envelope.
 * - Run verifyStoryboardProductionPackage.
 * - Bind to the current M1 storyboard checkpoint.
 * - Extract timings from M3's authoritative timeline.
 */
export interface VerifiedM3VisualSource {
  load(
    input: {
      jobId: string;
      jobDirectory: string;
    },
  ): Promise<VerifiedM3VisualArtifact>;
}

export interface VerifiedM4VisualArtifact {
  jobId: string;
  mode: "A" | "B" | "C" | "D";

  productionPackageHash: string;
  manifestHash: string;

  report: MediaResolutionReport;
}

/**
 * The adapter implementing this interface MUST:
 *
 * - Load the saved M4 manifest.
 * - Verify its complete report and request identity.
 * - Verify actual stored asset bytes.
 * - Recheck current usage rights.
 * - Reject missing, incomplete or interrupted attempts.
 *
 * Merely parsing manifest.json is NOT sufficient.
 */
export interface VerifiedM4VisualSource {
  load(
    input: {
      jobId: string;
      storageRoot: string;
      productionPackageHash: string;
      shotIds: string[];
    },
  ): Promise<VerifiedM4VisualArtifact>;
}

export interface TrustedVisualArtifactSources {
  m3: VerifiedM3VisualSource;
  m4: VerifiedM4VisualSource;
}

export interface AssembleTrustedVisualPackageInput {
  jobId: string;
  jobDirectory: string;
  storageRoot: string;

  sources: TrustedVisualArtifactSources;

  fps?: number;
  frameWidth?: number;
  frameHeight?: number;

  expected?: ExpectedVisualPackages;
}

function assertUniqueShotIds(
  shotIds: string[],
): void {
  if (
    shotIds.length === 0 ||
    new Set(shotIds).size !== shotIds.length
  ) {
    throw new Error(
      "M3 shot sequence is empty or contains duplicates",
    );
  }

  for (const shotId of shotIds) {
    IdSchema.parse(shotId);
  }
}

function verifyM3Timings(
  shotIds: string[],
  timings: CanonicalShotTiming[],
): CanonicalShotTiming[] {
  const parsed = z.array(TimingSchema)
    .min(1)
    .parse(timings);

  if (parsed.length !== shotIds.length) {
    throw new Error(
      "M3 timeline shot coverage mismatch",
    );
  }

  let previousEnd = 0;

  for (let index = 0; index < parsed.length; index++) {
    const timing = parsed[index]!;

    if (timing.shotId !== shotIds[index]) {
      throw new Error(
        `M3 timeline shot order mismatch at ${index}`,
      );
    }

    if (timing.endSeconds <= timing.startSeconds) {
      throw new Error(
        `Invalid M3 shot duration: ${timing.shotId}`,
      );
    }

    if (
      Math.abs(timing.startSeconds - previousEnd) >
      0.00001
    ) {
      throw new Error(
        `M3 timeline discontinuity: ${timing.shotId}`,
      );
    }

    previousEnd = timing.endSeconds;
  }

  return parsed;
}

/**
 * Trusted orchestration boundary.
 *
 * No caller-provided media report, M3 timing, or
 * package hash is accepted directly.
 *
 * Both source adapters must independently verify
 * the persisted artifacts they return.
 */
export async function assembleTrustedVisualPackage(
  input: AssembleTrustedVisualPackageInput,
): Promise<AuthoritativeVisualResult> {
  const jobId = IdSchema.parse(input.jobId);

  if (
    !path.isAbsolute(input.jobDirectory) ||
    !path.isAbsolute(input.storageRoot)
  ) {
    throw new Error(
      "Trusted visual assembly requires absolute roots",
    );
  }

  const m3 = await input.sources.m3.load({
    jobId,
    jobDirectory: input.jobDirectory,
  });

  const allowedModes = ["A", "B", "C", "D"];
  if (m3.jobId !== jobId || !allowedModes.includes(m3.mode)) {
    throw new Error(
      "Verified M3 job identity or mode mismatch",
    );
  }

  const productionPackageHash =
    HashSchema.parse(m3.packageHash);

  assertUniqueShotIds(m3.shotIds);

  const timings = verifyM3Timings(
    m3.shotIds,
    m3.timings,
  );

  // M4's source must authenticate the complete
  // persisted manifest and current usage rights.
  const m4 = await input.sources.m4.load({
    jobId,
    storageRoot: input.storageRoot,
    productionPackageHash,
    shotIds: [...m3.shotIds],
  });

  if (
    m4.jobId !== jobId ||
    m4.mode !== m3.mode ||
    m4.productionPackageHash !==
      productionPackageHash
  ) {
    throw new Error(
      "Verified M4 artifact identity mismatch",
    );
  }

  const mediaManifestHash =
    HashSchema.parse(m4.manifestHash);

  if (
    m4.report.jobId !== jobId ||
    m4.report.mode !== m3.mode ||
    !m4.report.passed
  ) {
    throw new Error(
      "Verified M4 report is incomplete or mismatched",
    );
  }

  const isV2 =
    m3.mode === "A" ||
    m3.mode === "C" ||
    (m4.report as any)?.version === 2 ||
    (m4.report as any)?.mode === "A" ||
    (m4.report as any)?.mode === "C";

  const request = isV2
    ? (m3.mode === "A"
        ? {
            version: 2 as const,
            jobId,
            mode: "A" as const,
            shotIds: [...m3.shotIds],
          }
        : m3.mode === "C"
          ? {
              version: 2 as const,
              jobId,
              mode: "C" as const,
              shotIds: [...m3.shotIds],
              assignments: Array.isArray((m4.report as any)?.assignments)
                ? (m4.report as any).assignments.map((a: any) => ({
                    shotId: a.shotId,
                    assetId: a.asset?.provenance?.providerAssetId ?? a.asset?.id ?? a.assetId,
                    localPath: a.asset?.localPath ?? a.localPath,
                  }))
                : [],
            }
          : {
              version: 2 as const,
              jobId,
              mode: "B" as const,
              shotIds: [...m3.shotIds],
              allowPaidGeneration: true,
            })
    : {
        jobId,
        mode: "B" as const,
        shotIds: [...m3.shotIds],
      };

  return reconstructAuthoritativeVisualPackage(
    {
      request,
      report: m4.report,
      productionPackageHash,
      mediaManifestHash,
      timings,
      fps: input.fps,
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
    },
    input.expected,
  );
}
