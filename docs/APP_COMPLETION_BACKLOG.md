# YouCreator: Application Completion Backlog (Prioritized P0–P3)

This backlog documents all architectural, functional, operational, and creative defects identified during the repository completion audit. Each issue includes file citations, concrete evidence, user impact, recommended fixes, and acceptance criteria.

---

## Priority P0: Critical Operational & Functional Blockers

### ISSUE-P0-01: Main CLI Entry Point Lacks Video Execution Command
* **Component**: CLI Application (`apps/cli`)
* **Supporting File**: [`apps/cli/src/index.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/apps/cli/src/index.ts) & [`apps/cli/src/cli-commands.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/apps/cli/src/cli-commands.ts)
* **Status**: **`RESOLVED` (Fixed in Milestone M10.7)**
* **Resolution**:
  - Implemented production CLI commands: `create`, `run`, `status`, `resume`, `cancel`, `export` in `apps/cli/src/cli-commands.ts`.
  - Wires canonical M1 `JobExecutor` with `createProductionPipeline`.
  - Full exit code contract: 0 (Success), 1 (Invalid Input), 2 (Provider Failure), 3 (Budget Exceeded), 4 (QA Rejection), 5 (Corruption).
  - Checkpoint reuse, crash recovery, and export packaging verified across all 3 canonical visual modes.
* **Verification Evidence**:
  - Verified across real execution: Mode A (`dfe22b92-f27a-4f2b-b9c2-14d943ed2ebd`), Mode B (`52a422e7-d7a7-4ce9-af8a-25550b6385e5`), Mode C (`4d9cb692-831a-4b39-9226-a49e876e6ba5`), and Configuration test (`5f5220a6-ab8c-44b9-8459-2e53518c887e`).
  - 19 new integration tests in `apps/cli/src/production-cli.test.ts` passing 100%.

---

### ISSUE-P0-02: Pipeline Factory Hardcodes Default Settings and Omits CLI Parameter Pass-Through
* **Component**: Script Engine Pipeline Builder & CLI
* **Supporting File**: [`packages/script-engine/src/production-pipeline-builder.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/production-pipeline-builder.ts) & [`apps/cli/src/cli-parser.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/apps/cli/src/cli-parser.ts)
* **Status**: **`RESOLVED` (Fixed in Milestone M10.7)**
* **Resolution**:
  - Eliminated hardcoded defaults; bound requested `durationSeconds`, `resolution`, `aspectRatio`, `fps`, `profile`, `voice`, `voiceSpeed`, `imageModel`, `imageQuality`, `budget`, and `assignments` throughout every pipeline stage.
  - Dynamically configured `PexelsPhotoProvider` orientation (`portrait` vs `landscape`) and `MediaCandidateSelector` target aspect ratio based on video dimensions.
  - Added native dimension and aspect ratio parser supporting strings like `720x1280`, `1080p`, `4k`, `16:9`, `9:16`.
* **Verification Evidence**:
  - Verified via real FFprobe inspection on rendered video for Acceptance E (`5f5220a6-ab8c-44b9-8459-2e53518c887e`): `720x1280`, display aspect ratio `9:16`, 30 fps, H.264 + AAC, 24.68s duration.
  - Verified full parameter propagation tests in `apps/cli/src/production-cli.test.ts`.

---

## Priority P1: Required for Reliable Production Application

### ISSUE-P1-01: Empty HTTP API Stub in `apps/api`
* **Component**: HTTP Service Layer
* **Supporting File**: `apps/api/` (Contains only `.gitkeep`)
* **Actual Observed Problem**: The repository defines an `apps/api` workspace in `package.json`, but contains no code. No HTTP server (Fastify or Express) exists to allow external applications, web dashboards, or microservices to submit video briefs, query render progress, or download export packages.
* **Evidence**: Directory listing of `apps/api` returns only `.gitkeep`.
* **Severity**: `P1`
* **User Impact**: YouCreator can only be invoked locally on the machine via CLI or script; it cannot be deployed as an independent backend service.
* **Recommended Fix**: Implement a lightweight HTTP API server in `apps/api/src/server.ts` using Node.js native `node:http` or Fastify:
  * `POST /v1/jobs` $\to$ Validate brief schema, create job in `JobStore`, enqueue.
  * `GET /v1/jobs/:id` $\to$ Return job status, current stage, and error details.
  * `GET /v1/jobs/:id/export` $\to$ Stream export package or provide download URLs.
