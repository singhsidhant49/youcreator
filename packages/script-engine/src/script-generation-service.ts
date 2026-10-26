import {
  BudgetedLLM,
  type LLMBudgetOptions,
  type LLMBudgetUsage,
  type LLMProvider,
} from "@youcreator/llm";

import type {
  VideoBriefInput,
  VideoScript,
} from "@youcreator/contracts";

import {
  ScriptAssembler,
  type AssembledScriptResult,
  type ScriptAssemblerOptions,
} from "./script-assembler.js";

import {
  EditorialRevisionOrchestrator,
  type EditorialOrchestratorOptions,
  type EditorialOrchestrationResult,
} from "./editorial-revision-orchestrator.js";

import {
  promoteScriptCandidate,
  validateScriptCandidate,
  type CandidatePolicy,
  type CandidateValidation,
  type ScriptMetrics,
} from "./script-candidate.js";

import {
  evaluateEditorialQuality,
  type EditorialQualityReport,
} from "./editorial-quality.js";

import {
  createEditorialNarrativePlan,
  type EditorialNarrativePlan,
  type NarrativeProfile,
} from "./editorial-narrative-plan.js";

export interface ScriptPromotionOptions {
  enabled?: boolean;
  policy?: CandidatePolicy;
}

export interface ScriptPromotionResult {
  promoted: boolean;
  reason: string;
  validation?: CandidateValidation;
}

export interface SelectedScriptResult {
  finalScript: VideoScript;
  finalMetrics: ScriptMetrics;
  finalEditorialQuality: EditorialQualityReport;
  promotion: ScriptPromotionResult;
}

export interface ScriptGenerationServiceOptions {
  budget: LLMBudgetOptions;

  assembler?: Omit<
    ScriptAssemblerOptions,
    "cacheModelKey"
  >;

  cacheModelKey?: string;

  editorialRevisions?: EditorialOrchestratorOptions;

  promotion?: ScriptPromotionOptions;

  narrativePlan?: EditorialNarrativePlan;
}

export interface ScriptGenerationServiceResult
  extends AssembledScriptResult {
  llmUsage: LLMBudgetUsage;

  // A separately evaluated candidate.
  // The original script remains in result.script.
  editorialRevision?: EditorialOrchestrationResult;

  finalScript: VideoScript;
  finalMetrics: ScriptMetrics;
  finalEditorialQuality: EditorialQualityReport;
  promotion: ScriptPromotionResult;
}

export class ScriptGenerationService {
  private readonly budgetedLLM: BudgetedLLM;

  private readonly assembler: ScriptAssembler;

  private readonly editorialOrchestrator:
    EditorialRevisionOrchestrator;

  private readonly options:
    ScriptGenerationServiceOptions;

  constructor(
    provider: LLMProvider,
    options: ScriptGenerationServiceOptions,
  ) {
    this.options = options;

    // One budget controller for all LLM operations.
    this.budgetedLLM = new BudgetedLLM(
      provider,
      options.budget,
    );

    this.assembler = new ScriptAssembler(
      this.budgetedLLM,
      {
        ...options.assembler,
        cacheModelKey: options.cacheModelKey,
      },
    );

    this.editorialOrchestrator =
      new EditorialRevisionOrchestrator(
        this.budgetedLLM,
      );
  }

  private selectFinalScript(
    result: AssembledScriptResult,
    editorialRevision?: EditorialOrchestrationResult,
  ): SelectedScriptResult {
    const policy = this.options.promotion?.policy;

    const buildMetrics = (
      script: VideoScript,
    ): ScriptMetrics => {
      const narration = [
        script.hook,
        ...script.sections.map(
          (section) => section.narration,
        ),
        script.outro,
      ].join(" ");

      const words = narration
        .trim()
        .split(/\s+/u)
        .filter(Boolean).length;

      const wpm = policy?.wordsPerMinute ?? 135;

      return {
        words,
        estimatedDurationSeconds: (words / wpm) * 60,
      };
    };

    const originalSelection = (
      reason: string,
      validation?: CandidateValidation,
    ): SelectedScriptResult => ({
      finalScript: structuredClone(result.script),
      finalMetrics: buildMetrics(result.script),
      finalEditorialQuality: evaluateEditorialQuality(
        result.script,
        policy?.editorial,
      ),
      promotion: {
        promoted: false,
        reason,
        validation,
      },
    });

    if (this.options.promotion?.enabled !== true) {
      return originalSelection("Promotion disabled");
    }

    if (!editorialRevision) {
      return originalSelection(
        "No editorial revision candidate available",
      );
    }

    if (editorialRevision.acceptedRevisions === 0) {
      return originalSelection(
        "No accepted editorial revisions",
      );
    }

    const validation = validateScriptCandidate(
      result.script,
      editorialRevision.script,
      policy,
    );

    if (!validation.eligible) {
      return originalSelection(
        `Candidate rejected: ${validation.reasons.join("; ")}`,
        validation,
      );
    }

    const promoted = promoteScriptCandidate(
      result.script,
      editorialRevision.script,
      policy,
    );

    return {
      finalScript: promoted.script,
      finalMetrics: promoted.metrics,
      finalEditorialQuality:
        validation.candidateEditorial,
      promotion: {
        promoted: true,
        reason: "Candidate passed promotion validation",
        validation,
      },
    };
  }

  async generate(
    brief: VideoBriefInput,
    callOptions?: { narrativePlan?: EditorialNarrativePlan },
  ): Promise<ScriptGenerationServiceResult> {
    const profile = (brief as any).profile as NarrativeProfile | undefined;
    const narrativePlan =
      callOptions?.narrativePlan ??
      (brief as any).narrativePlan ??
      this.options.narrativePlan ??
      (profile
        ? createEditorialNarrativePlan({
            topic: brief.topic,
            profile,
            targetDurationSeconds: brief.durationSeconds,
            wordsPerMinute: (brief as any).wordsPerMinute ?? 135,
          })
        : undefined);

    const result = await this.assembler.assemble(
      brief,
      narrativePlan ? { narrativePlan } : undefined,
    );

    let editorialRevision:
      | EditorialOrchestrationResult
      | undefined;

    if (
      this.options.editorialRevisions?.enabled === true
    ) {
      editorialRevision =
        await this.editorialOrchestrator.improve(
          result.script,
          this.options.editorialRevisions,
        );
    }

    const selected = this.selectFinalScript(
      result,
      editorialRevision,
    );

    return {
      ...result,
      editorialRevision,
      ...selected,
      llmUsage: this.budgetedLLM.getUsage(),
    };
  }

  getUsage(): LLMBudgetUsage {
    return this.budgetedLLM.getUsage();
  }
}
