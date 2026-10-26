import { describe, expect, it } from "vitest";
import {
  ClaimRecordSchema,
  FactualResearchReportSchema,
  ResearchPolicySchema,
  ResearchSourceSchema,
} from "./research.js";

describe("Research Contracts", () => {
  it("validates a complete ResearchSource", () => {
    const source = {
      id: "source-1",
      url: "https://en.wikipedia.org/wiki/James_Webb_Space_Telescope",
      title: "James Webb Space Telescope",
      snippet: "The James Webb Space Telescope is a space telescope designed for infrared astronomy.",
      sourceDomain: "wikipedia.org",
      publishedDate: "2024-01-01",
      retrievedAt: new Date().toISOString(),
      credibilityScore: 0.95,
      provenance: "wikipedia" as const,
    };

    const parsed = ResearchSourceSchema.parse(source);
    expect(parsed.id).toBe("source-1");
    expect(parsed.provenance).toBe("wikipedia");
  });

  it("validates ClaimRecord with verification status", () => {
    const claim = {
      id: "claim-1",
      claimText: "JWST primary mirror diameter is 6.5 meters.",
      claimType: "numerical" as const,
      supportingSourceIds: ["source-1"],
      evidenceSnippet: "It features a 6.5-meter-diameter gold-coated beryllium primary mirror.",
      confidence: 0.98,
      contradictions: [],
      status: "verified" as const,
    };

    const parsed = ClaimRecordSchema.parse(claim);
    expect(parsed.status).toBe("verified");
    expect(parsed.claimType).toBe("numerical");
  });

  it("validates default ResearchPolicy", () => {
    const policy = ResearchPolicySchema.parse({});
    expect(policy.mode).toBe("optional");
    expect(policy.maxQueries).toBe(4);
    expect(policy.maxSources).toBe(8);
    expect(policy.requireVerificationFor).toContain("numerical");
    expect(policy.requireVerificationFor).toContain("scientific");
  });

  it("validates FactualResearchReportSchema", () => {
    const report = {
      version: 1 as const,
      topic: "James Webb Space Telescope",
      queriesExecuted: ["James Webb Space Telescope specifications"],
      sources: [
        {
          id: "s1",
          url: "https://wikipedia.org/wiki/JWST",
          title: "JWST",
          snippet: "Space telescope",
          sourceDomain: "wikipedia.org",
          retrievedAt: new Date().toISOString(),
          credibilityScore: 0.9,
          provenance: "wikipedia" as const,
        },
      ],
      claims: [
        {
          id: "c1",
          claimText: "JWST launched on December 25, 2021",
          claimType: "historical" as const,
          supportingSourceIds: ["s1"],
          confidence: 0.99,
          contradictions: [],
          status: "verified" as const,
        },
      ],
      overallFactualityScore: 100,
      verifiedClaimsCount: 1,
      unsupportedClaimsCount: 0,
      disputedClaimsCount: 0,
      generatedAt: new Date().toISOString(),
      fingerprint: "a".repeat(64),
    };

    const parsed = FactualResearchReportSchema.parse(report);
    expect(parsed.overallFactualityScore).toBe(100);
  });
});
