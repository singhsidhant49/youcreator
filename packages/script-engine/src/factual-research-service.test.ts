import { describe, expect, it } from "vitest";
import {
  FactualResearchRequiredError,
  FactualResearchService,
} from "./factual-research-service.js";
import { MockResearchProvider } from "./mock-research-provider.js";
import { BraveResearchProvider, BraveSearchQuotaExhaustedError } from "./brave-research-provider.js";

describe("FactualResearchService", () => {
  it("derives sensible search queries from video topic and instructions", () => {
    const mockProvider = new MockResearchProvider();
    const service = new FactualResearchService({ providers: [mockProvider] });

    const queries = service.deriveQueries(
      "Ancient Roman Aqueducts",
      "Focus on engineering and water transport",
    );

    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries[0]).toBe("Ancient Roman Aqueducts");
    expect(queries.some((q) => q.includes("historical") || q.includes("engineering"))).toBe(true);
  });

  it("retrieves deduplicated sources within configured budget", async () => {
    const mockProvider = new MockResearchProvider();
    mockProvider.setSourcesForQuery("roman aqueducts", [
      {
        id: "source-1",
        url: "https://example.com/aqueducts",
        title: "Roman Aqueducts",
        snippet: "Built by Roman engineers to bring water into cities.",
        sourceDomain: "example.com",
        retrievedAt: new Date().toISOString(),
        credibilityScore: 0.9,
        provenance: "mock",
      },
    ]);

    const service = new FactualResearchService({
      providers: [mockProvider],
      defaultPolicy: { maxSources: 5 },
    });

    const report = await service.conductResearch("Roman Aqueducts", {
      narrationText: "Roman engineers constructed stone aqueducts to transport fresh water.",
    });

    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.title).toBe("Roman Aqueducts");
    expect(report.overallFactualityScore).toBeGreaterThanOrEqual(80);
    expect(report.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("throws FactualResearchRequiredError when mode is required and provider fails", async () => {
    const failingProvider = {
      id: "failing",
      provenance: "mock" as const,
      search: async () => {
        throw new Error("Network unreachable");
      },
    };

    const service = new FactualResearchService({
      providers: [failingProvider],
      defaultPolicy: { mode: "required" },
    });

    await expect(
      service.conductResearch("Quantum Computing"),
    ).rejects.toThrow(FactualResearchRequiredError);
  });

  it("returns an unverified report when mode is optional and provider fails", async () => {
    const failingProvider = {
      id: "failing",
      provenance: "mock" as const,
      search: async () => {
        throw new Error("402 Payment Required");
      },
    };

    const service = new FactualResearchService({
      providers: [failingProvider],
      defaultPolicy: { mode: "optional" },
    });

    const report = await service.conductResearch("Quantum Computing");
    expect(report.sources).toHaveLength(0);
    expect(report.overallFactualityScore).toBe(0);
  });

  it("handles BraveSearchQuotaExhaustedError properly", async () => {
    const mockFetch = async () => ({
      status: 402,
      ok: false,
      json: async () => ({ error: "Credit exhausted" }),
    });

    const braveProvider = new BraveResearchProvider({
      apiKey: "test-exhausted-key",
      fetchFn: mockFetch as any,
    });

    await expect(braveProvider.search("James Webb")).rejects.toThrow(
      BraveSearchQuotaExhaustedError,
    );
  });
});
