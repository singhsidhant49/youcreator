import React from "react";

import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";

import type {
  RemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import {
  RemotionCaptions,
} from "./remotion-captions.js";

import {
  RemotionCompositionSchema,
  type RemotionComposition,
} from "./remotion-composition-contract.js";

import {
  RemotionShot,
} from "./remotion-shot.js";

import type {
  EditorialMotionPlan,
} from "./editorial-motion-plan.js";

import {
  evaluateEditorialFrame,
} from "./editorial-motion-evaluator.js";

import type {
  EditorialAudioPlan,
} from "./editorial-audio-plan.js";

import {
  decibelsToLinear,
  evaluateMusicGain,
} from "./editorial-audio-envelope.js";

export interface YouCreatorCompositionProps {
  manifest: RemotionComposition;

  /**
   * Maps canonical shot IDs to verified
   * staged publicDir media URLs.
   */
  imageUrls: Record<string, string>;
  audioUrl: string;
  musicUrl?: string;
  captionPlan: RemotionCaptionPlan;
  motionPlan?: EditorialMotionPlan;
  audioPlan?: EditorialAudioPlan;
}

interface RemotionCrossfadeOverlayProps {
  previousShot: RemotionComposition["shots"][number];
  previousShotIndex: number;
  previousImageUrl: string;
  motionPlan: EditorialMotionPlan;
  startFrame: number;
  durationFrames: number;
}

const RemotionCrossfadeOverlay: React.FC<
  RemotionCrossfadeOverlayProps
> = ({
  previousShotIndex,
  previousImageUrl,
  motionPlan,
  startFrame,
  durationFrames,
}) => {
  const localFrame = useCurrentFrame();

  if (localFrame >= durationFrames) {
    return null;
  }

  const absoluteFrame = startFrame + localFrame;
  const motion = evaluateEditorialFrame(
    motionPlan,
    previousShotIndex,
    absoluteFrame,
  );

  if (motion.opacity <= 0) {
    return null;
  }

  const maxTranslateX = Math.max(0, (motion.scale - 1) / 2) * 100;
  const safeTranslateX = Math.max(
    -maxTranslateX,
    Math.min(maxTranslateX, motion.translateXPercent),
  );

  const style: React.CSSProperties = {
    position: "absolute",
    width: "100%",
    height: "100%",
    objectFit: "cover",
    transform: [
      `translateX(${safeTranslateX}%)`,
      `scale(${motion.scale})`,
    ].join(" "),
    opacity: motion.opacity,
    pointerEvents: "none",
  };

  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        backgroundColor: "transparent",
      }}
    >
      <Img
        src={previousImageUrl}
        style={style}
      />
    </AbsoluteFill>
  );
};

