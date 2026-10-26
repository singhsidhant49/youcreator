import { createHash } from "node:crypto";
import type { ResearchSource } from "@youcreator/contracts";
import type {
  FactualResearchProvider,
  ResearchSearchOptions,
  ResearchSearchResult,
} from "./factual-research-provider.js";
import { sanitizeUntrustedContent } from "./untrusted-content-sanitizer.js";

interface DuckDuckGoApiResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  RelatedTopics?: Array<{
    Text?: string;
    FirstURL?: string;
  }>;
}

export class DuckDuckGoResearchProvider implements FactualResearchProvider {
  readonly id = "duckduckgo";
  readonly provenance = "duckduckgo" as const;

  constructor(
    private readonly options: {
      timeoutMs?: number;
      fetchFn?: typeof fetch;
    } = {},
  ) {}

  async search(
    query: string,
    options: ResearchSearchOptions = {},
  ): Promise<ResearchSearchResult> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 15000;
    const maxResults = options.maxResults ?? 3;
    const cleanQuery = query.trim();

    if (!cleanQuery) {
      return {
        providerId: this.id,
        provenance: this.provenance,
        query,
        sources: [],
        retrievedAt: new Date().toISOString(),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
        cleanQuery,
      )}&format=json&no_html=1&skip_disambig=1`;

      const res = await fetchFn(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "YouCreator-FactualResearch/1.0",
        },
      });

      if (!res.ok) {
        throw new Error(`DuckDuckGo API failed with HTTP ${res.status}`);
      }

      const data = (await res.json()) as DuckDuckGoApiResponse;
      const sources: ResearchSource[] = [];

      // 1. Primary abstract if present
      if (data.AbstractText && data.AbstractURL) {
        const domain = new URL(data.AbstractURL).hostname;
        const sourceId = `ddg-${createHash("sha256")
          .update(data.AbstractURL)
          .digest("hex")
          .slice(0, 12)}`;

        sources.push({
          id: sourceId,
          url: data.AbstractURL,
          title: data.Heading || cleanQuery,
          snippet: sanitizeUntrustedContent(data.AbstractText, { maxLength: 800 }),
          sourceDomain: domain,
          retrievedAt: new Date().toISOString(),
          credibilityScore: 0.85,
          provenance: "duckduckgo",
        });
      }

      // 2. Related topics
      if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics) {
          if (sources.length >= maxResults) break;
          if (topic.Text && topic.FirstURL) {
            try {
              const domain = new URL(topic.FirstURL).hostname;
              const sourceId = `ddg-${createHash("sha256")
                .update(topic.FirstURL)
                .digest("hex")
                .slice(0, 12)}`;

              sources.push({
                id: sourceId,
                url: topic.FirstURL,
                title: topic.Text.slice(0, 80),
                snippet: sanitizeUntrustedContent(topic.Text, { maxLength: 600 }),
                sourceDomain: domain,
                retrievedAt: new Date().toISOString(),
                credibilityScore: 0.80,
                provenance: "duckduckgo",
              });
            } catch {
              // skip invalid URLs
            }
          }
        }
      }

      return {
        providerId: this.id,
        provenance: this.provenance,
        query: cleanQuery,
        sources,
        retrievedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
