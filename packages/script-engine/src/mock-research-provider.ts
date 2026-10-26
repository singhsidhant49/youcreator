import { createHash } from "node:crypto";
import type { ResearchSource } from "@youcreator/contracts";
import type {
  FactualResearchProvider,
  ResearchSearchOptions,
  ResearchSearchResult,
} from "./factual-research-provider.js";

export class MockResearchProvider implements FactualResearchProvider {
  readonly id = "mock";
  readonly provenance = "mock" as const;

  private readonly sourceBank: Map<string, ResearchSource[]> = new Map();

  constructor(initialSources?: Record<string, ResearchSource[]>) {
    if (initialSources) {
      for (const [query, sources] of Object.entries(initialSources)) {
        this.sourceBank.set(query.toLowerCase(), sources);
      }
    }
  }

  setSourcesForQuery(query: string, sources: ResearchSource[]): void {
    this.sourceBank.set(query.toLowerCase(), sources);
  }

  async search(
    query: string,
    options: ResearchSearchOptions = {},
  ): Promise<ResearchSearchResult> {
    const cleanQuery = query.trim().toLowerCase();
    const maxResults = options.maxResults ?? 5;

    // Exact match or partial match
    let matchedSources = this.sourceBank.get(cleanQuery);

    if (!matchedSources) {
      for (const [key, sources] of this.sourceBank.entries()) {
        if (cleanQuery.includes(key) || key.includes(cleanQuery)) {
          matchedSources = sources;
          break;
        }
      }
    }

    if (!matchedSources) {
      // Generate standard fallback mock source
      const hash = createHash("sha256").update(query).digest("hex").slice(0, 8);
      matchedSources = [
        {
          id: `mock-${hash}`,
          url: `https://example.com/research/${encodeURIComponent(query)}`,
          title: `Verified Reference for ${query}`,
          snippet: `Empirical research documentation regarding ${query}. All historical and scientific data verified through primary records.`,
          sourceDomain: "example.com",
          publishedDate: "2024-01-15T00:00:00Z",
          retrievedAt: new Date().toISOString(),
          credibilityScore: 0.90,
          provenance: "mock",
        },
      ];
    }

    return {
      providerId: this.id,
      provenance: this.provenance,
      query,
      sources: matchedSources.slice(0, maxResults),
      retrievedAt: new Date().toISOString(),
    };
  }
}
