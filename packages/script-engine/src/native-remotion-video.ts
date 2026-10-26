import {
  PersistentRemotionVideoStore,
  createProductionVideoPorts,
  type RemotionVideoSourcePort,
} from "./persistent-remotion-video.js";

import {
  createNativeRemotionVideoStage,
} from "./remotion-video-stage.js";

export interface NativeRemotionVideoOptions {
  jobDirectory(jobId: string): string;

  /**
   * Load M7.1 composition and M7.4 caption plan
   * through the existing verified native stores.
   */
  sources: RemotionVideoSourcePort;

  entryPoint: string;
  concurrency?: number;
}

export function createNativeRemotionVideoPipeline(
  options: NativeRemotionVideoOptions,
) {
  const ports = createProductionVideoPorts(
    options.entryPoint,
    options.concurrency ?? 2,
  );

  const store = new PersistentRemotionVideoStore({
    jobDirectory: options.jobDirectory,
    sources: options.sources,
    ...ports,
  });

  const stage = createNativeRemotionVideoStage(
    store,
  );

  return {
    store,
    stage,
  };
}
