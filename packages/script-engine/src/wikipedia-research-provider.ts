import { createHash } from "node:crypto";
import type { ResearchSource } from "@youcreator/contracts";
import type {
  FactualResearchProvider,
  ResearchSearchOptions,
  ResearchSearchResult,
} from "./factual-research-provider.js";
import { sanitizeUntrustedContent } from "./untrusted-content-sanitizer.js";

interface WikipediaSearchResponse {
  pages?: Array<{
    id: number;
    key: string;
    title: string;
    excerpt?: string;
    description?: string;
    matched_title?: string;
  }>;
}

export class WikipediaResearchProvider implements FactualResearchProvider {
  readonly id = "wikipedia";
  readonly provenance = "wikipedia" as const;

  constructor(
    private readonly options: {
      baseUrl?: string;
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
    const maxResults = Math.min(options.maxResults ?? 3, 5);
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
      // 1. Search Wikipedia pages via standard public REST API
      const searchUrl = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(
        cleanQuery,
      )}&limit=${maxResults}`;

      const res = await fetchFn(searchUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "YouCreator-FactualResearch/1.0 (educational-video-engine)",
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        throw new Error(`Wikipedia search failed with HTTP ${res.status}`);
      }

      const data = (await res.json()) as WikipediaSearchResponse;
      const pages = data.pages ?? [];

      const sources: ResearchSource[] = [];

      for (const page of pages.slice(0, maxResults)) {
        // Fetch detailed summary for the page if available
        let snippet = page.description ?? "";
        let publishedDate: string | undefined;

        try {
          const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
            page.key,
          )}`;
          const summaryRes = await fetchFn(summaryUrl, {
            signal: controller.signal,
            headers: {
              "User-Agent": "YouCreator-FactualResearch/1.0",
              Accept: "application/json",
            },
          });

          if (summaryRes.ok) {
            const summaryData = (await summaryRes.json()) as {
              extract?: string;
              timestamp?: string;
            };
            if (summaryData.extract) {
              snippet = summaryData.extract;
            }
            if (summaryData.timestamp) {
              publishedDate = summaryData.timestamp;
            }
          }
        } catch {
          // If summary fails, use page snippet or description
          if (page.excerpt) {
            snippet = page.excerpt.replace(/<[^>]*>/g, "");
          }
        }

        const sanitizedSnippet = sanitizeUntrustedContent(snippet, { maxLength: 800 });
        if (!sanitizedSnippet) {
          continue;
        }

        const sourceId = `wiki-${createHash("sha256")
          .update(page.key)
          .digest("hex")
          .slice(0, 12)}`;

        sources.push({
          id: sourceId,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`,
          title: page.title,
          snippet: sanitizedSnippet,
          sourceDomain: "wikipedia.org",
          publishedDate,
          retrievedAt: new Date().toISOString(),
          credibilityScore: 0.95,
          provenance: "wikipedia",
        });
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
