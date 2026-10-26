import {
  PersistentVideoExportStore,
  type VerifiedExportSourcePort,
} from "./persistent-video-export.js";

import {
  createNativeVideoExportStage,
} from "./video-export-stage.js";

export interface NativeVideoExportOptions {
  jobDirectory(jobId: string): string;
  sources: VerifiedExportSourcePort;
}

export function createNativeVideoExportPipeline(
  options: NativeVideoExportOptions,
) {
  const store = new PersistentVideoExportStore({
    jobDirectory: options.jobDirectory,
    sources: options.sources,
  });

  const stage = createNativeVideoExportStage(
    store,
  );

  return { store, stage };
}