* **Dependencies**: `ISSUE-P0-01`.
* **Effort Estimate**: 1.5 days.
* **Verification Method**: Send curl requests to `POST /v1/jobs` and `GET /v1/jobs/:id` and verify video generation succeeds.
* **Suggested Milestone**: `M11`

---

### ISSUE-P1-02: Missing Background Job Worker Daemon in `apps/worker`
* **Component**: Worker Service Layer
* **Supporting File**: `apps/worker/` (Contains only `.gitkeep`)
* **Actual Observed Problem**: `apps/worker` is an empty workspace. Jobs created with status `"queued"` remain in the store unless a synchronous runner is explicitly invoked. There is no long-running daemon polling `JobStore` or consuming a Redis queue.
* **Evidence**: Directory listing of `apps/worker` returns only `.gitkeep`.
* **Severity**: `P1`
* **User Impact**: Batch jobs cannot be processed asynchronously in the background.
* **Recommended Fix**: Create `apps/worker/src/worker.ts`:
  * Implements a polling loop over `storage/jobs/*.json` for `status: "queued"`.
  * Claims jobs atomically by transitioning status to `"running"`.
  * Delegates execution to `createProductionPipeline`.
  * Marks job `"completed"` or `"failed"`.
* **Dependencies**: `ISSUE-P0-01`, `ISSUE-P1-01`.
* **Effort Estimate**: 1.0 day.
* **Verification Method**: Create 3 queued jobs; start the worker daemon; verify all 3 jobs complete sequentially.
* **Suggested Milestone**: `M11`

---

### ISSUE-P1-03: Lack of Real-Time Factual Grounding in Script Generation
* **Component**: Script Generation Service & Research Engine
* **Supporting File**: [`packages/script-engine/src/factual-research-service.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/factual-research-service.ts), [`packages/contracts/src/research.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/contracts/src/research.ts), [`packages/script-engine/src/claim-verifier.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/claim-verifier.ts)
* **Status**: **`RESOLVED` (Fixed in Milestone M10.8)**
* **Resolution**:
  - Implemented provider-neutral `FactualResearchService` with `WikipediaResearchProvider`, `DuckDuckGoResearchProvider`, `BraveResearchProvider` (with 402 quota exhaustion handling), and `MockResearchProvider`.
  - Added untrusted content sanitizer (`sanitizeUntrustedContent`) protecting LLM prompts from web prompt injections.
  - Added `ClaimVerifier` classifying and corroborating claims across numerical, historical, scientific, and current event assertions.
  - Zero fabricated citations; fail-closed policy when research is required.
* **Verification Evidence**:
  - Unit tests in `packages/script-engine/src/factual-research-service.test.ts`, `claim-verifier.test.ts`, `untrusted-content-sanitizer.test.ts`.
  - Multi-scenario acceptance report in `output/acceptance/m10-8-report.json` demonstrating 100/100 factuality scores across science, business, and current events.


---

### ISSUE-P1-04: Vertical Aspect Ratio (9:16) Lacks Live Acceptance Testing
* **Component**: Remotion Compositor & Frame Analyzer
* **Supporting File**: [`packages/script-engine/src/remotion-composition.tsx`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/remotion-composition.tsx), [`packages/script-engine/src/video-qa-frame-analyzer.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/video-qa-frame-analyzer.ts)
* **Status**: **`RESOLVED` (Fixed in Milestone M10.6C)**
* **Resolution**:
  - Implemented dynamic portrait aspect ratio handling throughout the pipeline (Pexels portrait orientation, Remotion 1080x1920 composition, and QA frame analysis).
  - Executed live Scenario D job `b4f3b069-1d8f-42a6-9107-2c1b32d8f7eb` (45s vertical mobile explainer, 1080x1920 @ 30fps).
  - Rendered 1,299 frames @ 30fps (43.30s actual duration, -3.77% duration error within $\pm 10\%$ tolerance).
  - QA evaluated 100/100 PASS (Visual: 100, Audio: 100, Subtitles: 100, Variety: 100) with 0 warnings and 0 blocking errors.
  - Successfully exported to `output/jobs/b4f3b069-1d8f-42a6-9107-2c1b32d8f7eb/export/` with contact sheet in `output/acceptance/contact-sheet-scenario-d.jpg`.

