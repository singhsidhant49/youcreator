import { describe, expect, it, vi } from "vitest";
import { PostTtsDurationVerifier } from "./post-tts-duration-verifier.js";
import type { VideoScript } from "@youcreator/contracts";
import type { NarrationReviser } from "./narration-reviser.js";

describe("PostTtsDurationVerifier", () => {
  const initialScript: VideoScript = {
    version: 1,
    title: "Space Energy",
    language: "en",
    tone: "documentary",
    hook: "How do space stations stay powered in deep space?",
    sections: [
      {
        id: "sec-1",
        title: "Solar Arrays",
        narration: "Solar panels collect sunlight and generate electricity.",
        estimatedDurationSeconds: 6,
      },
      {
        id: "sec-2",
        title: "Battery Storage",
        narration: "Massive battery banks store the surplus power for orbital darkness.",
        estimatedDurationSeconds: 8,
      },
    ],
    outro: "Continuous power keeps astronauts safe above the atmosphere.",
  };

  it("passes immediately when initial audio duration is within tolerance", async () => {
    const verifier = new PostTtsDurationVerifier({ toleranceRatio: 0.10 });
    const mockReviser = {} as NarrationReviser;
    const reSynthesize = vi.fn();
    const invalidate = vi.fn();

    const result = await verifier.verifyAndCorrect({
      jobId: "test-job-1",
      targetDurationSeconds: 30,
      initialAudioDurationSeconds: 28.5, // 28.5s is -5%, well within +/-10% (27s - 33s)
      script: initialScript,
      reviser: mockReviser,
      reSynthesizeAudio: reSynthesize,
      invalidateCheckpoints: invalidate,
    });

    expect(result.verified).toBe(true);
    expect(result.revised).toBe(false);
    expect(result.attempts).toBe(0);
    expect(reSynthesize).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("triggers bounded revision and invalidates downstream checkpoints when duration is too short", async () => {
    const verifier = new PostTtsDurationVerifier({
      toleranceRatio: 0.10,
      maxCorrectionAttempts: 2,
    });

    const mockReviser = {
      revise: vi.fn().mockResolvedValue({
        narration: "Advanced solar panels actively rotate to collect radiant sunlight, converting high energy photons directly into steady electric currents for onboard systems.",
        targetWords: 21,
        actualWords: 21,
        attempts: 1,
      }),
    } as unknown as NarrationReviser;

    const reSynthesize = vi.fn().mockResolvedValue({ durationSeconds: 28.8 });
    const invalidate = vi.fn().mockResolvedValue(undefined);

    const result = await verifier.verifyAndCorrect({
      jobId: "test-job-2",
      targetDurationSeconds: 30,
      initialAudioDurationSeconds: 24.4, // -18.7%, outside +/-10%
      script: initialScript,
      reviser: mockReviser,
      reSynthesizeAudio: reSynthesize,
      invalidateCheckpoints: invalidate,
    });

    expect(result.verified).toBe(true);
    expect(result.revised).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.actualDurationSeconds).toBe(28.8);
    expect(invalidate).toHaveBeenCalledWith("storyboard");
    expect(mockReviser.revise).toHaveBeenCalled();
  });

  it("reports an honest tolerance violation when duration cannot be corrected within max attempts", async () => {
    const verifier = new PostTtsDurationVerifier({
      toleranceRatio: 0.10,
      maxCorrectionAttempts: 1,
    });

    const mockReviser = {
      revise: vi.fn().mockResolvedValue({
        narration: "A slightly revised sentence that is still not quite long enough.",
        targetWords: 30,
        actualWords: 11,
        attempts: 1,
      }),
    } as unknown as NarrationReviser;

    // Second synthesis still returns out-of-tolerance duration
    const reSynthesize = vi.fn().mockResolvedValue({ durationSeconds: 25.0 });
    const invalidate = vi.fn().mockResolvedValue(undefined);

    const result = await verifier.verifyAndCorrect({
      jobId: "test-job-3",
      targetDurationSeconds: 30,
      initialAudioDurationSeconds: 24.0,
      script: initialScript,
      reviser: mockReviser,
      reSynthesizeAudio: reSynthesize,
      invalidateCheckpoints: invalidate,
    });

    expect(result.verified).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("tolerance");
  });
});
