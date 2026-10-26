# YouCreator Mode B: Live Ideogram P-Image Integration

## 1. Architectural Overview

**Mode B (AI-Generated Visuals)** is YouCreator's canonical pipeline mode for synthesizing bespoke visual assets using generative AI. In Canonical Version 2 (`visualModeVersion: 2` or `visualMode: "ai"` / `"B"`), every visual shot required by the storyboard is dispatched to a validated generative image provider.

### Core Contracts & Interfaces
* **Provider Contract**: `AIImageProvider` in [`packages/script-engine/src/ai-image-generation.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/ai-image-generation.ts).
* **Live Implementation**: `IdeogramImageProvider` in [`packages/script-engine/src/ideogram-image-provider.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/ideogram-image-provider.ts).
* **Prompt Construction**: `AIShotPromptBuilder` in [`packages/script-engine/src/ai-shot-prompt-builder.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/ai-shot-prompt-builder.ts).
* **Shot Resolution**: `ModeBAIShotResolver` in [`packages/script-engine/src/mode-b-ai-resolver.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/mode-b-ai-resolver.ts).
* **Pipeline Integration**: `createProductionPipeline` in [`packages/script-engine/src/production-pipeline-builder.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/production-pipeline-builder.ts).

---

## 2. Live Ideogram API Specification

### Endpoint & Authentication
* **Base URL**: `https://api.ideogram.ai`
* **Generation Endpoint**: `POST /v2/image/generate/p-image-ideogram`
* **Authentication Header**: `Api-Key: <IDEOGRAM_API_KEY>`
* **Content-Type**: `application/json`

### Primary Configuration
* **Model**: `p-image-ideogram`
* **Quality**: `very_low` (Official Ideogram published pricing: **$0.003 USD / image** / `3000` micros)
* **Resolution**: `1k`
* **Aspect Ratio**: `16x9` (Normalizes `"16:9"` -> `"16x9"`, yielding exactly **1280×720** pixels)
* **Magic Prompt**: `"off"` (Ensures deterministic adherence to prompt instructions without unpredictable LLM expansion)
* **Num Images**: `1`

### Request Payload Format
```json
{
  "prompt": "Photorealistic cinematic visual explainer composition...",
  "negative_prompt": "text, watermark, logos, subtitles, blur, low resolution artifacts...",
  "magic_prompt": "off",
  "num_images": 1,
  "quality": "very_low",
  "resolution": "1k",
  "aspect_ratio": "16x9",
  "seed": 0
}
```

### Preflight Pricing Quotes (`dry_run=true`)
Before generating chargeable images, `IdeogramImageProvider.getPriceQuote(req)` queries:
`POST /v2/image/generate/p-image-ideogram?dry_run=true`
The API validates authentication, schema, model availability, and returns an exact price quote without generating images or deducting account balance:
```json
{
  "object": "price_quote",
  "billing_identifier": "p_image_ideogram_generation",
  "quantity": 1,
  "usd_micros": 3000,
  "credit_millis": 300,
  "qualifier": "exact"
}
```

### Ephemeral URL Ingestion
Ideogram returns temporary URLs signed with HMAC query tokens (`https://ideogram.ai/api/images/ephemeral/...`). These links expire shortly after generation.
`IdeogramImageProvider` immediately streams the response into memory:
1. Validates HTTP response status and timeout (bounded by `timeoutMs: 60_000`).
2. Enforces maximum byte limits (`maxDownloadBytes: 25 * 1024 * 1024`).
3. Binary PNG decoding & dimensions inspection via `inspectImageBytes`.
4. Computes SHA-256 cryptographic digest over raw bytes.
5. Verifies provider safety assertions (`is_image_safe: true`).

---

## 3. Dynamic Configuration & Future-Proof Model Swapping

The integration was designed so that the model, quality, resolution, and aspect ratio can be switched without any codebase refactoring:

### Configuration Priority
1. **Request-Level Override**: Passed in `request.settings` (`model`, `quality`, `resolution`, `aspectRatio`).
2. **Pipeline Options**: Passed to `createProductionPipeline({ ideogramModel, ideogramQuality, ... })`.
3. **Environment Variables**:
   * `IDEOGRAM_MODEL`: Target model (defaults to `p-image-ideogram`, supports `ideogram-4`, `ideogram-4-5`).
   * `IDEOGRAM_QUALITY`: Quality tier (`very_low`, `low`, `medium`, `high`, `very_high`).
   * `IDEOGRAM_RESOLUTION`: Resolution tier (`1k`, `2k`).
   * `IDEOGRAM_ASPECT_RATIO`: Target aspect ratio (`16x9`, `9x16`, `1x1`, `4x3`, etc.).
4. **Safe Defaults**: `p-image-ideogram` at `very_low`, `1k`, `16x9`.

### Model Pricing Lookup Table
| Model | Quality Tier | Resolution | Cost per Image |
| :--- | :--- | :--- | :--- |
| `p-image-ideogram` | `very_low` | `1k` | **$0.003 USD** |
| `p-image-ideogram` | `low` | `1k` | $0.006 USD |
| `p-image-ideogram` | `medium` | `1k` | $0.010 USD |
| `p-image-ideogram` | `high` | `1k` | $0.020 USD |
| `p-image-ideogram` | `very_high` | `1k` | $0.040 USD |
| `ideogram-4-5` | `very_low` | `1k` | $0.008 USD |
| `ideogram-4-5` | `low` | `1k` | $0.030 USD |
| `ideogram-4` | `turbo` | `1k` | $0.030 USD |
| `ideogram-4` | `default` | `1k` | $0.060 USD |

---

## 4. Cost Controls & Budget Guardrails

1. **Pre-Dispatch Duplicate Check**: Before making an external paid API call, `ModeBAIShotResolver` looks up the generation key in `MediaObjectStore`. If an asset for this exact shot prompt, model, and seed already exists, it is loaded locally without incurring an API request.
2. **Shot-Level Budget Cap**: Enforces `maxCostPerImageUsd: 0.04`. Any configuration exceeding this limit is rejected before making a request.
3. **Job-Level Budget Cap**: Enforces `maxCostPerJobUsd: 5.00`. Tracks cumulative spent USD across all shots and halts generation if exceeded.
4. **No Unbounded Retries**: Maximum 2 retries per shot on transient errors (HTTP 429, 500, 503). Retries employ exponential backoff with random jitter.
5. **No Blind Timeout Retries**: If a request times out after HTTP dispatch, it is marked failed and not re-dispatched repeatedly to prevent accidental double-billing.

---

## 5. Scene Prompt Construction & Continuity

`AIShotPromptBuilder` in [`packages/script-engine/src/ai-shot-prompt-builder.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/ai-shot-prompt-builder.ts):
* **Contextual Composition**: Binds topic, scene narrative intent, shot narration text, visual description, required domain concepts, and profile styling (`explainer`, `documentary`, `story`).
* **Anti-Cliché Filtering**: Strips generic prompt tokens ("technology background", "beautiful cinematic image", "high quality").
* **Framing & Aspect Ratio**: Injects framing directives (`horizontal 16:9 composition`, camera angle, subject focal distance).
* **Mandatory Negative Prompts**: Excludes `text, watermark, logos, subtitles, blur, low resolution artifacts` plus any scene-specific excluded elements.

---

## 6. Durable Content-Addressed Storage & Provenance

* **Disk Storage**: Image bytes are persisted to `<storageRoot>/objects/<sha256[0..2]>/<sha256>.png`.
* **Registration**: Stored in `MediaObjectStore` with format, dimensions, size in bytes, and creation timestamp.
* **Commercial Rights**: Pre-registered in `MediaUsageRightsStore` as `commercialPermission: "confirmed"` with `intendedUse: "commercial_youtube"`.
* **Zero Secrets Leakage**: API keys and authorization headers are never written to disk, manifests, logs, or exported packages.

---

## 7. Strict Pipeline Mode Isolation

* **Mode A (Stock/Web)**: Uses Pexels, permitted web, and local image banks. **Zero** calls to Ideogram.
* **Mode B (AI Visuals)**: Uses Ideogram `p-image-ideogram`. **Zero** calls to Pexels or stock providers.
* **Mode C (Manual)**: Uses local user-provided assets. **Zero** calls to Ideogram or stock providers.
* **Historical Jobs**: Pre-M10.6 Version 1 Mode B jobs remain intelligent stock/web and load checkpoints deterministically without regeneration.

---

## 8. Real Live Acceptance Evidence

### Single-Image Acceptance Run
* **Dry-Run Quote**: Returned `usdMicros: 3000` ($0.0030 USD).
* **Generation ID**: `SRgttu-nRwmK-Johz47e3Q`
* **Image Format**: 1280 × 720 PNG
* **File Size**: 813,799 bytes
* **Digest**: `sha256:a9ffa0bdf783b1188459bf285138ca4f8c2b540a2a24973adcb3ce750ef512ef`
* **Latency**: 3,405 ms
* **Safety Verified**: `is_image_safe: true`
* **Evidence File**: [`output/ideogram-acceptance/single-image-neptune.png`](file:///Users/siddhantsingh/Developer/experiment/youcreator/output/ideogram-acceptance/single-image-neptune.png)

### End-to-End Mode B Video Acceptance Run (`m10-6b-acceptance-neptune`)
* **Topic**: *"Neptune's Atmosphere and Extreme Supersonic Winds"* (Explainer profile, 30s brief)
* **Stages Completed**: `script` → `storyboard` → `media` → `visual` → `audio_aligned_visual` → `video` → `quality_assurance` → `video_export`
* **Total AI Visuals**: 8 bespoke scene images generated via `p-image-ideogram` `very_low`
* **Total AI Spend**: **$0.024 USD** ($0.003 × 8)
* **Narration**: Real Kokoro TTS voice synthesis with forced word-level timing alignment
* **Remotion Render**: 1080p MP4 (1920×1080 @ 30fps), 34.60s duration, 7,161,744 bytes
* **FFprobe Verification**:
  * Video stream: `h264`, 1920×1080 @ 30.0 fps, 1,329 kbps
  * Audio stream: `aac`, 48,000 Hz, stereo, 317 kbps
* **Automated QA Gate**: Score **100/100** (Visual: 100, Audio: 100, Subtitles: 100, Variety: 100), 0 warnings, 0 errors, Decision **`PASS`**
* **Export Package**: Verified under [`output/jobs/m10-6b-acceptance-neptune/export/`](file:///Users/siddhantsingh/Developer/experiment/youcreator/output/jobs/m10-6b-acceptance-neptune/export/) (`video.mp4`, `manifest.json`, `metadata.json`, `qa-report.json`, `subtitles.srt`, `subtitles.vtt`)
* **Bit-for-Bit Checkpoint Replay**: Re-executing the job finished in **11.9s** with **100% bit-for-bit identical checkpoints** and **zero** additional API calls.
* **Canonical Evidence File**: [`output/acceptance/mode-b-ideogram-report.json`](file:///Users/siddhantsingh/Developer/experiment/youcreator/output/acceptance/mode-b-ideogram-report.json)
