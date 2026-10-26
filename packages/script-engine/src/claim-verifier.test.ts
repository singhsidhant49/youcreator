import { describe, expect, it } from "vitest";
import {
  classifyClaimType,
  extractAndVerifyClaims,
  verifyClaimAgainstSources,
} from "./claim-verifier.js";
import type { ResearchSource } from "@youcreator/contracts";

describe("ClaimVerifier", () => {
  const sources: ResearchSource[] = [
    {
      id: "source-1",
      url: "https://en.wikipedia.org/wiki/James_Webb_Space_Telescope",
      title: "James Webb Space Telescope",
      snippet:
        "The James Webb Space Telescope was launched on December 25, 2021. It features a 6.5-meter-diameter primary mirror composed of 18 hexagonal beryllium segments.",
      sourceDomain: "wikipedia.org",
      retrievedAt: new Date().toISOString(),
      credibilityScore: 0.95,
      provenance: "wikipedia",
    },
  ];

  it("classifies claim types correctly", () => {
    expect(
      classifyClaimType("The primary mirror diameter is 6.5 meters."),
    ).toBe("numerical");
    expect(
      classifyClaimType("Light waves redshift into the infrared spectrum."),
    ).toBe("scientific");
    expect(
      classifyClaimType("The Roman Empire expanded across ancient Europe."),
    ).toBe("historical");
    expect(
      classifyClaimType("NASA recently announced the latest deep field mission update."),
    ).toBe("current_event");
    expect(
      classifyClaimType("Looking up at the night sky reveals wonder."),
    ).toBe("general");
  });

  it("verifies corroborated factual claims", () => {
    const claim = "The primary mirror measures 6.5 meters across 18 hexagonal segments.";
    const record = verifyClaimAgainstSources(claim, "numerical", sources);

    expect(record.status).toBe("verified");
    expect(record.supportingSourceIds).toContain("source-1");
    expect(record.confidence).toBeGreaterThan(0.5);
  });

  it("marks claims with mismatched facts or missing sources as unsupported", () => {
    const claim = "The telescope was launched in 1994 from Antarctica.";
    const record = verifyClaimAgainstSources(claim, "numerical", sources);

    // Number 1994 does not match snippet 2021
    expect(record.status).toBe("unsupported");
    expect(record.supportingSourceIds).toHaveLength(0);
  });

  it("extracts and evaluates multiple claims across a full narration text", () => {
    const narration =
      "The James Webb Space Telescope launched on December 25, 2021. " +
      "It features a 6.5-meter primary mirror for infrared astronomy. " +
      "It was built by ancient Roman engineers in the first century.";

    const result = extractAndVerifyClaims(narration, sources);

    expect(result.claims).toHaveLength(3);
    expect(result.verifiedCount).toBe(2);
    expect(result.unsupportedCount).toBe(1);
    expect(result.overallFactualityScore).toBe(67);
  });
});
