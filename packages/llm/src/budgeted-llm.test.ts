import { describe, expect, it, vi } from "vitest";

import {
  BudgetedLLM,
  LLMBudgetExceededError,
} from "./budgeted-llm.js";

const messages = [
  { role: "user" as const, content: "Hello" },
];

function mockProvider() {
  return {
    generate: vi.fn(async () => ({
      text: "Generated text",
      model: "test-model",
      usage: {
        inputTokens: 20,
        outputTokens: 40,
        totalTokens: 60,
      },
    })),
  };
}

describe("BudgetedLLM", () => {
  it("allows requests within the budget", async () => {
    const provider = mockProvider();

    const client = new BudgetedLLM(provider, {
      maxRequests: 2,
      maxOutputTokens: 1000,
    });

    await client.generate(messages, {
      maxTokens: 100,
    });

    expect(provider.generate).toHaveBeenCalledOnce();
    expect(client.getUsage().requests).toBe(1);
    expect(client.getUsage().reportedOutputTokens).toBe(40);
  });

  it("blocks requests beyond the request limit", async () => {
    const client = new BudgetedLLM(mockProvider(), {
      maxRequests: 1,
      maxOutputTokens: 1000,
    });

    await client.generate(messages, {
      maxTokens: 100,
    });

    await expect(
      client.generate(messages, {
        maxTokens: 100,
      }),
    ).rejects.toBeInstanceOf(
      LLMBudgetExceededError,
    );
  });

  it("blocks requests exceeding output-token allowance", async () => {
    const provider = mockProvider();

    const client = new BudgetedLLM(provider, {
      maxRequests: 10,
      maxOutputTokens: 150,
    });

    await client.generate(messages, {
      maxTokens: 100,
    });

    await expect(
      client.generate(messages, {
        maxTokens: 100,
      }),
    ).rejects.toThrow(
      "output token budget",
    );

    expect(provider.generate).toHaveBeenCalledOnce();
  });

  it("counts failed provider requests", async () => {
    const client = new BudgetedLLM(
      {
        async generate() {
          throw new Error("Provider unavailable");
        },
      },
      {
        maxRequests: 2,
        maxOutputTokens: 1000,
      },
    );

    await expect(
      client.generate(messages, {
        maxTokens: 100,
      }),
    ).rejects.toThrow(
      "Provider unavailable",
    );

    expect(client.getUsage().requests).toBe(1);
    expect(client.getUsage().failedRequests).toBe(1);
  });

  it("enforces the per-request token limit", async () => {
    const provider = mockProvider();

    const client = new BudgetedLLM(provider, {
      maxRequests: 5,
      maxOutputTokens: 10000,
      maxTokensPerRequest: 2048,
    });

    await expect(
      client.generate(messages, {
        maxTokens: 4096,
      }),
    ).rejects.toThrow(
      "per-request token limit",
    );

    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("returns a defensive usage snapshot", async () => {
    const client = new BudgetedLLM(mockProvider(), {
      maxRequests: 5,
      maxOutputTokens: 1000,
    });

    const snapshot = client.getUsage();
    snapshot.requests = 999;

    expect(client.getUsage().requests).toBe(0);
  });
});
