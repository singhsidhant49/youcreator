import { createHash } from "node:crypto";
import type {
  ClaimRecord,
  ClaimType,
  ResearchSource,
} from "@youcreator/contracts";

export interface ClaimVerificationOptions {
  requireStrictCorroboration?: boolean;
}

export interface ClaimVerificationResult {
  claims: ClaimRecord[];
  verifiedCount: number;
  unsupportedCount: number;
  disputedCount: number;
  overallFactualityScore: number;
}

/**
 * Classifies a sentence or assertion into a factual ClaimType.
 */
export function classifyClaimType(sentence: string): ClaimType {
  const lower = sentence.toLowerCase();

  // Numerical: contains numbers, percentages, dates, measurements
  if (
    /\b\d+(\.\d+)?\b/.test(sentence) ||
    /\b(percent|million|billion|trillion|meters|kilometers|miles|degrees|celsius|fahrenheit|kg|lbs|dollars|seconds|minutes|hours|days|years)\b/i.test(
      sentence,
    )
  ) {
    return "numerical";
  }

  // Scientific: scientific terms, astronomy, physics, biology, chemistry
  if (
    /\b(telescope|orbit|planet|star|galaxy|atom|molecule|dna|rna|gravity|quantum|frequency|infrared|spectrum|wavelength|photon|energy|evolution|organism|bioluminescent|photosynthesis)\b/i.test(
      lower,
    )
  ) {
    return "scientific";
  }

  // Historical: dates, eras, ancient, dynasties, wars, centuries
  if (
    /\b(century|bc|bce|ad|ce|ancient|empire|emperor|roman|greek|medieval|renaissance|revolution|discovered|invented|founded|war|battle|dynasty|treaty)\b/i.test(
      lower,
    )
  ) {
    return "historical";
  }

  // Current event: recently, announced, launched, report, latest, update
  if (
    /\b(recently|announced|current|latest|update|launched|mission|status|official|reported|published)\b/i.test(
      lower,
    )
  ) {
    return "current_event";
  }

  return "general";
}

/**
 * Normalizes text for keyword and entity matching.
 */
function extractSignificantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  "this", "that", "these", "those", "with", "from", "have", "were", "been",
  "some", "such", "than", "then", "into", "over", "also", "their", "there",
  "which", "would", "could", "should", "about", "after", "other",
]);

/**
 * Verifies a single claim against a collection of retrieved research sources.
 */
export function verifyClaimAgainstSources(
  claimText: string,
  claimType: ClaimType,
  sources: ResearchSource[],
): ClaimRecord {
  const claimId = `claim-${createHash("sha256")
    .update(claimText)
    .digest("hex")
    .slice(0, 10)}`;

  if (sources.length === 0) {
    return {
      id: claimId,
      claimText,
      claimType,
      supportingSourceIds: [],
      confidence: 0,
      contradictions: [],
      status: "unsupported",
      remediation: "No research sources available to corroborate this claim.",
    };
  }

  const claimTokens = extractSignificantTokens(claimText);
  // Numbers in the claim must specifically match if claim is numerical
  const claimNumbers = (claimText.match(/\b\d+(\.\d+)?\b/g) || []);

  const supportingSourceIds: string[] = [];
  let bestSnippet: string | undefined;
  let maxScore = 0;

  for (const source of sources) {
    const sourceTokens = new Set(
      extractSignificantTokens(`${source.title} ${source.snippet}`),
    );

    let matchCount = 0;
    for (const token of claimTokens) {
      if (sourceTokens.has(token)) {
        matchCount++;
      }
    }

    const tokenOverlap = claimTokens.length > 0 ? matchCount / claimTokens.length : 0;

    // Check numerical match if numbers present
    let numberMatch = true;
    if (claimNumbers.length > 0) {
      const sourceSnippet = `${source.title} ${source.snippet}`;
      numberMatch = claimNumbers.some((n) => sourceSnippet.includes(n));
    }

    if (tokenOverlap >= 0.35 && numberMatch) {
      supportingSourceIds.push(source.id);
      if (tokenOverlap > maxScore) {
        maxScore = tokenOverlap;
        bestSnippet = source.snippet;
      }
    }
  }

  if (supportingSourceIds.length > 0) {
    return {
      id: claimId,
      claimText,
      claimType,
      supportingSourceIds,
      evidenceSnippet: bestSnippet,
      confidence: Math.min(1.0, Math.round(maxScore * 100) / 100),
      contradictions: [],
      status: "verified",
    };
  }

  return {
    id: claimId,
    claimText,
    claimType,
    supportingSourceIds: [],
    confidence: 0.1,
    contradictions: [],
    status: "unsupported",
    remediation: `Claim '${claimText.slice(0, 60)}...' is unsupported by retrieved sources. Revise with verified facts or cite primary reference.`,
  };
}

/**
 * Extracts factual sentences from narration text and verifies them against research sources.
 */
export function extractAndVerifyClaims(
  narrationText: string,
  sources: ResearchSource[],
  options: ClaimVerificationOptions = {},
): ClaimVerificationResult {
  // Split into sentences
  const rawSentences = narrationText
    .split(/(?<=[.?!])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);

  const claims: ClaimRecord[] = [];

  for (const sentence of rawSentences) {
    const claimType = classifyClaimType(sentence);
    // Focus verification on numerical, historical, scientific, or current event claims
    const claimRecord = verifyClaimAgainstSources(sentence, claimType, sources);
    claims.push(claimRecord);
  }

  let verifiedCount = 0;
  let unsupportedCount = 0;
  let disputedCount = 0;

  for (const claim of claims) {
    if (claim.status === "verified") {
      verifiedCount++;
    } else if (claim.status === "disputed") {
      disputedCount++;
    } else {
      unsupportedCount++;
    }
  }

  const overallFactualityScore =
    claims.length === 0
      ? 100
      : Math.round((verifiedCount / claims.length) * 100);

  return {
    claims,
    verifiedCount,
    unsupportedCount,
    disputedCount,
    overallFactualityScore,
  };
}
