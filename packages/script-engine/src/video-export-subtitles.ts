import type {
  RemotionCaptionPlan,
} from "./remotion-caption-plan.js";
import { formatCaptionText } from "./caption-text-format.js";

export function frameToSubtitleTimestamp(
  frame: number,
  fps: number,
  format: "srt" | "vtt",
): string {
  if (
    !Number.isSafeInteger(frame) ||
    frame < 0 ||
    !Number.isSafeInteger(fps) ||
    fps <= 0
  ) {
    throw new Error(
      "M9 invalid subtitle frame timing",
    );
  }

  // Exact integer rounding, without cumulative
  // floating-point timing drift.
  const milliseconds = Number(
    (
      BigInt(frame) * 1000n +
      BigInt(Math.floor(fps / 2))
    ) / BigInt(fps),
  );

  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(
      "M9 subtitle timestamp exceeds safe range",
    );
  }

  const hours = Math.floor(
    milliseconds / 3600000,
  );

  const minutes = Math.floor(
    (milliseconds % 3600000) / 60000,
  );

  const seconds = Math.floor(
    (milliseconds % 60000) / 1000,
  );

  const ms = milliseconds % 1000;

  const two = (n: number) =>
    String(n).padStart(2, "0");

  const three = (n: number) =>
    String(n).padStart(3, "0");

  const separator =
    format === "srt" ? "," : ".";

  return (
    `${two(hours)}:${two(minutes)}:` +
    `${two(seconds)}${separator}${three(ms)}`
  );
}

function cleanSubtitleText(
  value: string,
): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createExternalSubtitles(
  plan: RemotionCaptionPlan,
): {
  srt: string;
  vtt: string;
} {
  if (
    !Number.isSafeInteger(plan.fps) ||
    plan.fps <= 0 ||
    !Number.isSafeInteger(plan.totalFrames) ||
    plan.totalFrames <= 0
  ) {
    throw new Error(
      "M9 invalid subtitle plan timing",
    );
  }

  const srt: string[] = [];
  const vtt: string[] = ["WEBVTT", ""];

  let previousEnd = 0;

  for (const [index, cue] of plan.cues.entries()) {
    if (
      cue.startFrame < previousEnd ||
      cue.endFrameExclusive <= cue.startFrame ||
      cue.endFrameExclusive > plan.totalFrames
    ) {
      throw new Error(
        "M9 invalid or overlapping subtitle cues",
      );
    }

    const text = formatCaptionText(cue.words);

    if (!text) {
      throw new Error(
        "M9 empty subtitle cue",
      );
    }

    const startSrt =
      frameToSubtitleTimestamp(
        cue.startFrame,
        plan.fps,
        "srt",
      );

    const endSrt =
      frameToSubtitleTimestamp(
        cue.endFrameExclusive,
        plan.fps,
        "srt",
      );

    const startVtt =
      frameToSubtitleTimestamp(
        cue.startFrame,
        plan.fps,
        "vtt",
      );

    const endVtt =
      frameToSubtitleTimestamp(
        cue.endFrameExclusive,
        plan.fps,
        "vtt",
      );

    srt.push(
      `${index + 1}\n${startSrt} --> ${endSrt}\n${text}`,
    );

    vtt.push(
      `${startVtt} --> ${endVtt}\n${text}`,
    );

    previousEnd = cue.endFrameExclusive;
  }

  return {
    srt:
      srt.length > 0
        ? srt.join("\n\n") + "\n"
        : "",
    vtt:
      vtt.join("\n\n") + "\n",
  };
}
