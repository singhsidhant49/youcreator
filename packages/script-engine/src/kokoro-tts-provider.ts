import {
  createNarrationAudio,
  type NarrationAudio,
} from "./narration-audio-contract.js";

export interface KokoroTtsConfig {
  baseUrl: string;
  model?: string;
  voice?: string;
  speed?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface KokoroSpeechRequest {
  input: string;
  voice?: string;
  speed?: number;
}

export interface KokoroSpeechResult {
  bytes: Buffer;
  audio: NarrationAudio;
}

export type KokoroFetch = typeof fetch;

export function normalizeStreamingWavHeader(bytes: Buffer): Buffer {
  if (
    bytes.length >= 44 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WAVE"
  ) {
    if (bytes.readUInt32LE(4) === 0xffffffff) {
      bytes.writeUInt32LE(bytes.length - 8, 4);
    }

    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkId = bytes.toString("ascii", offset, offset + 4);
      const chunkLen = bytes.readUInt32LE(offset + 4);

      if (chunkId === "data" && chunkLen === 0xffffffff) {
        const actualDataLen = bytes.length - (offset + 8);
        bytes.writeUInt32LE(actualDataLen, offset + 4);
        break;
      }

      offset += 8 + chunkLen + (chunkLen % 2);
    }
  }

  return bytes;
}

export class KokoroTtsProvider {
  private readonly config: Required<KokoroTtsConfig>;

  constructor(
    config: KokoroTtsConfig,
    private readonly http: KokoroFetch = fetch,
  ) {
    const url = new URL(config.baseUrl);

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid Kokoro endpoint");
    }

    if (
      !Number.isFinite(config.speed ?? 0.9) ||
      (config.speed ?? 0.9) <= 0
    ) {
      throw new Error("Invalid Kokoro speed");
    }

    this.config = {
      baseUrl: url.toString(),
      model: config.model ?? "kokoro",
      voice: config.voice ?? "af_bella",
      speed: config.speed ?? 0.9,
      timeoutMs: config.timeoutMs ?? 120_000,
      maxResponseBytes:
        config.maxResponseBytes ??
        50 * 1024 * 1024,
    };

    if (
      !Number.isSafeInteger(this.config.timeoutMs) ||
      this.config.timeoutMs <= 0 ||
      !Number.isSafeInteger(
        this.config.maxResponseBytes,
      ) ||
      this.config.maxResponseBytes <= 0
    ) {
      throw new Error("Invalid Kokoro resource limits");
    }
  }

  async synthesize(
    jobId: string,
    request: KokoroSpeechRequest,
  ): Promise<KokoroSpeechResult> {
    if (!jobId.trim() || !request.input.trim()) {
      throw new Error(
        "Kokoro requires a job ID and narration text",
      );
    }

    const speed =
      request.speed ?? this.config.speed;

    if (!Number.isFinite(speed) || speed <= 0) {
      throw new Error("Invalid Kokoro speed");
    }

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const endpoint = new URL(
        "v1/audio/speech",
        this.config.baseUrl.endsWith("/")
          ? this.config.baseUrl
          : `${this.config.baseUrl}/`,
      );

      const response = await this.http(
        endpoint.toString(),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "audio/wav",
          },
          body: JSON.stringify({
            model: this.config.model,
            input: request.input,
            voice:
              request.voice ?? this.config.voice,
            response_format: "wav",
            speed,
          }),
          signal: controller.signal,
          redirect: "error",
        },
      );

      if (!response.ok) {
        throw new Error(
          `Kokoro synthesis failed: HTTP ${response.status}`,
        );
      }

      if (!response.body) {
        throw new Error(
          "Kokoro returned an empty response body",
        );
      }

      const declaredLength = Number(
        response.headers.get("content-length"),
      );

      if (
        Number.isFinite(declaredLength) &&
        declaredLength >
          this.config.maxResponseBytes
      ) {
        await response.body.cancel();

        throw new Error(
          "Kokoro response exceeds byte limit",
        );
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          total += value.byteLength;

          if (
            total >
            this.config.maxResponseBytes
          ) {
            await reader.cancel();

            throw new Error(
              "Kokoro response exceeds byte limit",
            );
          }

          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      const rawBytes = Buffer.concat(
        chunks.map((chunk) =>
          Buffer.from(chunk),
        ),
        total,
      );

      const bytes = normalizeStreamingWavHeader(rawBytes);

      // Parse real audio bytes, including sample count
      // and PCM WAV structure. Never trust MIME alone.
      const audio = createNarrationAudio(
        jobId,
        bytes,
      );

      return { bytes, audio };
    } finally {
      clearTimeout(timeout);
    }
  }
}
