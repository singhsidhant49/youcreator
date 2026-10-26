import { z } from "zod";

import {
  VideoScriptSchema,
  type VideoScript,
} from "@youcreator/contracts";

import type { LLMGenerator } from "./script-generator.js";

import {
  evaluateEditorialQuality,
  type EditorialIssue,
  type EditorialQualityOptions,
} from "./editorial-quality.js";

const RevisionResponseSchema = z.object({
  narration: z.string().trim().min(1),
});

export interface EditorialRevisionResult {
  script: VideoScript;
  accepted: boolean;
  reason: string;
  originalNarration: string;
  proposedNarration?: string;
  issue: EditorialIssue;
  llmCalls: number;
}

export class EditorialReviser {
  constructor(
    private readonly llm: LLMGenerator,
  ) {}

  async revise(
    input: VideoScript,
    issue: EditorialIssue,
    options: EditorialQualityOptions = {},
  ): Promise<EditorialRevisionResult> {
    const script = VideoScriptSchema.parse(input);

    const originalNarration =
      issue.location === "hook"
        ? script.hook
        : issue.location === "outro"
          ? script.outro
          : script.sections.find(
              (s) => s.id === issue.location,
            )?.narration;

    if (!originalNarration) {
      throw new Error(
        `Unknown revision location: ${issue.location}`,
      );
    }

    // Script-wide findings need a separate planning step.
    if (issue.location === "script") {
      throw new Error(
        "Script-wide issues cannot be revised directly",
      );
    }

    const before = evaluateEditorialQuality(script, options);

    const matchingIssue = before.issues.some(
      (item) =>
        item.code === issue.code &&
        item.location === issue.location,
    );

    if (!matchingIssue) {
      throw new Error(
        "Editorial issue is no longer present",
      );
    }

    const response = await this.llm.generate(
      [
        {
          role: "system",
          content:
            "You are an expert YouTube narration editor. " +
            "Return valid JSON only.",
        },
        {
          role: "user",
          content: `
Video title: ${script.title}
Language: ${script.language}
Tone: ${script.tone}

Location: ${issue.location}
Problem: ${issue.message}
Suggested improvement: ${issue.suggestion}

Original narration:
${originalNarration}

Revise only this narration segment.

Requirements:
- Address the identified editorial weakness.
- Preserve the original meaning and key facts.
- Do not introduce statistics, quotations, or claims
  that are not supported by the original.
- Maintain natural spoken language.
- Avoid filler and repetition.
- Keep approximately the same length.
- Return only JSON.

{
  "narration": "Complete revised narration"
}
`,
        },
      ],
      {
        jsonMode: true,
        maxTokens: 2048,
      },
    );

    let parsed: unknown;

    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new Error(
        "Editorial revision returned invalid JSON",
      );
    }

    const proposedNarration =
      RevisionResponseSchema.parse(parsed).narration;

    const candidate = VideoScriptSchema.parse({
      ...script,
      hook:
        issue.location === "hook"
          ? proposedNarration
          : script.hook,
      outro:
        issue.location === "outro"
          ? proposedNarration
          : script.outro,
      sections: script.sections.map((section) =>
        section.id === issue.location
          ? { ...section, narration: proposedNarration }
          : section,
      ),
    });

    const after = evaluateEditorialQuality(
      candidate,
      options,
    );

    const issueResolved = !after.issues.some(
      (item) =>
        item.code === issue.code &&
        item.location === issue.location,
    );

    const newErrors = after.issues.filter(
      (item) =>
        item.severity === "error" &&
        !before.issues.some(
          (old) =>
            old.code === item.code &&
            old.location === item.location,
        ),
    );

    // The heuristic evaluation is only a preliminary gate.
    const accepted =
      issueResolved && newErrors.length === 0;

    return {
      script: accepted ? candidate : script,
      accepted,
      reason: accepted
        ? "Target issue resolved by heuristic checks"
        : "Target issue remains or new errors detected",
      originalNarration,
      proposedNarration,
      issue,
      llmCalls: 1,
    };
  }
}
