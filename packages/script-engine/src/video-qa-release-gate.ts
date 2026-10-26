import { createHash } from "node:crypto";
import { z } from "zod";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import type {
  VideoQaFrameAnalysis,
} from "./video-qa-frame-analyzer.js";

import type {
  AudioQaReport,
} from "./video-qa-audio-analyzer.js";

import type {
  SubtitleQaReport,
} from "./video-qa-subtitle-analyzer.js";

import type {
  VisualVarietyReport,
  VisualVarietyPolicy,
} from "./video-qa-visual-variety.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

const QaDomainSchema = z.enum([
  "visual",
  "audio",
  "subtitles",
  "variety",
]);

import type {
  AudioQaOptions,
} from "./video-qa-audio-analyzer.js";

import type {
  SubtitleQaPolicy,
} from "./video-qa-subtitle-analyzer.js";

import type {
  VideoQaFrameThresholds,
} from "./video-qa-frame-analyzer.js";

export const UnifiedQaFindingSchema = z.object({
  domain: QaDomainSchema,
  code: z.string().min(1),
  severity: z.enum(["info", "warning", "error"]),
  blocking: z.boolean(),
  detail: z.string().min(1),
  reference: z.string().min(1),
}).strict();

export const UnifiedQaDomainScoreSchema = z.object({
  domain: QaDomainSchema,
  score: z.number().int().min(0).max(100),
  warnings: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
}).strict();

export const UnifiedVideoQaReportSchema = z.object({
  version: z.literal(1),
  policyId: z.string().min(1).optional(),

  jobId: z.string().min(1),
  compositionHash: Hash,
  videoSha256: Hash,

  decision: z.enum([
    "PASS",
    "REVIEW",
    "FAIL",
  ]),

  overallScore: z.number().int().min(0).max(100),
  domainScores: z.array(
    UnifiedQaDomainScoreSchema,
  ).length(4),

  blockingCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),

  findings: z.array(
    UnifiedQaFindingSchema,
  ),

  reportHash: Hash,
}).strict();

export type UnifiedVideoQaReport = z.infer<
  typeof UnifiedVideoQaReportSchema
>;

export type UnifiedQaFinding = z.infer<
  typeof UnifiedQaFindingSchema
>;

export type QaDomain = z.infer<
  typeof QaDomainSchema
>;

export interface VideoQaReleasePolicy {
  policyId?: string;
  warningPenalty?: number;
  errorPenalty?: number;

  /**
   * Optional findings which should be treated as
   * release-blocking even when reported as warnings.
   *
   * Entries use DOMAIN:CODE identifiers.
   */
  additionalBlockingCodes?: readonly string[];

  /**
   * These are never downgraded by caller policy.
   */
  minimumPassingScore?: number;

  audio?: AudioQaOptions;
  subtitles?: SubtitleQaPolicy;
  frames?: VideoQaFrameThresholds;
  variety?: VisualVarietyPolicy;
}

export const CALIBRATED_RELEASE_POLICY: VideoQaReleasePolicy = {
  policyId: "calibrated-v4",
  audio: {
    dropoutMs: 450,
    maxSentencePauseMs: 1500,
    maxClausePauseMs: 1000,
    maxLeadingSilenceMs: 1500,
    maxTrailingSilenceMs: 2500,
  },
  subtitles: {
    maxCharactersPerSecond: 38,
    allowPunctuationOnlyCues: true,
  },
  frames: {
    frozenMeanDifference: 0.10,
    minMotionFrameInterval: 15,
  },
  variety: {
    maximumAssetReuse: 3,
    nearDuplicateDistance: 3,
    minimumUniqueVisualRatio: 0.5,
    minimumShotsForVarietyCheck: 4,
  },
};

export interface CreateUnifiedVideoQaInput {
  composition: RemotionComposition;
  videoSha256: string;

  frames: VideoQaFrameAnalysis;
  audio: AudioQaReport;
  subtitles: SubtitleQaReport;
  variety: VisualVarietyReport;
}

const DOMAINS: readonly QaDomain[] = [
  "visual",
  "audio",
  "subtitles",
  "variety",
];

const DEFAULT_WARNING_PENALTY = 4;
const DEFAULT_ERROR_PENALTY = 20;

/**
 * Explicit blocking codes avoid relying solely
 * on producer-controlled severity strings.
 */
const MANDATORY_BLOCKING_CODES = new Set([
  "visual:BLACK_FRAME",
  "subtitles:SUBTITLE_OVERFLOW",
  "subtitles:SUBTITLE_SAFE_AREA",
  "subtitles:INVALID_WORD_TIMING",
]);

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function assertHash(
  actual: string,
  expected: string,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `M8 unified QA ${label} mismatch`,
    );
  }
}

