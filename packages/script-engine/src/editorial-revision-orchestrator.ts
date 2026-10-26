import {
  VideoScriptSchema,
  type VideoScript,
} from "@youcreator/contracts";

import type { LLMGenerator } from "./script-generator.js";

import {
  evaluateEditorialQuality,
  type EditorialIssue,
  type EditorialIssueCode,
  type EditorialQualityOptions,
  type EditorialQualityReport,
} from "./editorial-quality.js";

import {
  EditorialReviser,
} from "./editorial-reviser.js";

export interface EditorialOrchestratorOptions
  extends EditorialQualityOptions {
  maxRevisionCalls?: number;
  enabled?: boolean;
}

export interface EditorialRevisionAudit {
  issue: EditorialIssue;
  accepted: boolean;
  reason: string;
  originalNarration?: string;
  proposedNarration?: string;
}

export interface EditorialOrchestrationResult {
  script: VideoScript;
  before: EditorialQualityReport;
  after: EditorialQualityReport;
  revisionCalls: number;
  acceptedRevisions: number;
  rejectedRevisions: number;
  skippedIssues: EditorialIssue[];
  audit: EditorialRevisionAudit[];
}

const ISSUE_PRIORITY: Record<EditorialIssueCode, number> = {
  WEAK_HOOK: 1,
  GENERIC_OUTRO: 2,
  MISSING_PAYOFF: 3,
  WEAK_SECTION_DEVELOPMENT: 4,
  REDUNDANT_NARRATION: 5,
  POTENTIAL_OVERCLAIM: 6,
  UNSUPPORTED_CLAIM: 7,
  MISSING_EXAMPLE: 8,
};

export class EditorialRevisionOrchestrator {
  private readonly reviser: EditorialReviser;

  constructor(llm: LLMGenerator) {
    this.reviser = new EditorialReviser(llm);
  }

  async improve(
    input: VideoScript,
    options: EditorialOrchestratorOptions = {},
  ): Promise<EditorialOrchestrationResult> {
    const script = VideoScriptSchema.parse(input);

    const maxRevisionCalls =
      options.maxRevisionCalls ?? 2;

    if (
      !Number.isSafeInteger(maxRevisionCalls) ||
      maxRevisionCalls < 0
    ) {
      throw new Error(
        "Invalid maximum editorial revision calls",
      );
    }

    const qualityOptions: EditorialQualityOptions = {
      requireExample: options.requireExample,
      minimumSectionWords: options.minimumSectionWords,
    };

    const before = evaluateEditorialQuality(
      script,
      qualityOptions,
    );

    let currentScript = script;
    let revisionCalls = 0;
    let acceptedRevisions = 0;
    let rejectedRevisions = 0;

    const audit: EditorialRevisionAudit[] = [];
    const skippedIssues: EditorialIssue[] = [];

    if (options.enabled === false) {
      return {
        script: currentScript,
        before,
        after: before,
        revisionCalls,
        acceptedRevisions,
        rejectedRevisions,
        skippedIssues: [...before.issues],
        audit,
      };
    }

    // Freeze the initial candidate list.
    // Re-evaluate before every revision to avoid stale issues.
    const candidates = [...before.issues].sort(
      (a, b) =>
        ISSUE_PRIORITY[a.code] -
        ISSUE_PRIORITY[b.code],
    );

    for (const issue of candidates) {
      // Script-wide issues require planning rather than
      // revising an arbitrary narration segment.
      if (issue.location === "script") {
        skippedIssues.push(issue);
        continue;
      }

      if (revisionCalls >= maxRevisionCalls) {
        skippedIssues.push(issue);
        continue;
      }

      const currentReport = evaluateEditorialQuality(
        currentScript,
        qualityOptions,
      );

      const stillPresent = currentReport.issues.some(
        (item) =>
          item.code === issue.code &&
          item.location === issue.location,
      );

      if (!stillPresent) {
        skippedIssues.push(issue);
        continue;
      }

      // Reserve before making a provider call.
      // A failed call still consumes the local attempt budget.
      revisionCalls++;

      try {
        const result = await this.reviser.revise(
          currentScript,
          issue,
          qualityOptions,
        );

        audit.push({
          issue,
          accepted: result.accepted,
          reason: result.reason,
          originalNarration: result.originalNarration,
          proposedNarration: result.proposedNarration,
        });

        if (result.accepted) {
          currentScript = result.script;
          acceptedRevisions++;
        } else {
          rejectedRevisions++;
        }
      } catch (error) {
        rejectedRevisions++;

        audit.push({
          issue,
          accepted: false,
          reason:
            error instanceof Error
              ? error.message
              : "Unknown revision error",
        });
      }
    }

    return {
      script: currentScript,
      before,
      after: evaluateEditorialQuality(
        currentScript,
        qualityOptions,
      ),
      revisionCalls,
      acceptedRevisions,
      rejectedRevisions,
      skippedIssues,
      audit,
    };
  }
}
