import { createHash } from "node:crypto";
import type { ResearchSource } from "@youcreator/contracts";
import type {
  FactualResearchProvider,
  ResearchSearchOptions,
  ResearchSearchResult,
} from "./factual-research-provider.js";
import { sanitizeUntrustedContent } from "./untrusted-content-sanitizer.js";

export class BraveSearchQuotaExhaustedError extends Error {
  constructor(message: string = "Brave Search API credit balance is exhausted") {
    super(message);
    this.name = "BraveSearchQuotaExhaustedError";
  }
}

interface BraveWebSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      page_age?: string;
      extra_snippets?: string[];
    }>;
  };
}

export class BraveResearchProvider implements FactualResearchProvider {
  readonly id = "brave";
  readonly provenance = "brave" as const;

  constructor(
    private readonly options: {
      apiKey: string;
      timeoutMs?: number;
      fetchFn?: typeof fetch;
    },
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

    if (!this.options.apiKey?.trim()) {
      throw new Error("Brave API key is not configured");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
        cleanQuery,
      )}&count=${maxResults}`;

      const res = await fetchFn(url, {
        signal: controller.signal,
        headers: {
          "X-Subscription-Token": this.options.apiKey,
          Accept: "application/json",
        },
      });

      if (res.status === 402) {
        throw new BraveSearchQuotaExhaustedError();
      }

      if (!res.ok) {
        throw new Error(`Brave Search failed with HTTP ${res.status}`);
      }

      const data = (await res.json()) as BraveWebSearchResponse;
      const results = data.web?.results ?? [];
      const sources: ResearchSource[] = [];

      for (const item of results) {
        if (!item.url || !item.title) continue;

        let snippet = item.description ?? "";
        if (item.extra_snippets && item.extra_snippets.length > 0) {
          snippet += " " + item.extra_snippets.join(" ");
        }

        const domain = new URL(item.url).hostname;
        const sourceId = `brave-${createHash("sha256")
          .update(item.url)
          .digest("hex")
          .slice(0, 12)}`;

        sources.push({
          id: sourceId,
          url: item.url,
          title: item.title,
          snippet: sanitizeUntrustedContent(snippet, { maxLength: 800 }),
          sourceDomain: domain,
          publishedDate: item.page_age,
          retrievedAt: new Date().toISOString(),
          credibilityScore: 0.85,
          provenance: "brave",
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
