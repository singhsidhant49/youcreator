import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  createAuthoritativeM3Adapter,
} from "./authoritative-m3-adapter.js";

import {
  loadVerifiedProductionPackage,
} from "./verified-production-package.js";

import {
  getMediaResolutionManifestPath,
} from "./media-pipeline-registration.js";

import {
  PersistentMediaResolutionStage,
  type PersistentMediaManifest,
  type PersistentMediaInput,
} from "./persistent-media-resolution.js";

import {
  MediaObjectStore,
} from "./media-object-store.js";

import {
  MediaUsageRightsStore,
} from "./media-usage-rights-store.js";

import {
  StoredMediaAssetVerifier,
  StoredMediaRightsChecker,
} from "./media-production-adapters.js";

import type {
  VerifiedM4VisualSource,
  VerifiedM4VisualArtifact,
} from "./trusted-visual-artifact-assembly.js";

import {
  resolveModeCAssignments,
} from "./media-resolution-coordinator.js";

const HashSchema = z.string()
  .regex(/^[a-f0-9]{64}$/);

const ShotIdSchema = z.string()
  .trim()
  .min(1);

/**
 * This is a preflight identity schema, not a
 * replacement for the authoritative M4 schema.
 *
 * PersistentMediaResolutionStage.run() performs
 * complete manifest parsing and verification.
 */
const ManifestPreflightSchema = z.object({
  version: z.literal(1),
  inputHash: HashSchema,

  jobId: ShotIdSchema,
  storyboardSha256: HashSchema,
  mediaPlanSha256: HashSchema,

  stageVersion: z.literal(
    "m4-resolution-v1",
  ),

  report: z.object({
    jobId: ShotIdSchema,
    mode: z.enum(["A", "B", "C", "D"]),
    passed: z.literal(true),
    expectedShots: z.number().int().nonnegative(),
    assignedShots: z.number().int().nonnegative(),

    assignments: z.array(
      z.object({
        shotId: ShotIdSchema,
      }).passthrough(),
    ),
  }).passthrough(),
}).passthrough();

export interface NativeM4VisualSourceOptions {
  /**
   * Canonical M1 job directory resolver.
   * Must match JobExecutor.
   */
  jobDirectory(jobId: string): string;

  /**
   * The source must use the same storage root
   * as the completed M4 media stage.
   */
  storageRoot: string;

