import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  createEditorialNarrativePlan,
} from "./editorial-narrative-plan.js";
import { OutlinePlanner } from "./outline-planner.js";
import { ScriptAssembler } from "./script-assembler.js";
import { analyzeVideoQaAudio } from "./video-qa-audio-analyzer.js";
import { CALIBRATED_RELEASE_POLICY } from "./video-qa-release-gate.js";
import { KokoroCaptionedTtsProvider } from "./kokoro-captioned-tts-provider.js";
import {
  createCaptionedNarrationRequestIdentity,
} from "./captioned-narration-contract.js";
import {
  analyzeVideoVisualVariety,
  hammingDistance64,
} from "./video-qa-visual-variety.js";
import { createVideoQaFramePlan } from "./video-qa-frame-plan.js";
import type { RemotionComposition } from "./remotion-composition-contract.js";

const H = "a".repeat(64);

function createCompositionFixture(
  assets: string[],
  width = 1920,
  height = 1080,
): RemotionComposition {
  const shots = assets.map((asset, index) => ({
    version: 1 as const,
    shotId: `shot-${index}`,
    shotIndex: index,
    bindingHash: H,
    assetSha256: asset.repeat(64),
    assetId: `asset-${index}`,
    assetPath: `/tmp/image-${index}.png`,
    sourceWidth: width,
    sourceHeight: height,
    startFrame: index * 30,
    endFrameExclusive: (index + 1) * 30,
    durationFrames: 30,
    fit: "contain" as const,
    motion: "static" as const,
    startCrop: null,
    endCrop: null,
  }));

  return {
    version: 1,
    compositionId: "YouCreatorNarratedV1",
    jobId: "m10-6c-test-job",
    productionPackageHash: H,
    m6VisualHash: H,
    visualPackageHash: H,
    framePlanHash: H,
    scriptHash: H,
    alignmentHash: H,
    audioSha256: H,
    compositionHash: H,
    fps: 30,
    width,
    height,
    totalFrames: shots.length * 30,
    shotCount: shots.length,
    audio: {
      format: "wav_pcm_s16le",
      path: "/tmp/narration.wav",
      sha256: H,
      sampleRate: 24000,
      sampleFrames: shots.length * 24000,
      channels: 1,
      bitsPerSample: 16,
    },
    shots,
    words: [
      {
        tokenIndex: 0,
        word: "hello",
        startSeconds: 0,
        endSeconds: 1,
        startSample: 0,
        endSampleExclusive: 24000,
      },
    ],
  };
}

