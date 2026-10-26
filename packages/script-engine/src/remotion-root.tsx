import React from "react";

import {
  Composition,
} from "remotion";

import type {
  RemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  YouCreatorComposition,
  type YouCreatorCompositionProps,
} from "./remotion-composition.js";

import type {
  EditorialMotionPlan,
} from "./editorial-motion-plan.js";

import type {
  EditorialAudioPlan,
} from "./editorial-audio-plan.js";

export interface YouCreatorRootProps {
  manifest: RemotionComposition;
  imageUrls: Record<string, string>;
  audioUrl: string;
  musicUrl?: string;
  captionPlan: RemotionCaptionPlan;
  motionPlan?: EditorialMotionPlan;
  audioPlan?: EditorialAudioPlan;
}

/**
 * M7.4 root.
 *
 * Renderer worker supplies the canonical manifest,
 * staged image URLs, staged audio URL, and verified
 * caption plan.
 */
export const YouCreatorRoot: React.FC<
  YouCreatorRootProps
> = ({
  manifest,
  imageUrls,
  audioUrl,
  musicUrl,
  captionPlan,
  motionPlan,
  audioPlan,
}) => {
  const props: YouCreatorCompositionProps = {
    manifest,
    imageUrls,
    audioUrl,
    musicUrl,
    captionPlan,
    motionPlan,
    audioPlan,
  };

  return (
    <Composition
      id="YouCreatorNarratedV1"
      component={
        YouCreatorComposition as React.ComponentType<any>
      }
      durationInFrames={manifest.totalFrames}
      fps={manifest.fps}
      width={manifest.width}
      height={manifest.height}
      defaultProps={props}
    />
  );
};

