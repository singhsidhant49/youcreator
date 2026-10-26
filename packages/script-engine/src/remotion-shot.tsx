import React from "react";

import {
  AbsoluteFill,
  Img,
  useCurrentFrame,
} from "remotion";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

import type {
  EditorialMotionPlan,
} from "./editorial-motion-plan.js";

import {
  evaluateEditorialFrame,
} from "./editorial-motion-evaluator.js";

type Shot = RemotionComposition["shots"][number];

export interface RemotionShotProps {
  shot: Shot;
  imageUrl: string;
  frameWidth: number;
  frameHeight: number;
  motionPlan?: EditorialMotionPlan;
  shotIndex?: number;
}

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function interpolateShotCrop(
  shot: Shot,
  localFrame: number,
): CropRect | null {
  if (shot.fit === "contain") {
    if (
      shot.startCrop !== null ||
      shot.endCrop !== null
    ) {
      throw new Error(
        `Invalid contain crop: ${shot.shotId}`,
      );
    }

    return null;
  }

  if (
    shot.startCrop === null ||
    shot.endCrop === null
  ) {
    throw new Error(
      `Missing cover crop: ${shot.shotId}`,
    );
  }

  const lastFrame = Math.max(
    0,
    shot.durationFrames - 1,
  );

  const progress =
    lastFrame === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, localFrame / lastFrame),
        );

  // Ease camera motion smoothly without
  // changing the verified crop endpoints.
  const eased =
    progress * progress *
    (3 - 2 * progress);

  const lerp = (a: number, b: number) =>
    a + (b - a) * eased;

  return {
    left: lerp(
      shot.startCrop.left,
      shot.endCrop.left,
    ),
    top: lerp(
      shot.startCrop.top,
      shot.endCrop.top,
    ),
    width: lerp(
      shot.startCrop.width,
      shot.endCrop.width,
    ),
    height: lerp(
      shot.startCrop.height,
      shot.endCrop.height,
    ),
  };
}

export function calculateImageTransform(
  crop: CropRect,
  frameWidth: number,
  frameHeight: number,
) {
  const scaleX = frameWidth / crop.width;
  const scaleY = frameHeight / crop.height;

  return {
    transform:
      `translate(${-crop.left * scaleX}px, ` +
      `${-crop.top * scaleY}px) scale(${scaleX}, ${scaleY})`,
    transformOrigin: "top left" as const,
  };
}

export const RemotionShot: React.FC<
  RemotionShotProps
> = ({
  shot,
  imageUrl,
  frameWidth,
  frameHeight,
  motionPlan,
  shotIndex,
}) => {
  // Within a Remotion Sequence this is
  // relative to that Sequence's start.
  const localFrame = useCurrentFrame();

  if (motionPlan && shotIndex !== undefined) {
    const absoluteFrame = shot.startFrame + localFrame;
    const motion = evaluateEditorialFrame(
      motionPlan,
      shotIndex,
      absoluteFrame,
    );

    // Constrain translation to available overscan margin so no borders are exposed
    const maxTranslateX = Math.max(0, (motion.scale - 1) / 2) * 100;
    const safeTranslateX = Math.max(
      -maxTranslateX,
      Math.min(maxTranslateX, motion.translateXPercent),
    );

    const style: React.CSSProperties = {
      width: "100%",
      height: "100%",
      objectFit: "cover",
      transform: [
        `translateX(${safeTranslateX}%)`,
        `scale(${motion.scale})`,
      ].join(" "),
      opacity: motion.opacity,
    };

    return (
      <AbsoluteFill
        style={{
          overflow: "hidden",
          backgroundColor: "#080808",
        }}
      >
        <Img
          src={imageUrl}
          style={style}
        />
      </AbsoluteFill>
    );
  }

  const crop = interpolateShotCrop(
    shot,
    localFrame,
  );

  if (crop === null) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "#080808",
          overflow: "hidden",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Img
          src={imageUrl}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
          }}
        />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        backgroundColor: "#080808",
      }}
    >
      <Img
        src={imageUrl}
        style={{
          position: "absolute",
          width: shot.sourceWidth,
          height: shot.sourceHeight,
          maxWidth: "none",
          maxHeight: "none",
          ...calculateImageTransform(
            crop,
            frameWidth,
            frameHeight,
          ),
        }}
      />
    </AbsoluteFill>
  );
};
