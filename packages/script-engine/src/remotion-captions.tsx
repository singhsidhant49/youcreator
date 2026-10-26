import React from "react";

import {
  AbsoluteFill,
  useCurrentFrame,
} from "remotion";

import type {
  CaptionCue,
  RemotionCaptionPlan,
} from "./remotion-caption-plan.js";

import {
  DEFAULT_SUBTITLE_QA_POLICY as style,
} from "./video-qa-subtitle-analyzer.js";

import {
  groupCaptionTokens,
} from "./caption-text-format.js";

export interface RemotionCaptionsProps {
  plan: RemotionCaptionPlan;
}

export function findActiveCaptionCue(
  cues: readonly CaptionCue[],
  frame: number,
): CaptionCue | null {
  let left = 0;
  let right = cues.length - 1;

  while (left <= right) {
    const mid = Math.floor(
      (left + right) / 2,
    );

    const cue = cues[mid]!;

    if (frame < cue.startFrame) {
      right = mid - 1;
    } else if (
      frame >= cue.endFrameExclusive
    ) {
      left = mid + 1;
    } else {
      return cue;
    }
  }

  return null;
}

export function findActiveWordIndex(
  cue: CaptionCue,
  frame: number,
): number {
  // A frame may intersect two word intervals.
  // Prefer the most recently started word.
  for (
    let i = cue.words.length - 1;
    i >= 0;
    i--
  ) {
    const word = cue.words[i]!;

    if (
      frame >= word.startFrame &&
      frame < word.endFrameExclusive
    ) {
      return word.index;
    }
  }

  return -1;
}

export const RemotionCaptions: React.FC<
  RemotionCaptionsProps
> = ({ plan }) => {
  const frame = useCurrentFrame();

  const cue = findActiveCaptionCue(
    plan.cues,
    frame,
  );

  if (!cue) return null;

  const activeIndex = findActiveWordIndex(
    cue,
    frame,
  );

  const groups = groupCaptionTokens(cue.words);

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom:
          `${style.safeBottomFraction * 100}%`,
        paddingLeft:
          `${style.safeHorizontalFraction * 100}%`,
        paddingRight:
          `${style.safeHorizontalFraction * 100}%`,
      }}
    >
      <div
        style={{
          maxWidth: "100%",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          columnGap: style.wordGapPx,
          rowGap: 8,
          padding:
            `${style.verticalPaddingPx}px ` +
            `${style.horizontalPaddingPx}px`,
          borderRadius: 14,
          backgroundColor: "rgba(0,0,0,0.66)",
          fontFamily: "Arial, Helvetica, sans-serif",
          fontSize: style.fontSizePx,
          fontWeight: 750,
          lineHeight: style.lineHeight,
          letterSpacing: -0.5,
          textAlign: "center",
        }}
      >
        {groups.map((group, groupIdx) => {
          const isGroupActive = group.tokens.some(
            (token) => token.index === activeIndex,
          );
          return (
            <span
              key={`group-${groupIdx}-${group.tokens[0]?.index ?? groupIdx}`}
              style={{
                color:
                  isGroupActive
                    ? "#FFD76A"
                    : "#FFFFFF",
                textShadow:
                  "0 2px 4px rgba(0,0,0,0.6)",
              }}
            >
              {group.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
