import { createHash } from "node:crypto";
import {
  FactualResearchReportSchema,
  ResearchPolicySchema,
  type FactualResearchReport,
  type ResearchPolicy,
  type ResearchSource,
} from "@youcreator/contracts";

import type { FactualResearchProvider } from "./factual-research-provider.js";
import { extractAndVerifyClaims } from "./claim-verifier.js";

export class FactualResearchRequiredError extends Error {
  constructor(topic: string, reason: string) {
    super(`Factual research required for topic '${topic}' but retrieval failed: ${reason}`);
    this.name = "FactualResearchRequiredError";
  }
}

export interface FactualResearchServiceOptions {
  providers: FactualResearchProvider[];
  defaultPolicy?: Partial<ResearchPolicy>;
}

export class FactualResearchService {
  private readonly providers: FactualResearchProvider[];
  private readonly defaultPolicy: ResearchPolicy;

  constructor(options: FactualResearchServiceOptions) {
    if (!options.providers || options.providers.length === 0) {
      throw new Error("At least one FactualResearchProvider must be configured");
    }
    this.providers = options.providers;
    this.defaultPolicy = ResearchPolicySchema.parse(options.defaultPolicy ?? {});
  }

  /**
   * Derives focused factual search queries from a video topic and brief.
   */
  deriveQueries(topic: string, instructions?: string): string[] {
    const cleanTopic = topic.trim();
    const queries = [cleanTopic];

    // Add domain-specific query variants
    if (/\b(history|ancient|war|empire|dynasty|invention|revolution)\b/i.test(cleanTopic)) {
      queries.push(`${cleanTopic} historical timeline origins`);
    } else if (/\b(science|telescope|space|physics|biology|quantum|cell|dna)\b/i.test(cleanTopic)) {
      queries.push(`${cleanTopic} scientific mechanism discovery`);
    } else if (/\b(business|company|market|economy|industry|startup)\b/i.test(cleanTopic)) {
      queries.push(`${cleanTopic} business history milestones financial`);
    } else {
      queries.push(`${cleanTopic} overview key facts`);
    }

    if (instructions && instructions.length > 5) {
      const keywords = instructions
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 4)
        .slice(0, 3)
        .join(" ");
      if (keywords) {
        queries.push(`${cleanTopic} ${keywords}`);
      }
    }

    return Array.from(new Set(queries));
  }

  /**
   * Conducts factual research for a video topic across configured providers.
   */
  async conductResearch(
    topic: string,
    options: {
      instructions?: string;
      policy?: Partial<ResearchPolicy>;
      narrationText?: string;
    } = {},
  ): Promise<FactualResearchReport> {
    const policy = ResearchPolicySchema.parse({
      ...this.defaultPolicy,
      ...options.policy,
    });

    if (policy.mode === "disabled") {
      const now = new Date().toISOString();
      const emptyFingerprint = createHash("sha256")
        .update(JSON.stringify({ topic, disabled: true, at: now }))
        .digest("hex");

      return FactualResearchReportSchema.parse({
        version: 1,
        topic,
        queriesExecuted: [],
        sources: [],
        claims: [],
        overallFactualityScore: 100,
        verifiedClaimsCount: 0,
        unsupportedClaimsCount: 0,
        disputedClaimsCount: 0,
        generatedAt: now,
        fingerprint: emptyFingerprint,
      });
    }

    const queries = this.deriveQueries(topic, options.instructions).slice(
      0,
      policy.maxQueries,
    );

    const aggregatedSources: ResearchSource[] = [];
    const seenUrls = new Set<string>();
    const executedQueries: string[] = [];

    let providerFailureReason: string | undefined;

    for (const query of queries) {
      for (const provider of this.providers) {
        if (aggregatedSources.length >= policy.maxSources) {
          break;
        }

        try {
          const result = await provider.search(query, {
            maxResults: Math.min(3, policy.maxSources - aggregatedSources.length),
          });
          executedQueries.push(query);

          for (const source of result.sources) {
            const normalizedUrl = source.url.toLowerCase().split("#")[0]!;
            if (!seenUrls.has(normalizedUrl) && source.credibilityScore >= policy.minCredibility) {
              seenUrls.add(normalizedUrl);
              aggregatedSources.push(source);
            }
          }
        } catch (err) {
          providerFailureReason = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // Handle complete research failure
    if (aggregatedSources.length === 0) {
      if (policy.mode === "required") {
        throw new FactualResearchRequiredError(
          topic,
          providerFailureReason ?? "No sources found meeting credibility criteria",
        );
      }
    }

    // Verify claims if narration text is supplied
    const verification = options.narrationText
      ? extractAndVerifyClaims(options.narrationText, aggregatedSources)
      : {
          claims: [],
          verifiedCount: 0,
          unsupportedCount: 0,
          disputedCount: 0,
          overallFactualityScore: aggregatedSources.length > 0 ? 100 : 0,
        };

    const generatedAt = new Date().toISOString();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          topic,
          sources: aggregatedSources.map((s) => s.id).sort(),
          executedQueries,
        }),
      )
      .digest("hex");

    return FactualResearchReportSchema.parse({
      version: 1,
      topic,
      queriesExecuted: executedQueries,
      sources: aggregatedSources,
      claims: verification.claims,
      overallFactualityScore: verification.overallFactualityScore,
      verifiedClaimsCount: verification.verifiedCount,
      unsupportedClaimsCount: verification.unsupportedCount,
      disputedClaimsCount: verification.disputedCount,
      generatedAt,
      fingerprint,
    });
  }
}
