import {
  VideoScriptSchema,
  type VideoScript,
} from "@youcreator/contracts";

import {
  calculateCorrectionWordDelta,
  countSpokenWords,
  isDurationWithinTolerance,
} from "./duration-calibration.js";

import type { NarrationReviser } from "./narration-reviser.js";

export interface PostTtsVerificationResult {
  verified: boolean;
  actualDurationSeconds: number;
  targetDurationSeconds: number;
  deviationSeconds: number;
  deviationRatio: number;
  attempts: number;
  revised: boolean;
  finalScript: VideoScript;
  revisions: Array<{
    attempt: number;
    sectionId: string;
    previousWords: number;
    targetWords: number;
    revisedWords: number;
    previousDurationSeconds: number;
  }>;
  error?: string;
}

export interface PostTtsVerificationOptions {
  toleranceRatio?: number; // default: 0.10 (±10%)
  maxCorrectionAttempts?: number; // default: 2
  onInvalidateDownstream?: (jobId: string, fromStageId: string) => Promise<void> | void;
}

export class PostTtsDurationVerifier {
  private readonly toleranceRatio: number;
  private readonly maxCorrectionAttempts: number;

  constructor(options: PostTtsVerificationOptions = {}) {
    this.toleranceRatio = options.toleranceRatio ?? 0.10;
    this.maxCorrectionAttempts = options.maxCorrectionAttempts ?? 2;
  }

  /**
   * Verifies actual synthesized audio duration against the job's target duration.
   * If outside ±10% tolerance, triggers bounded section revisions and requests downstream checkpoint invalidation.
   */
  async verifyAndCorrect(params: {
    jobId: string;
    targetDurationSeconds: number;
    initialAudioDurationSeconds: number;
    script: VideoScript;
    reviser: NarrationReviser;
    reSynthesizeAudio: (script: VideoScript) => Promise<{ durationSeconds: number }>;
    invalidateCheckpoints?: (fromStageId: string) => Promise<void>;
  }): Promise<PostTtsVerificationResult> {
    const {
      jobId,
      targetDurationSeconds,
      reviser,
      reSynthesizeAudio,
      invalidateCheckpoints,
    } = params;

    let currentScript = VideoScriptSchema.parse(params.script);
    let currentDuration = params.initialAudioDurationSeconds;
    const revisions: PostTtsVerificationResult["revisions"] = [];

    let attempt = 0;

    while (attempt <= this.maxCorrectionAttempts) {
      const tolCheck = isDurationWithinTolerance(
        currentDuration,
        targetDurationSeconds,
        this.toleranceRatio,
      );

      if (tolCheck.withinTolerance) {
        return {
          verified: true,
          actualDurationSeconds: currentDuration,
          targetDurationSeconds,
          deviationSeconds: tolCheck.deviationSeconds,
          deviationRatio: tolCheck.deviationRatio,
          attempts: attempt,
          revised: revisions.length > 0,
          finalScript: currentScript,
          revisions,
        };
      }

      // If we reached maximum attempts and still out of tolerance, report violation honestly
      if (attempt >= this.maxCorrectionAttempts) {
        return {
          verified: false,
          actualDurationSeconds: currentDuration,
          targetDurationSeconds,
          deviationSeconds: tolCheck.deviationSeconds,
          deviationRatio: tolCheck.deviationRatio,
          attempts: attempt,
          revised: revisions.length > 0,
          finalScript: currentScript,
          revisions,
          error: `Audio duration ${currentDuration.toFixed(2)}s exceeds ±${Math.round(this.toleranceRatio * 100)}% tolerance for ${targetDurationSeconds}s target after ${attempt} correction attempts`,
        };
      }

      attempt += 1;

      // Calculate the spoken word delta needed based on measured empirical speaking rate
      const fullNarration = [
        currentScript.hook,
        ...currentScript.sections.map((s) => s.narration),
        currentScript.outro,
      ].join(" ");

      const totalWords = countSpokenWords(fullNarration);
      const correction = calculateCorrectionWordDelta(
        currentDuration,
        targetDurationSeconds,
        totalWords,
      );

      // Identify the best section to revise
      // If deficit (need more words): pick section with the fewest words or biggest room for expansion
      // If surplus (need fewer words): pick longest section
      let chosenSectionIndex = 0;
      if (correction.wordDelta > 0) {
        let minWords = Infinity;
        for (let i = 0; i < currentScript.sections.length; i++) {
          const words = countSpokenWords(currentScript.sections[i]!.narration);
          if (words < minWords) {
            minWords = words;
            chosenSectionIndex = i;
          }
        }
      } else {
        let maxWords = -Infinity;
        for (let i = 0; i < currentScript.sections.length; i++) {
          const words = countSpokenWords(currentScript.sections[i]!.narration);
          if (words > maxWords) {
            maxWords = words;
            chosenSectionIndex = i;
          }
        }
      }

      const targetSection = currentScript.sections[chosenSectionIndex]!;
      const currentSectionWords = countSpokenWords(targetSection.narration);
      const targetSectionWords = Math.max(12, currentSectionWords + correction.wordDelta);

      if (targetSectionWords === currentSectionWords) {
        // Cannot revise further
        break;
      }

      const revResult = await reviser.revise({
        narration: targetSection.narration,
        targetWords: targetSectionWords,
        language: currentScript.language,
        tone: currentScript.tone,
        context: `Video: ${currentScript.title}\nSection: ${targetSection.title}`,
      });

      const updatedSections = [...currentScript.sections];
      updatedSections[chosenSectionIndex] = {
        ...targetSection,
        narration: revResult.narration,
        estimatedDurationSeconds: (revResult.actualWords / 135) * 60,
      };

      currentScript = VideoScriptSchema.parse({
        ...currentScript,
        sections: updatedSections,
      });

      revisions.push({
        attempt,
        sectionId: targetSection.id,
        previousWords: currentSectionWords,
        targetWords: targetSectionWords,
        revisedWords: revResult.actualWords,
        previousDurationSeconds: currentDuration,
      });

      // Invalidate downstream checkpoints because script changed
      if (invalidateCheckpoints) {
        await invalidateCheckpoints("storyboard");
      }

      // Re-synthesize audio with the revised script
      const synthesized = await reSynthesizeAudio(currentScript);
      currentDuration = synthesized.durationSeconds;
    }

    const finalTol = isDurationWithinTolerance(
      currentDuration,
      targetDurationSeconds,
      this.toleranceRatio,
    );

    return {
      verified: finalTol.withinTolerance,
      actualDurationSeconds: currentDuration,
      targetDurationSeconds,
      deviationSeconds: finalTol.deviationSeconds,
      deviationRatio: finalTol.deviationRatio,
      attempts: attempt,
      revised: revisions.length > 0,
      finalScript: currentScript,
      revisions,
      error: finalTol.withinTolerance
        ? undefined
        : `Tolerance violation: final duration ${currentDuration.toFixed(2)}s outside allowed bounds [${finalTol.minAllowedSeconds}s, ${finalTol.maxAllowedSeconds}s]`,
    };
  }
}
