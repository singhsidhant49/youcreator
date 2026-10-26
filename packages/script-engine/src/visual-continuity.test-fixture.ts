import type { Storyboard } from "@youcreator/contracts";

export const storyboard: Storyboard = {
  version: 1,
  scriptTitle: "Why Humans Procrastinate",
  sections: [
    {
      id: "sb-hook",
      scriptSegmentId: "hook",
      title: "Opening Hook",
      scenes: [
        {
          id: "scene-001",
          purpose: "Introduce the problem",
          shots: [
            {
              id: "shot-001",
              narrationText:
                "You sit down to work.",
              estimatedDurationSeconds: 3,
              visualRequest: {
                description:
                  "A person sitting at a desk with an open laptop",
                searchQueries: ["person working at desk"],
                intent: "illustration",
                preferredMediaKind: "either",
                negativeTerms: [],
              },
              motion: "slow_zoom_in",
              transition: "cut",
            },
            {
              id: "shot-002",
              narrationText:
                "The person checks their phone.",
              estimatedDurationSeconds: 4,
              visualRequest: {
                description:
                  "A person checking a smartphone beside a laptop",
                searchQueries: ["person smartphone laptop"],
                intent: "illustration",
                preferredMediaKind: "either",
                negativeTerms: [],
              },
              motion: "slow_zoom_in",
              transition: "cut",
            },
            {
              id: "shot-003",
              narrationText:
                "Time passes quickly.",
              estimatedDurationSeconds: 3,
              visualRequest: {
                description:
                  "An analog wall clock showing the passage of time",
                searchQueries: ["analog wall clock close up"],
                intent: "illustration",
                preferredMediaKind: "either",
                negativeTerms: [],
              },
              motion: "slow_zoom_in",
              transition: "cut",
            },
          ],
        },
      ],
    },
  ],
};
