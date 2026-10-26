import type {
  ResearchProvenance,
  ResearchSource,
} from "@youcreator/contracts";

export interface ResearchSearchOptions {
  maxResults?: number;
  timeoutMs?: number;
}

export interface ResearchSearchResult {
  providerId: string;
  provenance: ResearchProvenance;
  query: string;
  sources: ResearchSource[];
  retrievedAt: string;
}

export interface FactualResearchProvider {
  readonly id: string;
  readonly provenance: ResearchProvenance;

  search(
    query: string,
    options?: ResearchSearchOptions,
  ): Promise<ResearchSearchResult>;
}
