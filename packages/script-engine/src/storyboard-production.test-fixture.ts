import type { VideoScript } from "@youcreator/contracts";

import { storyboard } from "./visual-continuity.test-fixture.js";
import { planVisualContinuity } from "./visual-continuity.js";
import { createSceneMediaPlan } from "./scene-media-plan.js";

export const script: VideoScript = {
  version: 1,
  title: storyboard.scriptTitle,
  language: "en",
  tone: "documentary",

  hook: storyboard.sections[0]!
    .scenes.flatMap(
      (scene) => scene.shots,
    )
    .map(
      (shot) => shot.narrationText,
    )
    .join(" "),

  sections: [
    {
      id: "section-001",
      title: "Understanding Avoidance",
      narration: "A middle thought about emotional avoidance.",
      estimatedDurationSeconds: 4,
    },
  ],
  outro: "A final thought.",
};

export function productionFixture() {
  const completeStoryboard =
    structuredClone(storyboard);

  completeStoryboard.sections.push(
    {
      id: "sb-section-001",
      scriptSegmentId: "section-001",
      title: "Understanding Avoidance",
      scenes: [{
        id: "scene-middle",
        purpose: "Explain avoidance",
        shots: [{
          id: "shot-middle",
          narrationText: script.sections[0]!.narration,
          estimatedDurationSeconds: 4,
          visualRequest: {
            description:
              "A focused diagram showing human emotional avoidance",
            searchQueries: [
              "avoidance diagram behavior",
            ],
            negativeTerms: [],
            intent: "illustration",
            preferredMediaKind: "either",
          },
          motion: "slow_zoom_in",
          transition: "cut",
        }],
      }],
    },
    {
      id: "sb-outro",
      scriptSegmentId: "outro",
      title: "Conclusion",
      scenes: [{
        id: "scene-outro",
        purpose: "Conclude the narration",
        shots: [{
          id: "shot-outro",
          narrationText: script.outro,
          estimatedDurationSeconds: 3,
          visualRequest: {
            description:
              "A quiet evening desk illuminated by a warm lamp",
            searchQueries: [
              "warm lamp quiet desk evening",
            ],
            negativeTerms: [],
            intent: "atmosphere",
            preferredMediaKind: "either",
          },
          motion: "slow_zoom_out",
          transition: "cut",
        }],
      }],
    },
  );

  const continuity = planVisualContinuity(
    completeStoryboard,
    "documentary",
  );

  const mediaPlan = createSceneMediaPlan(
    completeStoryboard,
    continuity,
    "B",
  );

  return {
    script,
    storyboard: completeStoryboard,
    continuity,
    mediaPlan,
  };
}