export function validateSceneInputs(
  props: YouCreatorCompositionProps,
): void {
  const manifest =
    RemotionCompositionSchema.parse(
      props.manifest,
    );

  const expectedAudioUrl =
    `/media/${manifest.audio.sha256}.wav`;

  if (props.audioUrl !== expectedAudioUrl) {
    throw new Error(
      "M7 narration URL identity mismatch",
    );
  }

  if (
    props.captionPlan.compositionHash !==
      manifest.compositionHash ||
    props.captionPlan.fps !== manifest.fps ||
    props.captionPlan.totalFrames !==
      manifest.totalFrames
  ) {
    throw new Error(
      "M7 subtitle plan identity mismatch",
    );
  }

  if (props.motionPlan) {
    if (
      props.motionPlan.fps !== manifest.fps ||
      props.motionPlan.shots.length !== manifest.shots.length
    ) {
      throw new Error(
        "M10.3 motion plan composition mismatch",
      );
    }
  }

  if (props.audioPlan) {
    if (
      props.audioPlan.fps !== manifest.fps ||
      props.audioPlan.totalFrames !== manifest.totalFrames ||
      props.audioPlan.narrationSha256 !== manifest.audio.sha256
    ) {
      throw new Error(
        "M10.4 audio plan composition mismatch",
      );
    }

    if (props.audioPlan.musicEnabled && !props.musicUrl) {
      throw new Error(
        "M10.4 missing music media URL",
      );
    }
  }

  if (props.musicUrl) {
    if (
      !/^\/media\/[a-f0-9]{64}\.(wav|mp3|aac|m4a|ogg)$/.test(
        props.musicUrl,
      )
    ) {
      throw new Error(
        "M10.4 invalid music media URL",
      );
    }
  }

  let nextFrame = 0;

  for (const shot of manifest.shots) {
    if (
      shot.startFrame !== nextFrame ||
      shot.durationFrames <= 0 ||
      shot.endFrameExclusive !==
        shot.startFrame + shot.durationFrames
    ) {
      throw new Error(
        `M7 invalid shot timing: ${shot.shotId}`,
      );
    }

    const url = props.imageUrls[shot.shotId];

    if (
      !url ||
      !/^\/media\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(
        url,
      )
    ) {
      throw new Error(
        `M7 missing verified image URL: ${shot.shotId}`,
      );
    }

    nextFrame = shot.endFrameExclusive;
  }

  if (nextFrame !== manifest.totalFrames) {
    throw new Error(
      "M7 scene frame coverage mismatch",
    );
  }
}

export const YouCreatorComposition: React.FC<
  YouCreatorCompositionProps
> = (props) => {
  validateSceneInputs(props);

  const {
    manifest,
    imageUrls,
    audioUrl,
    musicUrl,
    captionPlan,
    motionPlan,
    audioPlan,
  } = props;

  const narrationSrc = staticFile(
    audioUrl.slice(1),
  );

  const narrationVolume = audioPlan
    ? decibelsToLinear(audioPlan.narrationGainDb)
    : 1;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#080808",
      }}
    >
      <Audio
        src={narrationSrc}
        volume={narrationVolume}
        startFrom={0}
        endAt={manifest.totalFrames}
      />

      {audioPlan?.musicEnabled && musicUrl && (
        <Audio
          src={staticFile(musicUrl.slice(1))}
          volume={(f) => evaluateMusicGain(audioPlan, f)}
          startFrom={0}
          endAt={manifest.totalFrames}
          loop
        />
      )}

      {manifest.shots.map((shot, shotIndex) => {
        const incomingBoundary = motionPlan?.boundaries[shotIndex - 1];
        const hasIncomingCrossfade =
          incomingBoundary?.type === "crossfade" &&
          incomingBoundary.toShotId === shot.shotId &&
          shotIndex > 0;

        const previousShot = hasIncomingCrossfade
          ? manifest.shots[shotIndex - 1]
          : undefined;

        const previousImageUrl = previousShot
          ? staticFile(imageUrls[previousShot.shotId]!.slice(1))
          : undefined;

        return (
          <Sequence
            key={shot.shotId}
            from={shot.startFrame}
            durationInFrames={shot.durationFrames}
            layout="none"
          >
            <RemotionShot
              shot={shot}
              imageUrl={staticFile(
                imageUrls[shot.shotId]!.slice(1),
              )}
              frameWidth={manifest.width}
              frameHeight={manifest.height}
              motionPlan={motionPlan}
              shotIndex={shotIndex}
            />

            {hasIncomingCrossfade && previousShot && previousImageUrl && motionPlan && (
              <RemotionCrossfadeOverlay
                previousShot={previousShot}
                previousShotIndex={shotIndex - 1}
                previousImageUrl={previousImageUrl}
                motionPlan={motionPlan}
                startFrame={shot.startFrame}
                durationFrames={incomingBoundary.durationFrames}
              />
            )}
          </Sequence>
        );
      })}

      <RemotionCaptions plan={captionPlan} />
    </AbsoluteFill>
  );
};



