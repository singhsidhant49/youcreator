import {
  StoryboardSchema,
  VideoScriptSchema,
  type Storyboard,
  type VideoScript,
} from "@youcreator/contracts";

export type CoverageIssueCode =
  | "MISSING_SEGMENT"
  | "EXTRA_SEGMENT"
  | "DUPLICATE_SEGMENT"
  | "SEGMENT_ORDER_MISMATCH"
  | "NARRATION_MISMATCH"
  | "DUPLICATE_ID";

export interface CoverageIssue {
  code: CoverageIssueCode;
  location: string;
  message: string;
}

export interface NarrationCoverageReport {
  passed: boolean;
  expectedWords: number;
  coveredWords: number;
  totalShots: number;
  expectedSegments: number;
  coveredSegments: number;
  issues: CoverageIssue[];
}

interface NarrationSegment {
  id: string;
  text: string;
}

function words(text: string): string[] {
  return text.trim().split(/\s+/u).filter(Boolean);
}

function normalize(text: string): string {
  return words(text).join(" ");
}

export function getScriptNarrationSegments(
  input: VideoScript,
): NarrationSegment[] {
  const script = VideoScriptSchema.parse(input);

  return [
    {
      id: "hook",
      text: script.hook,
    },
    ...script.sections.map((section) => ({
      id: section.id,
      text: section.narration,
    })),
    {
      id: "outro",
      text: script.outro,
    },
  ];
}

export function validateStoryboardCoverage(
  scriptInput: VideoScript,
  storyboardInput: Storyboard,
): NarrationCoverageReport {
  const segments =
    getScriptNarrationSegments(scriptInput);

  const storyboard =
    StoryboardSchema.parse(storyboardInput);

  const issues: CoverageIssue[] = [];

  const expectedIds = segments.map(
    (segment) => segment.id,
  );

  const actualIds = storyboard.sections.map(
    (section) => section.scriptSegmentId,
  );

  const expectedSet = new Set(expectedIds);

  const reportIssue = (
    code: CoverageIssueCode,
    location: string,
    message: string,
  ): void => {
    issues.push({
      code,
      location,
      message,
    });
  };

  const seenSegments = new Set<string>();

  for (const section of storyboard.sections) {
    const id = section.scriptSegmentId;

    if (!expectedSet.has(id)) {
      reportIssue(
        "EXTRA_SEGMENT",
        id,
        `Unexpected script segment: ${id}`,
      );
    }

    if (seenSegments.has(id)) {
      reportIssue(
        "DUPLICATE_SEGMENT",
        id,
        `Script segment appears more than once: ${id}`,
      );
    }

    seenSegments.add(id);
  }

  for (const id of expectedIds) {
    if (!seenSegments.has(id)) {
      reportIssue(
        "MISSING_SEGMENT",
        id,
        `Missing script segment: ${id}`,
      );
    }
  }

  if (
    expectedIds.join("\u0000") !==
    actualIds.join("\u0000")
  ) {
    reportIssue(
      "SEGMENT_ORDER_MISMATCH",
      "storyboard",
      "Storyboard segments do not match script order",
    );
  }

  const seenIds = new Set<string>();

  const checkId = (
    id: string,
    location: string,
  ): void => {
    if (seenIds.has(id)) {
      reportIssue(
        "DUPLICATE_ID",
        location,
        `Duplicate storyboard ID: ${id}`,
      );
    }

    seenIds.add(id);
  };

  let totalShots = 0;
  let coveredWords = 0;
  let coveredSegments = 0;

  const segmentLookup = new Map(
    segments.map((segment) => [
      segment.id,
      segment.text,
    ]),
  );

  for (const section of storyboard.sections) {
    checkId(section.id, section.id);

    const shotNarrations: string[] = [];

    for (const scene of section.scenes) {
      checkId(scene.id, scene.id);

      for (const shot of scene.shots) {
        checkId(shot.id, shot.id);

        totalShots++;

        coveredWords += words(
          shot.narrationText,
        ).length;

        shotNarrations.push(
          shot.narrationText,
        );
      }
    }

    const expectedNarration = segmentLookup.get(
      section.scriptSegmentId,
    );

    if (expectedNarration === undefined) {
      continue;
    }

    const actualNarration =
      shotNarrations.join(" ");

    if (
      normalize(actualNarration) !==
      normalize(expectedNarration)
    ) {
      reportIssue(
        "NARRATION_MISMATCH",
        section.scriptSegmentId,
        `Narration does not match script segment: ${section.scriptSegmentId}`,
      );
    } else {
      coveredSegments++;
    }
  }

  return {
    passed: issues.length === 0,

    expectedWords: segments.reduce(
      (sum, segment) =>
        sum + words(segment.text).length,
      0,
    ),

    coveredWords,
    totalShots,
    expectedSegments: segments.length,
    coveredSegments,
    issues,
  };
}
