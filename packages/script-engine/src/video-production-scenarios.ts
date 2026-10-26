import type {
  ProductionAcceptanceSpec,
} from "./video-production-acceptance.js";

export const M9_PRODUCTION_SCENARIOS:
  readonly ProductionAcceptanceSpec[] = [
    {
      version: 1,
      job: {
        jobId: "m9-acceptance-tech",
        topic:
          "How artificial intelligence understands human language",
        profileId: "explainer",
      },
      minimumDurationSeconds: 45,
      durationToleranceSeconds: 8,
      requireCaptions: true,
      requireThumbnail: false,
    },
    {
      version: 1,
      job: {
        jobId: "m9-acceptance-business",
        topic:
          "How Netflix transformed the entertainment industry",
        profileId: "documentary",
      },
      minimumDurationSeconds: 45,
      durationToleranceSeconds: 5,
      requireCaptions: true,
      requireThumbnail: false,
    },
    {
      version: 1,
      job: {
        jobId: "m9-acceptance-science",
        topic:
          "A journey through the solar system from Earth to Neptune",
        profileId: "story",
      },
      minimumDurationSeconds: 45,
      durationToleranceSeconds: 0,
      requireCaptions: true,
      requireThumbnail: false,
    },
  ];
