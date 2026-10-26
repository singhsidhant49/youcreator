import { z } from "zod";

const API_URL =
  "https://api.deepseek.com/chat/completions";

const ResponseSchema = z.object({
  model: z.string(),
  choices: z.array(
    z.object({
      finish_reason: z.string().nullable(),
      message: z.object({
        content: z.string().nullable(),
      }),
    }),
  ).min(1),

  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }).optional(),
});

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export class DeepSeekAPIError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "DeepSeekAPIError";
  }
}

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export class DeepSeekClient {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: DeepSeekOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("DeepSeek API key is required");
    }

    this.model = options.model ?? "deepseek-flash";
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.fetcher = options.fetcher ?? fetch;
  }

  async generate(
    messages: LLMMessage[],
    options: {
      maxTokens?: number;
      jsonMode?: boolean;
    } = {},
  ): Promise<LLMResponse> {
    if (messages.length === 0) {
      throw new Error("At least one message is required");
    }

    let response: Response;

    try {
      response = await this.fetcher(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          thinking: { type: "disabled" },
          max_tokens: options.maxTokens ?? 4096,
          ...(options.jsonMode
            ? {
                response_format: {
                  type: "json_object",
                },
              }
            : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DeepSeekAPIError(
        error instanceof Error
          ? `DeepSeek request failed: ${error.name}`
          : "DeepSeek request failed",
      );
    }

    if (!response.ok) {
      throw new DeepSeekAPIError(
        `DeepSeek returned HTTP ${response.status}`,
        response.status,
      );
    }

    let data: z.infer<typeof ResponseSchema>;

    try {
      data = ResponseSchema.parse(await response.json());
    } catch {
      throw new DeepSeekAPIError(
        "Invalid DeepSeek API response",
      );
    }

    const choice = data.choices[0];

    if (choice.finish_reason !== "stop") {
      throw new DeepSeekAPIError(
        `DeepSeek completion did not finish normally: ${choice.finish_reason}`,
      );
    }

    const content = choice.message.content;

    if (!content?.trim()) {
      throw new DeepSeekAPIError(
        "DeepSeek returned empty content",
      );
    }

    return {
      text: content,
      model: data.model,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }
}
