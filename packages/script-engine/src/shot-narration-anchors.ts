import { createHash } from "node:crypto";
import { z } from "zod";

import {
  NarrationWordAlignmentSchema,
  tokenizeNarration,
  type NarrationWordAlignment,
} from "./narration-alignment-contract.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ShotNarrationAnchorInputSchema = z.object({
  shotId: z.string().min(1),
  shotIndex: z.number().int().nonnegative(),

  startTokenIndex: z.number().int().nonnegative(),
  endTokenIndexExclusive: z.number().int().positive(),
}).strict();

export const CanonicalShotNarrationAnchorSchema =
  ShotNarrationAnchorInputSchema.extend({
    startSample: z.number().int().nonnegative(),
    endSampleExclusive: z.number().int().nonnegative(),

    firstToken: z.string().min(1),
    lastToken: z.string().min(1),
  }).strict();

export const ShotNarrationAnchorPackageSchema = z.object({
  version: z.literal(1),

  jobId: z.string().min(1),

  productionPackageHash: HashSchema,
  scriptHash: HashSchema,
  alignmentHash: HashSchema,
  audioSha256: HashSchema,

  sampleRate: z.number().int().positive(),
  sampleFrames: z.number().int().positive(),

  shotCount: z.number().int().positive(),
  tokenCount: z.number().int().positive(),

  anchors: z.array(
    CanonicalShotNarrationAnchorSchema,
  ).min(1),

  anchorPackageHash: HashSchema,
}).strict();

export type ShotNarrationAnchorInput = z.infer<
  typeof ShotNarrationAnchorInputSchema
>;

export type CanonicalShotNarrationAnchor = z.infer<
  typeof CanonicalShotNarrationAnchorSchema
>;

export type ShotNarrationAnchorPackage = z.infer<
  typeof ShotNarrationAnchorPackageSchema
>;

export interface CreateShotNarrationAnchorsInput {
  jobId: string;
  productionPackageHash: string;

  /**
   * Exact narration text submitted to Kokoro.
   */
  scriptText: string;

  alignment: NarrationWordAlignment;

  /**
   * Shots must be supplied in canonical M3 order.
   * These ranges must originate from verified
   * narration-to-storyboard attribution.
   */
  shots: ShotNarrationAnchorInput[];
}

function hash(input: string): string {
  return createHash("sha256")
    .update(input)
    .digest("hex");
}

function normalizeToken(token: string): string {
  return token.normalize("NFKC")
    .replace(/’/g, "'")
    .toLocaleLowerCase("en");
}

export function createShotNarrationAnchors(
  input: CreateShotNarrationAnchorsInput,
): ShotNarrationAnchorPackage {
  const alignment =
    NarrationWordAlignmentSchema.parse(
      input.alignment,
    );

  const productionPackageHash =
    HashSchema.parse(
      input.productionPackageHash,
    );

  if (
    !input.jobId.trim() ||
    alignment.jobId !== input.jobId
  ) {
    throw new Error(
      "Shot narration job identity mismatch",
    );
  }

  const scriptHash = hash(input.scriptText);

  if (alignment.scriptHash !== scriptHash) {
    throw new Error(
      "Shot narration script identity mismatch",
    );
  }

  const tokens = tokenizeNarration(
    input.scriptText,
  );

  if (
    tokens.length === 0 ||
    tokens.length !== alignment.words.length
  ) {
    throw new Error(
      "Shot narration token coverage mismatch",
    );
  }

  // Verify the supplied alignment still agrees
  // with the entire script, not just selected spans.
  for (let index = 0; index < tokens.length; index++) {
    const word = alignment.words[index];

    const wordIndex = word?.index ?? word?.tokenIndex;
    const wordText = word?.text ?? word?.word;

    if (
      !word ||
      wordIndex !== index ||
      normalizeToken(wordText) !==
        normalizeToken(tokens[index]!)
    ) {
      throw new Error(
        `Shot narration alignment mismatch at token ${index}`,
      );
    }

    if (
      word.startSample < 0 ||
      word.endSampleExclusive <
        word.startSample ||
      word.endSampleExclusive >
        alignment.sampleFrames
    ) {
      throw new Error(
        `Shot narration sample interval invalid at token ${index}`,
      );
    }
  }

  const parsedShots = z.array(
    ShotNarrationAnchorInputSchema,
  ).min(1).parse(input.shots);

  const seenShotIds = new Set<string>();

  let nextTokenIndex = 0;
  let previousSampleEnd = 0;

  const anchors = parsedShots.map((shot, index) => {
    if (
      shot.shotIndex !== index ||
      seenShotIds.has(shot.shotId)
    ) {
      throw new Error(
        "Shot narration IDs or ordering invalid",
      );
    }

    seenShotIds.add(shot.shotId);

    if (
      shot.startTokenIndex !== nextTokenIndex ||
      shot.endTokenIndexExclusive <=
        shot.startTokenIndex ||
      shot.endTokenIndexExclusive > tokens.length
    ) {
      throw new Error(
        `Shot narration token range invalid for ${shot.shotId}`,
      );
    }

    const first = alignment.words[
      shot.startTokenIndex
    ]!;

    const last = alignment.words[
      shot.endTokenIndexExclusive - 1
    ]!;

    if (
      first.startSample < previousSampleEnd ||
      last.endSampleExclusive <
        first.startSample
    ) {
      throw new Error(
        `Shot narration sample order invalid for ${shot.shotId}`,
      );
    }

    nextTokenIndex =
      shot.endTokenIndexExclusive;

    previousSampleEnd =
      last.endSampleExclusive;

    return CanonicalShotNarrationAnchorSchema.parse({
      ...shot,

      startSample: first.startSample,
      endSampleExclusive:
        last.endSampleExclusive,

      firstToken:
        tokens[shot.startTokenIndex],

      lastToken:
        tokens[
          shot.endTokenIndexExclusive - 1
        ],
    });
  });

  if (nextTokenIndex !== tokens.length) {
    throw new Error(
      "Shot narration leaves unassigned tokens",
    );
  }

  const payload = {
    version: 1 as const,

    jobId: input.jobId,
    productionPackageHash,
    scriptHash,

    alignmentHash:
      alignment.alignmentHash,

    audioSha256:
      alignment.audioSha256,

    sampleRate:
      alignment.sampleRate,

    sampleFrames:
      alignment.sampleFrames,

    shotCount: anchors.length,
    tokenCount: tokens.length,

    anchors,
  };

  return ShotNarrationAnchorPackageSchema.parse({
    ...payload,
    anchorPackageHash: hash(
      JSON.stringify(payload),
    ),
  });
}

/**
 * Recomputes all ranges and hashes from authoritative
 * inputs. A saved anchor package is never trusted
 * simply because it parses successfully.
 */
export function verifyShotNarrationAnchors(
  candidate: unknown,
  input: CreateShotNarrationAnchorsInput,
): ShotNarrationAnchorPackage {
  const saved =
    ShotNarrationAnchorPackageSchema.parse(
      candidate,
    );

  const rebuilt =
    createShotNarrationAnchors(input);

  if (
    JSON.stringify(saved) !==
    JSON.stringify(rebuilt)
  ) {
    throw new Error(
      "Shot narration anchor package mismatch",
    );
  }

  return saved;
}