---

## Priority P2: Professional Quality & Polish

### ISSUE-P2-01: Default Repository Lacks Bundled Royalty-Free Music Library
* **Component**: Editorial Audio Mixing
* **Supporting File**: [`packages/script-engine/src/editorial-audio-plan.ts:L34`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/editorial-audio-plan.ts#L34), [`packages/script-engine/src/production-pipeline-builder.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/production-pipeline-builder.ts)
* **Actual Observed Problem**: The engine includes audio ducking and envelope code (`musicBaseGainDb`, `duckingReductionDb`), but production runs execute with `music: null` because no royalty-free ambient music tracks are bundled under `storage/music/`.
* **Evidence**: In `mode-b-video-acceptance-report.json`, the Remotion composition props show no `musicUrl`, resulting in voice-only audio.
* **Severity**: `P2`
* **User Impact**: Finished videos lack emotional backing tracks, feeling dry and unpolished compared to professional YouTube videos.
* **Recommended Fix**: Add a curated set of 3–5 royalty-free, commercially cleared instrumental audio tracks (explainer, documentary, story) in `data/music/`, and configure the audio stage to select a track matching the profile.
* **Dependencies**: None.
* **Effort Estimate**: 0.5 day.
* **Verification Method**: Render an explainer video with music enabled; verify that background music plays at -24 dB and ducks 7 dB during speech.
* **Suggested Milestone**: `M10.8`

---

### ISSUE-P2-02: Missing Automated Disk Storage Pruning & Retention Management
* **Component**: Media & Job Storage
* **Supporting File**: [`packages/script-engine/src/media-object-store.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/media-object-store.ts), [`packages/core/src/checkpoint-store.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/core/src/checkpoint-store.ts)
* **Actual Observed Problem**: Downloaded images, generated TTS WAV files, Remotion temporary bundles, frame extractions, and exported MP4s accumulate in `output/` and `storage/` without any TTL, size quota, or garbage collection.
* **Evidence**: Running 10 acceptance jobs consumes over 500MB of disk space with no automated cleanup mechanism.
* **Severity**: `P2`
* **User Impact**: Over time on a production server, disk exhaustion will occur, causing pipeline crashes during Remotion rendering.
* **Recommended Fix**: Implement a `StoragePruner` utility that:
  1. Identifies unreferenced intermediate frame extractions older than 24 hours.
  2. Retains final export packages while pruning raw WAV and bundle artifacts.
  3. Provides an explicit CLI maintenance command: `cli prune --older-than 7d`.
* **Dependencies**: `ISSUE-P0-01`.
* **Effort Estimate**: 1.0 day.
* **Verification Method**: Run pruner with `--dry-run` and verify expired temp files are cleanly deleted while verified objects remain intact.
* **Suggested Milestone**: `M11`

---

### ISSUE-P2-03: Long-Form Video (>2 Minutes) Memory & Timeout Safeguards
* **Component**: Remotion Video Stage & Browser Runner
* **Supporting File**: [`packages/script-engine/src/remotion-mp4-renderer.ts:L1-L150`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/remotion-mp4-renderer.ts#L1-L150)
* **Actual Observed Problem**: Videos longer than 2 minutes (3,600+ frames at 30fps) require long Chromium browser rendering sessions. In low-memory environments, single-session renders of 5–10 minute videos risk Chromium out-of-memory crashes.
* **Evidence**: Remotion renderer currently executes the entire composition in a single `renderMedia()` call with default concurrency.
* **Severity**: `P2`
* **User Impact**: Users creating 5–10 minute long-form documentaries may experience intermittent render failures on standard VMs.
* **Recommended Fix**: Configure `@remotion/renderer` with `concurrency: 2` or `4` depending on available system RAM, and set `chromiumOptions: { enableMultiProcessOnLinux: true }` with explicit memory limits.
* **Dependencies**: None.
* **Effort Estimate**: 1.0 day.
* **Verification Method**: Execute a 3-minute video generation test; monitor memory usage and verify clean render completion.
* **Suggested Milestone**: `M10.9`

---

### ISSUE-P2-04: Multi-Shot Character & Location Continuity Across AI Scenes
* **Component**: AI Shot Prompt Builder & Continuity Engine
* **Supporting File**: [`packages/script-engine/src/ai-shot-prompt-builder.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/ai-shot-prompt-builder.ts), [`packages/script-engine/src/visual-continuity.ts`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/visual-continuity.ts)
* **Actual Observed Problem**: In narrative videos with recurring subjects (e.g. historical figures, protagonists), each shot prompt describes the character in text, but slight visual variations in face, hair, and clothing occur because text-only prompts cannot enforce pixel-level identity preservation.
* **Evidence**: Text prompts specify "deep blue planetary atmosphere with atmospheric storm bands", which succeeds for planetary scenes, but character identity in narrative storytelling varies across shots.
* **Severity**: `P2`
* **User Impact**: Storytelling videos have noticeable character drift between adjacent shots.
* **Recommended Fix**: Enhance `AIShotPromptBuilder` to maintain a canonical Character Profile Card (exact clothing, colors, age, distinct physical features) that is appended verbatim across all scenes involving that character, and prepare hooks for Ideogram reference image support (`image_request` / style reference) once available in the API.
* **Dependencies**: None.
* **Effort Estimate**: 1.5 days.
* **Verification Method**: Generate a 3-scene story with a named character; verify prompt continuity consistency.
* **Suggested Milestone**: `M10.8`

---

## Priority P3: Usability & Optional Enhancements

### ISSUE-P3-01: Terminal UX Lacks Interactive Progress Bars
* **Component**: CLI UX
* **Supporting File**: `apps/cli/src/index.ts`
* **Actual Observed Problem**: The CLI outputs raw JSON logs during execution. There are no terminal progress bars, spinners, or human-friendly status updates.
* **Severity**: `P3`
* **User Impact**: Minor developer experience inconvenience; hard to tell at a glance which stage is currently running.
* **Recommended Fix**: Add a friendly terminal reporter using `ora` and `cli-progress` that displays:
  `[1/8] Generating script... ✓`
  `[2/8] Planning storyboard... ✓`
  `[3/8] Generating AI images (3/8)...`
* **Suggested Milestone**: `M11`

---

### ISSUE-P3-02: Additional Generative AI Image Provider Adapters
* **Component**: Image Provider Subsystem
* **Supporting File**: `packages/script-engine/src/ai-image-generation.ts`
* **Actual Observed Problem**: Currently, Ideogram is the sole supported live AI image provider.
* **Severity**: `P3`
* **User Impact**: If a user prefers Midjourney, Flux, or Stable Diffusion, they cannot easily switch without implementing a new adapter.
* **Recommended Fix**: Implement `FluxImageProvider` and `OpenAIImageProvider` adhering to the existing `AIImageProvider` interface.
* **Suggested Milestone**: Post-M11 Future Enhancements

---

### ISSUE-P3-03: Kinetic Subtitle Animation Presets (Word Bouncing / Pop-In)
* **Component**: Remotion Caption Component
* **Supporting File**: [`packages/script-engine/src/remotion-captions.tsx`](file:///Users/siddhantsingh/Developer/experiment/youcreator/packages/script-engine/src/remotion-captions.tsx)
* **Actual Observed Problem**: Subtitles use high-contrast color highlighting on active words, but lack dynamic spring scale animations ("pop-in" / bouncing) common in modern social media videos.
* **Severity**: `P3`
* **User Impact**: Subtitles are clear and compliant, but lack high-energy social media aesthetics.
* **Recommended Fix**: Add Remotion `spring()` transforms on the active word token to provide a subtle pop-in effect.
* **Suggested Milestone**: `M10.8`