describe("M10.6C Production Quality & Duration Accuracy Acceptance", () => {
  describe("1. Duration Planning & WPM Harmonization", () => {
    it("defaults to 135 WPM in editorial narrative plan matching Kokoro 0.9x speed", () => {
      const plan30 = createEditorialNarrativePlan({
        topic: "Solar Satellites",
        profile: "documentary",
        targetDurationSeconds: 30,
      });
      expect(plan30.targetWords).toBe(68);

      const plan45 = createEditorialNarrativePlan({
        topic: "Fiber Optic Internet",
        profile: "explainer",
        targetDurationSeconds: 45,
      });
      expect(plan45.targetWords).toBe(101);

      const plan60 = createEditorialNarrativePlan({
        topic: "Roman Architecture",
        profile: "explainer",
        targetDurationSeconds: 60,
      });
      expect(plan60.targetWords).toBe(135);

      const plan120 = createEditorialNarrativePlan({
        topic: "The History of Aviation",
        profile: "documentary",
        targetDurationSeconds: 120,
      });
      expect(plan120.targetWords).toBe(270);
    });

    it("enforces tightened 15% outline word budget tolerance", async () => {
      const mockLlm = {
        generate: vi.fn(async () => ({
          text: JSON.stringify({
            version: 1,
            title: "Procrastination",
            centralIdea: "Emotional regulation",
            hookPlan: "Curiosity question",
            hookTargetWords: 20,
            sections: [
              {
                id: "section-1",
                title: "Mechanism",
                objective: "Explain",
                keyPoints: ["Point 1"],
                targetWords: 100, // Total = 20 + 100 + 20 = 140 words vs 68 target (+105% deviation!)
              },
            ],
            outroPlan: "Takeaway",
            outroTargetWords: 20,
          }),
          model: "test-model",
        })),
      };

      const planner = new OutlinePlanner(mockLlm);
      await expect(
        planner.plan({
          topic: "Procrastination",
          durationSeconds: 30, // 30s -> target words = 68
        }),
      ).rejects.toThrow(/Outline word budget deviates by \d+% from target/);
    });
  });

  describe("2. Bounded Script Revision", () => {
    it("triggers bounded whole-script revision when assembled narration deviates from target", async () => {
      const outline = {
        version: 1,
        title: "Deep Sea Life",
        centralIdea: "Creatures survive without sunlight",
        hookPlan: "Open with darkness",
        hookTargetWords: 15,
        sections: [
          {
            id: "section-001",
            title: "Hydrothermal vents",
            objective: "Explain chemosynthesis",
            keyPoints: ["Mineral vents"],
            targetWords: 40,
          },
        ],
        outroPlan: "Final thought",
        outroTargetWords: 15,
      };

      const revisedSectionText1 =
        "Hydrothermal vents spew mineral-rich fluids from the volcanic seabed into the freezing darkness. " +
        "Specialized bacteria harness hydrogen sulfide through chemosynthesis rather than sunlight, forming the basis of a thriving ecosystem. " +
        "Giant tube worms cluster around these superheated towers in complete isolation.";

      const revisedSectionText2 =
        revisedSectionText1 +
        " Ghostly crabs and strange fish roam these hydrothermal chimneys, proving complex life flourishes without sunlight.";

      const responses = [
        outline,
        { narration: "Darkness covers the ocean abyss completely." }, // hook (7 words)
        { narration: "Vents erupt in the deep." }, // initial section (5 words)
        { narration: revisedSectionText1 }, // section-level revision (~39 words, within 15% of 40)
        { narration: "Life finds a way even in the dark." }, // outro (8 words)
        { narration: revisedSectionText2 }, // whole-script revision (~52 words)
      ];

      const generate = vi.fn(async () => ({
        text: JSON.stringify(responses.shift()),
        model: "test-model",
      }));

      const assembler = new ScriptAssembler(
        { generate },
        {
          reviseSections: true,
          maxRevisionCalls: 2,
          revisionTolerance: 0.15,
        },
      );

      const result = await assembler.assemble({
        topic: "Deep Sea Life",
        durationSeconds: 30, // 30s * 135 / 60 = 68 words
      });

      expect(result.revisionCalls).toBeGreaterThan(0);
      expect(result.revisions.length).toBeGreaterThan(0);
      expect(result.revisions[0]?.accepted).toBe(true);
      expect(result.actualWords).toBeGreaterThan(35);
    });
  });

  describe("3. QA Audio Pause Classification", () => {
    it("distinguishes natural clause conjunction pauses from genuine dropouts", () => {
      const sampleRate = 24000;
      const durationSeconds = 4.0;
      const totalSamples = Math.floor(sampleRate * durationSeconds);
      const pcm = Buffer.alloc(totalSamples * 2); // 16-bit PCM

      for (let i = 0; i < totalSamples; i++) {
        const timeSec = i / sampleRate;
        const isSilent = timeSec >= 1.5 && timeSec < 1.9;
        if (!isSilent) {
          const sampleVal = Math.floor(Math.sin(2 * Math.PI * 400 * timeSec) * 15000);
          pcm.writeInt16LE(sampleVal, i * 2);
        }
      }

      const words = [
        { word: "sunlight", startSeconds: 0.8, endSeconds: 1.5 },
        { word: "and", startSeconds: 1.9, endSeconds: 2.2 },
        { word: "convert", startSeconds: 2.2, endSeconds: 2.8 },
      ];

      const report = analyzeVideoQaAudio(pcm, sampleRate, {
        words,
        ...CALIBRATED_RELEASE_POLICY.audio,
      });

      const dropoutErrors = report.findings.filter(
        (f) => f.code === "POSSIBLE_AUDIO_DROPOUT" && f.severity === "error",
      );
      expect(dropoutErrors).toHaveLength(0);

      const expectedPauses = report.findings.filter(
        (f) => f.code === "EXPECTED_SPEECH_PAUSE",
      );
      expect(expectedPauses.length).toBeGreaterThan(0);
    });

    it("still catches true mid-word dropouts and prolonged unexplained silences", () => {
      const sampleRate = 24000;
      const totalSamples = sampleRate * 3;
      const pcm = Buffer.alloc(totalSamples * 2);

      const words = [
        { word: "prolonged", startSeconds: 0.5, endSeconds: 1.5 },
        { word: "speech", startSeconds: 1.5, endSeconds: 2.5 },
      ];

      const report = analyzeVideoQaAudio(pcm, sampleRate, {
        words,
        ...CALIBRATED_RELEASE_POLICY.audio,
      });

      const dropouts = report.findings.filter((f) => f.code === "POSSIBLE_AUDIO_DROPOUT");
      expect(dropouts.length).toBeGreaterThan(0);
      expect(dropouts[0]?.severity).toBe("warning");
    });
  });

  describe("4. Real vs Placeholder TTS Behavior", () => {
    it("fails clearly without producing dummy sine wave audio when Kokoro is unreachable", async () => {
      const provider = new KokoroCaptionedTtsProvider({
        baseUrl: "http://127.0.0.1:19999",
      });

      await expect(
        provider.synthesize({
          jobId: "test-tts-job",
          input: "This is genuine production narration.",
        }),
      ).rejects.toThrow(/Kokoro captioned synthesis failed: provider unreachable/);
    });
  });

  describe("5. Manual Mode Visual Variety", () => {
    it("perceptual hash calculates large distance between diverse visual assets", () => {
      const dist = hammingDistance64(0n, 0xffffffffffffffffn);
      expect(dist).toBe(64);

      const distPartial = hammingDistance64(0n, 0x0fn);
      expect(distPartial).toBe(4);
    });

    it("passes visual variety QA when manual assets have distinct perceptual content", async () => {
      const assets = ["a", "b", "c", "d", "e"];
      const images = await Promise.all(
        [
          { r: 240, g: 20, b: 20 },
          { r: 20, g: 240, b: 20 },
          { r: 20, g: 20, b: 240 },
          { r: 240, g: 240, b: 20 },
          { r: 160, g: 20, b: 240 },
        ].map(async (color, idx) =>
          sharp({
            create: {
              width: 64,
              height: 64,
              channels: 3,
              background: color,
            },
          })
            .composite([
              {
                input: Buffer.from(
                  `<svg width="64" height="64"><line x1="${idx * 12}" y1="0" x2="${64 - idx * 10}" y2="64" stroke="white" stroke-width="8"/></svg>`,
                ),
              },
            ])
            .png()
            .toBuffer(),
        ),
      );

      const composition = createCompositionFixture(assets);
      const plan = createVideoQaFramePlan(composition);
      const frames = plan.samples.map((sample) => ({
        frame: sample.frame,
        png: images[sample.shotIndex]!,
      }));

      const report = await analyzeVideoVisualVariety(
        composition,
        plan,
        frames,
        CALIBRATED_RELEASE_POLICY.variety,
      );

      expect(report.findings.filter((f) => f.severity === "error")).toHaveLength(0);
      expect(report.uniqueAssetCount).toBe(5);
    });
  });

  describe("6. Vertical Format Composition Acceptance", () => {
    it("validates 9:16 vertical geometry (1080x1920) in composition and frame planning", () => {
      const verticalComp = createCompositionFixture(["a", "b", "c"], 1080, 1920);

      expect(verticalComp.width).toBe(1080);
      expect(verticalComp.height).toBe(1920);
      expect(verticalComp.width / verticalComp.height).toBeCloseTo(9 / 16);

      const plan = createVideoQaFramePlan(verticalComp);
      expect(plan.totalFrames).toBe(90);
      expect(plan.samples.length).toBeGreaterThan(0);
    });
  });
});
