# YouCreator Script Factuality & Evidence Verification Policy

**Status:** APPROVED & ENFORCED (M10.8)  
**Version:** 1.0.0  
**Authority:** AI Video Generation Architecture & Editorial Standards  

---

## 1. Principles & Objectives

YouCreator generates automated, broadcast-ready videos for educational, documentary, scientific, and commercial use. Because synthetic media carries high risks of plausible hallucinations, fabricated statistics, and invented citations, this policy establishes mandatory factual grounding and claim verification across every stage of the script and visual pipeline.

### Core Tenets

1. **Traceable Grounding**: Every factual assertion regarding history, science, business, or current events must be anchored in retrieved, verifiable evidence records.
2. **Zero Fabricated Citations**: The system must never invent source URLs, authors, institutional affiliations, or academic citations.
3. **Untrusted Data Boundary**: All external web data, Wikipedia extracts, and search engine snippets are treated as **untrusted user data**. The pipeline strictly sanitizes retrieved content to prevent prompt injections, instruction overrides, or jailbreaks.
4. **Transparent Factuality Scoring**: Scripts receive an empirical `overallFactualityScore` ($0-100\%$) based on the ratio of corroborated claims to total factual claims.
5. **Fail-Closed on Required Research**: When research is configured as `mode: "required"` (default for documentary and explainer profiles), inability to reach research providers or lack of corroborating evidence halts the pipeline with an explicit `FactualResearchRequiredError`.

---

## 2. Research Provider Architecture

The research system employs a provider-neutral interface ([`FactualResearchProvider`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/factual-research-provider.ts)):

1. **Wikipedia REST API** ([`WikipediaResearchProvider`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/wikipedia-research-provider.ts)):
   - Primary encyclopedic reference for historical, scientific, and geographical topics.
   - High baseline credibility score ($0.95$).
   - Captures canonical titles, stable URLs, publication/edit dates, and verified summaries.
2. **DuckDuckGo Instant Answer API** ([`DuckDuckGoResearchProvider`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/duckduckgo-research-provider.ts)):
   - Fast, unauthenticated search fallback for topical entities and definitions ($0.80-0.85$ credibility).
3. **Brave Search API** ([`BraveResearchProvider`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/brave-research-provider.ts)):
   - Premium web indexing when configured with `BRAVE_SEARCH_KEY`.
   - Handles rate limits and quota depletion with structured `BraveSearchQuotaExhaustedError` so pipelines can fall back cleanly without silent errors.
4. **Mock Research Provider** ([`MockResearchProvider`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/mock-research-provider.ts)):
   - Hermetic, offline in-memory source bank for deterministic automated test suites.

---

## 3. Claim Classification & Verification Matrix

Every script statement is parsed and classified into one of five claim categories:

| Claim Type | Classification Criteria | Verification Standard |
| :--- | :--- | :--- |
| **Numerical** | Dates, dimensions, financial amounts, percentages, distances. | **Strict Match**: Numbers and units must match supporting evidence within $\pm 2\%$. |
| **Scientific** | Physical laws, astronomical entities, chemical mechanisms, biology. | **Mechanism Match**: Underlying causal mechanism must be corroborated in evidence. |
| **Historical** | Eras, battles, treaties, founders, historic events. | **Chronological Match**: Entity names, locations, and time periods must match records. |
| **Current Event** | Recent releases, announcements, mission statuses. | **Recency & Provenance**: Must include publication date within relevant temporal window. |
| **General** | Observational transitions, rhetorical questions, conceptual hooks. | **Plausibility & Tone**: Evaluated for absence of extreme or ungrounded assertions. |

### Verification Status Codes

- `verified`: Corroborated by one or more credible research sources with token overlap $\ge 35\%$ and matching numerical entities.
- `unsupported`: No retrieved source corroborates the assertion. Triggers script revision or reduction in factuality score.
- `disputed`: Sources present contradictory claims (e.g., conflicting dates or values). Must be flagged in QA findings.
- `unverified`: Research was skipped (e.g., `mode: "disabled"` for creative fiction).

---

## 4. Prompt Injection & External Data Isolation

To protect the LLM generation engine against prompt injections from external web pages:

1. All retrieved text passes through [`sanitizeUntrustedContent`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/untrusted-content-sanitizer.ts) before prompt assembly.
2. The sanitizer filters out injection phrases (`IGNORE PREVIOUS INSTRUCTIONS`, `SYSTEM PROMPT:`, `### Human:`, `<|im_start|>`).
3. External text is strictly bounded in length (max 800 characters per snippet).
4. Evidence is placed inside explicit, isolated `<verified_research_context>` tags with instructions instructing the model to treat the content solely as inert factual reference material.

---

## 5. Storyboard & Visual Integration

Factual research directly governs visual shot generation:

1. **Concrete Visual Descriptions**: Visual requests generated in Stage 2 (`StoryboardPlanner`) must use real entities and attributes derived from verified research (e.g., "6.5-meter gold-plated hexagonal primary mirror of JWST" instead of "shiny space telescope").
2. **Accurate Stock Queries**: Search queries emitted for Pexels or local media banks prioritize verified entity names and technical keywords.
3. **Citations Artifacts**: Detailed claim-to-source mapping is persisted to `output/jobs/<jobId>/research/report.json` and bundled in the release manifest.

---

## 6. Pipeline Persistence & Invalidation Rules

1. Research artifacts are written to `output/jobs/<jobId>/research/`:
   - `report.json`: Full factuality report with score, queries, and claim status.
   - `sources.json`: Immutable array of retrieved `ResearchSource` objects.
   - `claims.json`: Array of `ClaimRecord` objects.
2. **Cascading Invalidation**:
   - Modifying research sources or topic invalidates `script` and all downstream stages.
   - Modifying the script invalidates `storyboard`, `media`, `visual`, `audio_aligned_visual`, and `video`.
   - Committed exports in `output/jobs/<jobId>/export/` remain immutable once published.
