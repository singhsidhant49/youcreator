import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";

import {
  RemotionCompositionSchema,
  type RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  verifyVideoQaFramePlan,
  type VideoQaFramePlan,
} from "./video-qa-frame-plan.js";

import type {
  DecodedQaFrame,
} from "./video-qa-frame-analyzer.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const SafeInt = z.number().int().safe().nonnegative();

export const VisualVarietyFindingSchema = z.object({
  code: z.enum([
    "EXACT_ASSET_REUSE",
    "CONSECUTIVE_ASSET_REUSE",
    "NEAR_DUPLICATE_VISUAL",
    "CONSECUTIVE_VISUAL_SIMILARITY",
    "LOW_VISUAL_VARIETY",
  ]),
  severity: z.enum(["warning", "error"]),
  shotIds: z.array(z.string().min(1)).min(1),
  detail: z.string().min(1),
}).strict();

export const VisualVarietyReportSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  compositionHash: Hash,
  framePlanHash: Hash,
  shotCount: SafeInt,
  uniqueAssetCount: SafeInt,
  visualGroupCount: SafeInt,
  findings: z.array(VisualVarietyFindingSchema),
  reportHash: Hash,
}).strict();

export type VisualVarietyFinding = z.infer<
  typeof VisualVarietyFindingSchema
>;

export type VisualVarietyReport = z.infer<
  typeof VisualVarietyReportSchema
>;

export interface VisualVarietyPolicy {
  maximumAssetReuse?: number;
  nearDuplicateDistance?: number;
  minimumUniqueVisualRatio?: number;
  minimumShotsForVarietyCheck?: number;
}

const DEFAULT_POLICY = {
  maximumAssetReuse: 2,
  nearDuplicateDistance: 6,
  minimumUniqueVisualRatio: 0.5,
  minimumShotsForVarietyCheck: 4,
} as const;

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

/**
 * 64-bit perceptual difference hash.
 *
 * Resize to 9x8 grayscale, then compare
 * adjacent horizontal pixels.
 *
 * It detects broad visual similarity without
 * requiring external image recognition APIs.
 */
export async function imageDifferenceHash(
  bytes: Buffer,
): Promise<bigint> {
  const {
    data,
    info,
  } = await sharp(bytes)
    .resize(9, 8, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (
    info.channels !== 1 ||
    data.length !== 72
  ) {
    throw new Error(
      "M8 perceptual hash image dimensions invalid",
    );
  }

  let hash = 0n;

  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      const offset = row * 9 + column;

      if (
        data[offset]! >
        data[offset + 1]!
      ) {
        hash |= 1n << BigInt(
          row * 8 + column,
        );
      }
    }
  }

  return hash;
}

export function hammingDistance64(
  a: bigint,
  b: bigint,
): number {
  let xor = BigInt.asUintN(64, a ^ b);
  let count = 0;

  while (xor !== 0n) {
    xor &= xor - 1n;
    count++;
  }

  return count;
}

function validatePolicy(
  policy: VisualVarietyPolicy,
) {
  const p = {
    ...DEFAULT_POLICY,
    ...policy,
  };

  if (
    !Number.isSafeInteger(p.maximumAssetReuse) ||
    p.maximumAssetReuse < 1 ||
    !Number.isSafeInteger(p.nearDuplicateDistance) ||
    p.nearDuplicateDistance < 0 ||
    p.nearDuplicateDistance > 64 ||
    !Number.isFinite(p.minimumUniqueVisualRatio) ||
    p.minimumUniqueVisualRatio < 0 ||
    p.minimumUniqueVisualRatio > 1 ||
    !Number.isSafeInteger(p.minimumShotsForVarietyCheck) ||
    p.minimumShotsForVarietyCheck < 1
  ) {
    throw new Error(
      "M8 invalid visual variety policy",
    );
  }

  return p;
}

