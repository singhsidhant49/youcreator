import type {
  VideoJobRunner,
} from "./persistent-video-batch.js";

import type {
  VideoBatchJob,
} from "./video-batch-contract.js";

import {
  VideoResourceDemandSchema,
  VideoResourceGovernor,
  type VideoResourceDemand,
} from "./video-resource-governor.js";

export interface ResourceProfileResolver {
  resolve(
    job: VideoBatchJob,
  ): VideoResourceDemand;
}

export function createResourceAwareVideoRunner(
  runner: VideoJobRunner,
  governor: VideoResourceGovernor,
  profiles: ResourceProfileResolver,
): VideoJobRunner {
  return {
    async run(job) {
      const demand =
        VideoResourceDemandSchema.parse(
          profiles.resolve(job),
        );

      return governor.withResources(
        demand,
        () => runner.run(job),
      );
    },
  };
}

/**
 * Example capacity planning defaults.
 * These values represent reservations, not
 * measured FFmpeg or Remotion process usage.
 */
export function createDefaultResourceProfiles():
  ResourceProfileResolver {
  const profiles: Record<
    string,
    VideoResourceDemand
  > = {
    explainer: {
      cpuUnits: 2,
      memoryMb: 2048,
      aiSlots: 1,
    },
    documentary: {
      cpuUnits: 3,
      memoryMb: 3072,
      aiSlots: 1,
    },
    story: {
      cpuUnits: 3,
      memoryMb: 4096,
      aiSlots: 1,
    },
  };

  return {
    resolve(job) {
      const demand =
        profiles[job.profileId];

      if (!demand) {
        throw new Error(
          `M9 unknown resource profile: ${job.profileId}`,
        );
      }

      return { ...demand };
    },
  };
}
