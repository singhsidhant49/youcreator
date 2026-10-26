import type {
  LLMMessage,
  LLMResponse,
} from "./deepseek-client.js";

export interface LLMProvider {
  generate(
    messages: LLMMessage[],
    options?: {
      maxTokens?: number;
      jsonMode?: boolean;
    },
  ): Promise<LLMResponse>;
}

export interface LLMBudgetOptions {
  maxRequests: number;
  maxOutputTokens: number;
  maxTokensPerRequest?: number;
}

export interface LLMBudgetUsage {
  requests: number;
  failedRequests: number;
  reservedOutputTokens: number;
  reportedInputTokens: number;
  reportedOutputTokens: number;
}

export class LLMBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMBudgetExceededError";
  }
}

export class BudgetedLLM implements LLMProvider {
  private usage: LLMBudgetUsage = {
    requests: 0,
    failedRequests: 0,
    reservedOutputTokens: 0,
    reportedInputTokens: 0,
    reportedOutputTokens: 0,
  };

  constructor(
    private readonly provider: LLMProvider,
    private readonly budget: LLMBudgetOptions,
  ) {
    if (
      !Number.isSafeInteger(budget.maxRequests) ||
      budget.maxRequests < 1 ||
      !Number.isSafeInteger(budget.maxOutputTokens) ||
      budget.maxOutputTokens < 1 ||
      (budget.maxTokensPerRequest !== undefined &&
        (!Number.isSafeInteger(budget.maxTokensPerRequest) ||
          budget.maxTokensPerRequest < 1))
    ) {
      throw new Error("Invalid LLM budget configuration");
    }
  }

  async generate(
    messages: LLMMessage[],
    options: {
      maxTokens?: number;
      jsonMode?: boolean;
    } = {},
  ): Promise<LLMResponse> {
    const requestedTokens = options.maxTokens ?? 4096;

    if (
      !Number.isSafeInteger(requestedTokens) ||
      requestedTokens < 1
    ) {
      throw new Error("Invalid requested token limit");
    }

    if (this.usage.requests >= this.budget.maxRequests) {
      throw new LLMBudgetExceededError(
        "LLM request budget exhausted",
      );
    }

    if (
      this.budget.maxTokensPerRequest !== undefined &&
      requestedTokens > this.budget.maxTokensPerRequest
    ) {
      throw new LLMBudgetExceededError(
        "LLM per-request token limit exceeded",
      );
    }

    if (
      this.usage.reservedOutputTokens + requestedTokens >
      this.budget.maxOutputTokens
    ) {
      throw new LLMBudgetExceededError(
        "LLM output token budget exhausted",
      );
    }

    // Reserve the request and output tokens before calling
    // the provider. This also protects concurrent calls.
    this.usage.requests++;
    this.usage.reservedOutputTokens += requestedTokens;

    try {
      const response = await this.provider.generate(
        messages,
        {
          ...options,
          maxTokens: requestedTokens,
        },
      );

      this.usage.reportedInputTokens +=
        response.usage?.inputTokens ?? 0;

      this.usage.reportedOutputTokens +=
        response.usage?.outputTokens ?? 0;

      return response;
    } catch (error) {
      this.usage.failedRequests++;
      throw error;
    }
  }

  getUsage(): LLMBudgetUsage {
    return { ...this.usage };
  }
}