function validatePolicy(
  policy: VideoQaReleasePolicy,
) {
  const warningPenalty =
    policy.warningPenalty ??
    DEFAULT_WARNING_PENALTY;

  const errorPenalty =
    policy.errorPenalty ??
    DEFAULT_ERROR_PENALTY;

  const minimumPassingScore =
    policy.minimumPassingScore ?? 70;

  for (const value of [
    warningPenalty,
    errorPenalty,
    minimumPassingScore,
  ]) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 100
    ) {
      throw new Error(
        "M8 invalid release gate policy",
      );
    }
  }

  const additional =
    policy.additionalBlockingCodes ?? [];

  if (
    additional.some(
      (value) =>
        typeof value !== "string" ||
        !/^(visual|audio|subtitles|variety):[A-Z_]+$/.test(
          value,
        ),
    )
  ) {
    throw new Error(
      "M8 invalid release gate policy",
    );
  }

  return {
    warningPenalty,
    errorPenalty,
    minimumPassingScore,
    blockingCodes: new Set([
      ...MANDATORY_BLOCKING_CODES,
      ...additional,
    ]),
  };
}

export function createUnifiedVideoQaReport(
  input: CreateUnifiedVideoQaInput,
  policy: VideoQaReleasePolicy = {},
): UnifiedVideoQaReport {
  const p = validatePolicy(policy);
  const composition = input.composition;

  if (
    !Hash.safeParse(
      composition.compositionHash,
    ).success ||
    !Hash.safeParse(
      input.videoSha256,
    ).success
  ) {
    throw new Error(
      "M8 unified QA invalid identity hash",
    );
  }

  assertHash(
    input.subtitles.compositionHash,
    composition.compositionHash,
    "subtitle composition",
  );

  assertHash(
    input.variety.compositionHash,
    composition.compositionHash,
    "variety composition",
  );

  if (
    input.subtitles.jobId !== composition.jobId ||
    input.variety.jobId !== composition.jobId
  ) {
    throw new Error(
      "M8 unified QA job identity mismatch",
    );
  }

  const findings: UnifiedQaFinding[] = [];

  const add = (
    domain: QaDomain,
    code: string,
    severity: "info" | "warning" | "error",
    detail: string,
    reference: string,
  ) => {
    const identity = `${domain}:${code}`;

    findings.push({
      domain,
      code,
      severity,
      blocking:
        severity === "error" ||
        p.blockingCodes.has(identity),
      detail,
      reference,
    });
  };

  for (const finding of input.frames.findings) {
    add(
      "visual",
      finding.code,
      finding.severity,
      finding.detail,
      `${finding.shotId}:${finding.frame}`,
    );
  }

  for (const finding of input.audio.findings) {
    add(
      "audio",
      finding.code,
      finding.severity,
      finding.detail,
      "audio",
    );
  }

  for (const finding of input.subtitles.findings) {
    add(
      "subtitles",
      finding.code,
      finding.severity,
      finding.detail,
      `cue:${finding.cueIndex}`,
    );
  }

  for (const finding of input.variety.findings) {
    add(
      "variety",
      finding.code,
      finding.severity,
      finding.detail,
      finding.shotIds.join(","),
    );
  }

  const domainScores = DOMAINS.map(
    (domain) => {
      const domainFindings = findings.filter(
        (finding) =>
          finding.domain === domain,
      );

      const warnings =
        domainFindings.filter(
          (finding) =>
            finding.severity === "warning",
        ).length;

      const errors =
        domainFindings.filter(
          (finding) =>
            finding.severity === "error",
        ).length;

      const score = Math.max(
        0,
        100 -
          warnings * p.warningPenalty -
          errors * p.errorPenalty,
      );

      return {
        domain,
        score,
        warnings,
        errors,
      };
    },
  );

  /**
   * Use the weakest domain score so high quality
   * elsewhere cannot hide poor performance.
   */
  const overallScore = Math.min(
    ...domainScores.map(
      (domain) => domain.score,
    ),
  );

  const blockingCount =
    findings.filter(
      (finding) => finding.blocking,
    ).length;

  const warningCount =
    findings.filter(
      (finding) =>
        finding.severity === "warning",
    ).length;

  let decision:
    "PASS" | "REVIEW" | "FAIL";

  if (blockingCount > 0) {
    decision = "FAIL";
  } else if (
    warningCount > 0 ||
    overallScore < p.minimumPassingScore
  ) {
    decision = "REVIEW";
  } else {
    decision = "PASS";
  }

  const payload = {
    version: 1 as const,
    ...(policy.policyId ? { policyId: policy.policyId } : {}),
    jobId: composition.jobId,
    compositionHash:
      composition.compositionHash,
    videoSha256:
      input.videoSha256,
    decision,
    overallScore,
    domainScores,
    blockingCount,
    warningCount,
    findings,
  };

  return UnifiedVideoQaReportSchema.parse({
    ...payload,
    reportHash: sha256(payload),
  });
}

export function verifyUnifiedVideoQaReport(
  candidate: unknown,
  input: CreateUnifiedVideoQaInput,
  policy: VideoQaReleasePolicy = {},
): UnifiedVideoQaReport {
  const saved =
    UnifiedVideoQaReportSchema.parse(
      candidate,
    );

  const rebuilt =
    createUnifiedVideoQaReport(
      input,
      policy,
    );

  if (
    JSON.stringify(saved) !==
    JSON.stringify(rebuilt)
  ) {
    throw new Error(
      "M8 unified QA canonical reconstruction mismatch",
    );
  }

  return saved;
}
