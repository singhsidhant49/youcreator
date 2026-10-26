# YouCreator Duration Accuracy Policy

**Status:** APPROVED & ENFORCED (M10.6C)  
**Standard Speaking Rate:** 135 Words Per Minute (WPM) at default voice speed (0.9x)  
**Version:** 1.0.0

---

## 1. Objective & Principles

YouCreator produces fully automated, commercial-grade videos tailored to user-specified durations. Because audio narration governs the timeline and frame geometry across downstream stages (Remotion, visual alignment, subtitle synchronization), video duration accuracy is fundamentally a function of script narration length and speech pacing.

### Core Principles
1. **Narration-Governed Timeline**: The final MP4 duration is strictly bound to the spoken narration duration ($T_{\text{video}} \approx T_{\text{audio}}$).
2. **Harmonized Speaking Rates**: Every pipeline stage (narrative planning, outline budgeting, section writing, storyboard pacing, frame planning) must use a single unified speech rate constant: **135 WPM** at 0.9x Kokoro speed (or $\text{round}(150 \times \text{speed})$).
3. **Natural Script Adjustments**: Duration accuracy must be achieved through natural script expansion or contraction. Artificial audio padding, synthetic silence, and excessive visual padding are strictly prohibited.
4. **Bounded Revision**: If generated narration deviates beyond acceptable tolerances, the system triggers targeted, bounded section revisions using the narration reviser.

---

## 2. Duration Targets, Tolerances & Word Budgets

### Target Word Count Formula
$$\text{TargetWords} = \operatorname{round}\left( \frac{\text{DurationSeconds}}{60} \times \text{WPM} \right)$$

For standard Kokoro narration ($\text{WPM} = 135$ at speed $0.9$):

| Requested Duration | Target Words | Acceptable Duration Range ($\pm 10\%$) | Acceptable Duration Range ($\pm 15\%$) |
| :--- | :--- | :--- | :--- |
| **30 seconds** | 68 words | 27.0s – 33.0s | 25.5s – 34.5s |
| **45 seconds** | 101 words | 40.5s – 49.5s | 38.3s – 51.8s |
| **60 seconds** | 135 words | 54.0s – 66.0s | 51.0s – 69.0s |
| **120 seconds** | 270 words | 108.0s – 132.0s | 102.0s – 138.0s |

### Tolerance Boundaries
- **Standard Durations ($\ge 45\text{s}$)**: $\pm 10\%$ duration deviation allowed.
- **Short Durations ($30\text{s}$)**: $\pm 15\%$ duration deviation allowed to accommodate natural sentence cadence and atomic thoughts.
- **Readiness Gate Boundary**:
  - `minimumDurationRatio`: 0.85 (85% of target duration).
  - `maximumDurationRatio`: 1.15 (115% of target duration).

---

## 3. Pipeline Enforcement Lifecycle

### 3.1 Stage 1: Editorial Narrative Plan & Outline Planning
- `createEditorialNarrativePlan` calculates beat allocations using `wordsPerMinute: 135`.
- `OutlinePlanner` budgets total spoken words to `Math.round((brief.durationSeconds / 60) * 135)`.
- Outline budget tolerance is locked at $\le 15\%$ (`maxDeviation: 0.15`). Any proposed outline deviating $>15\%$ is rejected.

### 3.2 Stage 1: Script Assembly & Bounded Revision
- `ScriptAssembler` writes the hook, individual body sections, and outro.
- **Section-Level Revision**: If an individual section deviates by $>12\%$ from its planned section budget and revision quota remains, `NarrationReviser` is invoked.
- **Whole-Script Bounded Revision**: If the total assembled script words deviate from $\text{TargetWords}$ by $>12\%$ and revision quota remains:
  1. The assembler identifies the section with the largest deficit (for short scripts) or largest surplus (for long scripts).
  2. It calculates the exact word delta needed to hit the target.
  3. `NarrationReviser` naturally expands or condenses that section while preserving facts, tone, and flow.
  4. The script is re-assembled, preserving an immutable revision record.
  5. Maximum revision calls per job is bounded to **3**.

### 3.3 Stage 1: Script Readiness Gate
- `evaluateFinalScriptReadiness` evaluates the final script against `minimumDurationRatio: 0.85` and `maximumDurationRatio: 1.15`.
- Any script failing these boundaries halts the pipeline before paid asset acquisition or rendering occurs.

### 3.4 Stage 2: Storyboard Pacing & Shot Count
- `segmentNarrationIntoShots` chunks narration text into shot slots based on natural sentence boundaries and `wordsPerMinute: 135`.
- Pacing profile defaults:
  - `documentary`: 12 words/shot (~5.3 seconds/shot).
  - `educational`: 16 words/shot (~7.1 seconds/shot).
  - `meditation`: 70 words/shot (~31.1 seconds/shot).
- Micro-cuts below 2.0 seconds are automatically coalesced into adjacent shots.

### 3.5 Stage 5 & 6: Audio Alignment & Video Rendering
- Kokoro Captioned TTS synthesizes speech and emits word-level sample offsets.
- `AudioSampleShotTimeline` maps speech tokens to audio samples.
- `AudioAlignedFramePlan` computes frame-accurate shot boundaries:
  $$\text{TotalFrames} = \left\lceil \frac{\text{TotalSamples} \times \text{FPS}}{\text{SampleRate}} \right\rceil$$
- Remotion renders precisely $\text{TotalFrames}$, guaranteeing that the MP4 duration matches the narration.

---

## 4. Prohibited Practices
- **No Synthetic Silence**: Injecting dead silence gaps to stretch short scripts is strictly forbidden.
- **No Unnatural Audio Time-Stretching**: Pitch/tempo-shifting narration audio beyond natural prosody to force a duration is prohibited.
- **No Visual Freezes**: Holding a static frame after speech has ended to meet a duration target is prohibited.
- **Always Fix the Script**: When duration fails, the correct corrective action is script revision at the text level.
