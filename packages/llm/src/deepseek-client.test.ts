import { describe, expect, it, vi } from "vitest";

import {
  DeepSeekClient,
  DeepSeekAPIError,
} from "./deepseek-client.js";

function mockResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

const successResponse = {
  model: "deepseek-flash",
  choices: [
    {
      finish_reason: "stop",
      message: {
        content: "This is a test response.",
      },
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
  },
};

describe("DeepSeekClient", () => {
  it("rejects a missing API key", () => {
    expect(
      () => new DeepSeekClient({ apiKey: "" }),
    ).toThrow("DeepSeek API key is required");
  });

  it("returns generated content and usage", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => mockResponse(successResponse),
    );

    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetcher,
    });

    const result = await client.generate([
      { role: "user", content: "Write a hook" },
    ]);

    expect(result.text).toBe(
      "This is a test response.",
    );

    expect(result.usage?.totalTokens).toBe(30);
    expect(fetcher).toHaveBeenCalledOnce();

    const request = JSON.parse(
      String(fetcher.mock.calls[0]?.[1]?.body),
    );

    expect(request.model).toBe("deepseek-flash");
  });

  it("supports JSON mode", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => mockResponse(successResponse),
    );

    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetcher,
    });

    await client.generate(
      [{ role: "user", content: "Return JSON" }],
      { jsonMode: true },
    );

    const request = JSON.parse(
      String(fetcher.mock.calls[0]?.[1]?.body),
    );

    expect(request.response_format).toEqual({
      type: "json_object",
    });
  });

  it("rejects API errors", async () => {
    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetcher: async () =>
        mockResponse({ error: "Rate limited" }, 429),
    });

    await expect(
      client.generate([
        { role: "user", content: "Hello" },
      ]),
    ).rejects.toMatchObject({
      name: "DeepSeekAPIError",
      statusCode: 429,
    });
  });

  it("rejects truncated completions", async () => {
    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetcher: async () =>
        mockResponse({
          ...successResponse,
          choices: [
            {
              finish_reason: "length",
              message: { content: "Incomplete" },
            },
          ],
        }),
    });

    await expect(
      client.generate([
        { role: "user", content: "Hello" },
      ]),
    ).rejects.toThrow(
      "did not finish normally",
    );
  });

  it("rejects malformed responses", async () => {
    const client = new DeepSeekClient({
      apiKey: "test-key",
      fetcher: async () =>
        mockResponse({ invalid: true }),
    });

    await expect(
      client.generate([
        { role: "user", content: "Hello" },
      ]),
    ).rejects.toThrow("Invalid DeepSeek API response");
  });
});
