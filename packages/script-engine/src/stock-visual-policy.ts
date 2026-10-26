import { z } from "zod";

/**
 * Configuration policy for Mode A (Intelligent Stock & Web).
 * Controls retrieval effort, search depth, and semantic quality thresholds.
 */
export const StockVisualPolicySchema = z.object({
  searchDepth: z.enum(["fast", "balanced", "strict"]).default("balanced"),
  minimumSemanticScore: z.number().min(0).max(100).default(80),
  maxSearchAttempts: z.number().int().min(1).max(10).default(3),
  allowLocalImageBank: z.boolean().default(true),
  allowStockProviders: z.boolean().default(true),
  allowPermittedWebSources: z.boolean().default(true),
}).strict();

export type StockVisualPolicy = z.infer<typeof StockVisualPolicySchema>;

/**
 * Predefined policy presets for Mode A.
 */
export const STOCK_VISUAL_POLICIES: Record<
  "fast" | "balanced" | "strict",
  StockVisualPolicy
> = {
  fast: {
    searchDepth: "fast",
    minimumSemanticScore: 70,
    maxSearchAttempts: 1,
    allowLocalImageBank: true,
    allowStockProviders: true,
    allowPermittedWebSources: true,
  },
  balanced: {
    searchDepth: "balanced",
    minimumSemanticScore: 80,
    maxSearchAttempts: 3,
    allowLocalImageBank: true,
    allowStockProviders: true,
    allowPermittedWebSources: true,
  },
  strict: {
    searchDepth: "strict",
    minimumSemanticScore: 88,
    maxSearchAttempts: 4,
    allowLocalImageBank: true,
    allowStockProviders: true,
    allowPermittedWebSources: true,
  },
};

/**
 * Default Mode A policy is 'balanced'.
 */
export const DEFAULT_STOCK_VISUAL_POLICY: StockVisualPolicy =
  STOCK_VISUAL_POLICIES.balanced;

/**
 * Stopwords to remove when refining search queries.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "of", "for", "with", "by", "from",
  "and", "or", "to", "is", "are", "was", "were", "be", "been", "being",
  "showing", "various", "detailed", "close-up", "view", "image", "photo",
  "photograph", "visual", "shot", "footage", "clip", "depicting", "features",
]);

/**
 * Adaptive query refinement utility for Mode A stock retrieval.
 * Escalates from primary queries to targeted subject concepts and broader core nouns.
 */
export function refineSearchQueries(
  originalQueries: readonly string[],
  description: string,
  negativeTerms: readonly string[] = [],
  attempt = 1,
): string[] {
  const normalizedNegatives = new Set(
    negativeTerms.map((t) => t.trim().toLowerCase()),
  );

  const cleanQuery = (query: string): string => {
    return query
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !normalizedNegatives.has(w))
      .join(" ")
      .trim();
  };

  const results: string[] = [];
  const seen = new Set<string>();

  const add = (q: string) => {
    const cleaned = cleanQuery(q);
    if (cleaned.length >= 3 && !seen.has(cleaned)) {
      seen.add(cleaned);
      results.push(cleaned);
    }
  };

  if (attempt === 1) {
    for (const q of originalQueries) {
      add(q);
    }
    if (results.length === 0) {
      add(description);
    }
    return results;
  }

  if (attempt === 2) {
    // Attempt 2: Extract key phrases from description
    const words = description
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !normalizedNegatives.has(w));

    // Combine 2-word bigrams from description
    for (let i = 0; i < words.length - 1 && results.length < 4; i++) {
      add(`${words[i]} ${words[i + 1]}`);
    }

    if (results.length === 0) {
      for (const w of words) {
        add(w);
      }
    }
    return results;
  }

  // Attempt 3+: Broader subject nouns
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w) && !normalizedNegatives.has(w));

  for (const w of words) {
    add(w);
  }

  for (const q of originalQueries) {
    const singleWords = q.split(/\s+/).filter((w) => w.length > 3 && !STOP_WORDS.has(w));
    for (const sw of singleWords) {
      add(sw);
    }
  }

  return results.slice(0, 5);
}