  expectedMode?: "A" | "B" | "C" | "D";
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function assertShotIds(
  shotIds: readonly string[],
): void {
  if (
    shotIds.length === 0 ||
    new Set(shotIds).size !== shotIds.length
  ) {
    throw new Error(
      "Native M4 shot IDs are empty or duplicated",
    );
  }

  for (const shotId of shotIds) {
    ShotIdSchema.parse(shotId);
  }
}

/**
 * Check manifest identity BEFORE asking the
 * persistent stage to validate and reuse it.
 *
 * Full media integrity remains the responsibility
 * of PersistentMediaResolutionStage.
 */
export function assertNativeM4ManifestPreflight(
  input: {
    manifest: unknown;
    jobId: string;
    storyboardSha256: string;
    mediaPlanSha256: string;
    shotIds: readonly string[];
  },
): void {
  assertShotIds(input.shotIds);

  const manifest =
    ManifestPreflightSchema.parse(
      input.manifest,
    );

  if (
    manifest.jobId !== input.jobId ||
    manifest.report.jobId !== input.jobId ||
    manifest.storyboardSha256 !==
      input.storyboardSha256 ||
    manifest.mediaPlanSha256 !==
      input.mediaPlanSha256
  ) {
    throw new Error(
      "Native M4 manifest identity mismatch",
    );
  }

  if (
    manifest.report.expectedShots !==
      input.shotIds.length ||
    manifest.report.assignedShots !==
      input.shotIds.length ||
    manifest.report.assignments.length !==
      input.shotIds.length
  ) {
    throw new Error(
      "Native M4 manifest shot coverage mismatch",
    );
  }

  const assignedIds =
    manifest.report.assignments.map(
      (assignment) => assignment.shotId,
    );

  if (
    assignedIds.some(
      (id, index) =>
        id !== input.shotIds[index],
    )
  ) {
    // Assignments are usually expected in
    // canonical M3 shot order.
    //
    // We deliberately reject unexpected order
    // rather than silently normalizing it.
    throw new Error(
      "Native M4 assignment order mismatch",
    );
  }
}

export function createNativeM4VisualSource(
  options: NativeM4VisualSourceOptions,
): VerifiedM4VisualSource {
  if (!path.isAbsolute(options.storageRoot)) {
    throw new Error(
      "Native M4 storage root must be absolute",
    );
  }

  const m3Adapter =
    createAuthoritativeM3Adapter();

  const objectStore =
    new MediaObjectStore({
      storageRoot: options.storageRoot,
    });

  const rightsStore =
    new MediaUsageRightsStore(
      options.storageRoot,
    );

  const assetVerifier =
    new StoredMediaAssetVerifier(
      objectStore,
    );

  const rightsChecker =
    new StoredMediaRightsChecker({
      objectStore,
      rightsStore,
    });

  /**
   * Critical safety guard:
   *
   * This coordinator MUST NEVER run.
   *
   * M5 can only validate already persisted M4
   * media. It must not initiate discovery,
   * acquisition or paid image generation.
   */
  const persistentStage =
    new PersistentMediaResolutionStage({
      storageRoot: options.storageRoot,

      allowNonBillableRecovery: false,

      coordinator: {
        async run() {
          throw new Error(
            "M5 verification-only source cannot resolve media",
          );
        },
      },

      assetVerifier,
      rightsChecker,
    });

  return {
    async load({
      jobId,
      storageRoot,
      productionPackageHash,
      shotIds,
    }): Promise<VerifiedM4VisualArtifact> {
      if (
        path.resolve(storageRoot) !==
        path.resolve(options.storageRoot)
      ) {
        throw new Error(
          "Native M4 storage root mismatch",
        );
      }

      HashSchema.parse(
        productionPackageHash,
      );

      assertShotIds(shotIds);

      const jobDirectory =
        options.jobDirectory(jobId);

      if (!path.isAbsolute(jobDirectory)) {
        throw new Error(
          "Native M4 job directory must be absolute",
        );
      }

      // 1. Independently verify the current M3
      // production package.
      const m3 =
        await loadVerifiedProductionPackage({
          jobId,
          jobDirectory,
          expectedMode: options.expectedMode,
          adapter: m3Adapter,
        });

      if (
        m3.packageHash !==
          productionPackageHash
      ) {
        throw new Error(
          "Native M4 production package hash mismatch",
        );
      }

      if (
        JSON.stringify(m3.shotIds) !==
        JSON.stringify(shotIds)
      ) {
        throw new Error(
          "Native M4 M3 shot sequence mismatch",
        );
      }

      // 2. Require an EXISTING completed M4
      // manifest. Never create one here.
      const manifestPath =
        getMediaResolutionManifestPath(
          options.storageRoot,
          jobId,
        );

      let savedManifest: unknown;

      try {
        savedManifest = JSON.parse(
          await readFile(
            manifestPath,
            "utf8",
          ),
        );
      } catch {
        throw new Error(
          "Native M4 completed manifest missing or unreadable",
        );
      }

      // 3. Reject missing, incomplete or stale
      // identity before invoking persistent reuse.
      assertNativeM4ManifestPreflight({
        manifest: savedManifest,
        jobId,

        storyboardSha256:
          m3.storyboardSha256,

        mediaPlanSha256:
          m3.mediaPlanSha256,

        shotIds,
      });

      // 4. Reconstruct the exact M4 input used
      // for the existing media stage.
      const isV2 =
        typeof m3.package.mediaPlan === "object" &&
        m3.package.mediaPlan !== null &&
        "version" in m3.package.mediaPlan &&
        (m3.package.mediaPlan as Record<string, unknown>).version === 2;

      let jobConfig: Record<string, unknown> | undefined;
      try {
        const jobDir = options.jobDirectory(jobId);
        const candidates = [
          path.join(path.dirname(jobDir), `${jobId}.json`),
          path.join(jobDir, `${jobId}.json`),
          path.join(jobDir, "job.json"),
        ];
        for (const candidate of candidates) {
          try {
            const raw = await readFile(candidate, "utf8");
            const parsed = JSON.parse(raw);
            jobConfig =
              parsed && typeof parsed === "object" && "config" in parsed && parsed.config
                ? (parsed.config as Record<string, unknown>)
                : (parsed as Record<string, unknown>);
            if (jobConfig) break;
          } catch {}
        }
      } catch {}

      const input: PersistentMediaInput = {
        jobId,

        storyboardSha256:
          m3.storyboardSha256,

        mediaPlanSha256:
          m3.mediaPlanSha256,

        stageVersion:
          "m4-resolution-v1",

        request: isV2
          ? ((m3.package.mediaPlan as any)?.mode === "A"
              ? {
                  version: 2,
                  jobId,
                  mode: "A",
                  shotIds: [...shotIds],
                }
              : (m3.package.mediaPlan as any)?.mode === "C"
                ? {
                    version: 2,
                    jobId,
                    mode: "C",
                    shotIds: [...shotIds],
                    assignments: resolveModeCAssignments(
                      (jobConfig as any)?.assignments,
                      shotIds,
                    ),
                  }
                : {
                    version: 2,
                    jobId,
                    mode: "B",
                    shotIds: [...shotIds],
                    allowPaidGeneration: true,
                    provider: (jobConfig as any)?.imageProvider,
                    model: (jobConfig as any)?.imageModel,
                  })
          : {
              jobId,
              mode: "B",
              shotIds: [...shotIds],
            },
      };

      // 5. Invoke the EXISTING production
      // manifest reuse and integrity path.
      //
      // On successful reuse it:
      // - validates inputHash
      // - validates complete report
      // - verifies stored media bytes
      // - checks current usage rights
      //
      // The coordinator is forbidden to run.
      const result =
        await persistentStage.run(
          input,
        );

      if (!result.reused) {
        throw new Error(
          "Native M4 expected verified manifest reuse",
        );
      }

      const manifest:
        PersistentMediaManifest =
          result.manifest;

      // 6. Recheck the returned manifest identity.
      assertNativeM4ManifestPreflight({
        manifest,
        jobId,

        storyboardSha256:
          m3.storyboardSha256,

        mediaPlanSha256:
          m3.mediaPlanSha256,

        shotIds,
      });

      // 7. Produce the manifest identity using
      // the same JSON SHA-256 convention as M4.
      return {
        jobId,
        mode: (manifest.report as any)?.mode ?? "B",

        productionPackageHash:
          m3.packageHash,

        manifestHash: sha256(manifest),

        report: manifest.report,
      };
    },
  };
}