export async function analyzeVideoVisualVariety(
  compositionInput: RemotionComposition,
  planInput: VideoQaFramePlan,
  frames: readonly DecodedQaFrame[],
  policy: VisualVarietyPolicy = {},
): Promise<VisualVarietyReport> {
  const composition =
    RemotionCompositionSchema.parse(
      compositionInput,
    );

  const plan = verifyVideoQaFramePlan(
    planInput,
    composition,
  );

  const p = validatePolicy(policy);

  const frameByNumber = new Map<
    number,
    Buffer
  >();

  for (const frame of frames) {
    if (
      !Number.isSafeInteger(frame.frame) ||
      frameByNumber.has(frame.frame)
    ) {
      throw new Error(
        "M8 duplicate or invalid variety frame",
      );
    }

    frameByNumber.set(
      frame.frame,
      frame.png,
    );
  }

  if (
    frameByNumber.size !==
      plan.samples.length
  ) {
    throw new Error(
      "M8 visual variety frame coverage mismatch",
    );
  }

  /**
   * Compare representative middle-frame images
   * of each shot, not arbitrary motion endpoints.
   */
  const representatives: Array<{
    shotId: string;
    shotIndex: number;
    assetHash: string;
    perceptualHash: bigint;
  }> = [];

  for (const shot of composition.shots) {
    const preferredFrame =
      shot.startFrame +
      Math.floor(
        (shot.durationFrames - 1) / 2,
      );

    const sample = plan.samples.find(
      (item) =>
        item.shotId === shot.shotId &&
        item.frame === preferredFrame,
    );

    if (!sample) {
      throw new Error(
        `M8 missing representative frame for ${shot.shotId}`,
      );
    }

    const bytes = frameByNumber.get(
      sample.frame,
    );

    if (!bytes) {
      throw new Error(
        `M8 representative image missing for ${shot.shotId}`,
      );
    }

    representatives.push({
      shotId: shot.shotId,
      shotIndex: shot.shotIndex,
      assetHash: shot.assetSha256,
      perceptualHash:
        await imageDifferenceHash(bytes),
    });
  }

  const findings: VisualVarietyFinding[] = [];

  const assets = new Map<
    string,
    string[]
  >();

  for (const item of representatives) {
    const ids = assets.get(item.assetHash) ?? [];
    ids.push(item.shotId);
    assets.set(item.assetHash, ids);
  }

  for (const ids of assets.values()) {
    if (ids.length > p.maximumAssetReuse) {
      findings.push({
        code: "EXACT_ASSET_REUSE",
        severity: "warning",
        shotIds: ids,
        detail:
          `The same asset is used in ${ids.length} shots`,
      });
    }
  }

  for (
    let i = 1;
    i < representatives.length;
    i++
  ) {
    const previous =
      representatives[i - 1]!;
    const current =
      representatives[i]!;

    if (
      previous.assetHash ===
      current.assetHash
    ) {
      findings.push({
        code: "CONSECUTIVE_ASSET_REUSE",
        severity: "warning",
        shotIds: [
          previous.shotId,
          current.shotId,
        ],
        detail:
          "Adjacent shots reuse the identical source asset",
      });
    }
  }

  /**
   * Build connected similarity groups.
   *
   * Pairwise similarity is not transitive,
   * but connected groups give a deterministic
   * conservative estimate of visual diversity.
   */
  const parent = representatives.map(
    (_, index) => index,
  );

  function find(index: number): number {
    let current = index;

    while (parent[current] !== current) {
      current = parent[current]!;
    }

    return current;
  }

  function union(a: number, b: number): void {
    const rootA = find(a);
    const rootB = find(b);

    if (rootA !== rootB) {
      parent[Math.max(rootA, rootB)] =
        Math.min(rootA, rootB);
    }
  }

  for (
    let i = 0;
    i < representatives.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < representatives.length;
      j++
    ) {
      const a = representatives[i]!;
      const b = representatives[j]!;

      const distance = hammingDistance64(
        a.perceptualHash,
        b.perceptualHash,
      );

      if (
        distance >
        p.nearDuplicateDistance
      ) {
        continue;
      }

      union(i, j);

      if (
        a.assetHash !== b.assetHash
      ) {
        findings.push({
          code: j === i + 1
            ? "CONSECUTIVE_VISUAL_SIMILARITY"
            : "NEAR_DUPLICATE_VISUAL",
          severity: "warning",
          shotIds: [
            a.shotId,
            b.shotId,
          ],
          detail:
            `Perceptual distance ${distance}/64`,
        });
      }
    }
  }

  const visualGroupCount = new Set(
    representatives.map(
      (_, index) => find(index),
    ),
  ).size;

  const uniqueAssetCount =
    assets.size;

  if (
    representatives.length >=
      p.minimumShotsForVarietyCheck &&
    visualGroupCount /
      representatives.length <
      p.minimumUniqueVisualRatio
  ) {
    findings.push({
      code: "LOW_VISUAL_VARIETY",
      severity: "warning",
      shotIds:
        representatives.map((r) => r.shotId),
      detail:
        `${visualGroupCount} distinct visual groups across ` +
        `${representatives.length} shots`,
    });
  }

  const payload = {
    version: 1 as const,
    jobId: composition.jobId,
    compositionHash:
      composition.compositionHash,
    framePlanHash: plan.planHash,
    shotCount:
      composition.shots.length,
    uniqueAssetCount,
    visualGroupCount,
    findings,
  };

  return VisualVarietyReportSchema.parse({
    ...payload,
    reportHash: sha256(payload),
  });
}
