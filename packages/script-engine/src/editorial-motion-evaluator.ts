import type {
  EditorialMotionPlan,
} from "./editorial-motion-plan.js";

export interface EditorialFrameTransform {
  scale: number;
  translateXPercent: number;
  opacity: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function interpolate(
  start: number,
  end: number,
  progress: number,
): number {
  return start +
    (end - start) * smoothstep(progress);
}

export function evaluateEditorialFrame(
  plan: EditorialMotionPlan,
  shotIndex: number,
  absoluteFrame: number,
): EditorialFrameTransform {
  const shot = plan.shots[shotIndex];

  if (!shot) {
    throw new Error(
      "M10.3 missing motion shot",
    );
  }

  if (
    !Number.isSafeInteger(absoluteFrame) ||
    absoluteFrame < 0
  ) {
    throw new Error(
      "M10.3 invalid evaluation frame",
    );
  }

  const duration =
    shot.endFrameExclusive - shot.startFrame;

  const position = clamp01(
    (absoluteFrame - shot.startFrame) /
      Math.max(1, duration - 1),
  );

  let opacity = 1;

  const incoming = plan.boundaries[shotIndex - 1];

  if (
    incoming?.type === "crossfade" &&
    incoming.toShotId === shot.shotId
  ) {
    const progress =
      (absoluteFrame - shot.startFrame + 1) /
      incoming.durationFrames;

    opacity = Math.min(
      opacity,
      clamp01(progress),
    );
  }

  const outgoing = plan.boundaries[shotIndex];

  if (
    outgoing?.type === "crossfade" &&
    outgoing.fromShotId === shot.shotId
  ) {
    // Outgoing shot stays fully visible until
    // the next shot begins. The renderer must
    // keep it mounted during the next shot's
    // crossfade window.
    const elapsed =
      absoluteFrame - shot.endFrameExclusive;

    if (elapsed >= 0) {
      opacity = Math.min(
        opacity,
        1 - clamp01(
          (elapsed + 1) /
            outgoing.durationFrames,
        ),
      );
    }
  }

  return {
    scale: interpolate(
      shot.startScale,
      shot.endScale,
      position,
    ),
    translateXPercent: interpolate(
      shot.startX,
      shot.endX,
      position,
    ) * 100,
    opacity,
  };
}
