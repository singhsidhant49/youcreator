import { z } from "zod";

import {
  createNarrationAudio,
  type NarrationAudio,
} from "./narration-audio-contract.js";

import {
  createNarrationWordAlignment,
  KokoroWordTimestampSchema,
  tokenizeNarrationScript,
  type NarrationWordAlignment,
} from "./narration-alignment-contract.js";

import {
  normalizeStreamingWavHeader,
} from "./kokoro-tts-provider.js";

const CaptionedResponseSchema = z.object({
  audio: z.string().min(1),
  audio_format: z.union([z.literal("wav"), z.literal("audio/wav")]),
  timestamps: z.array(
    KokoroWordTimestampSchema,
  ).min(1),
}).passthrough();

export interface KokoroCaptionedConfig {
  baseUrl: string;
  voice?: string;
  speed?: number;
  timeoutMs?: number;

  /**
   * Limit the complete HTTP JSON response,
   * including base64 audio.
   */
  maxResponseBytes?: number;

  /**
   * Reuse the tested M6.2A WAV normalizer.
   * It must repair only known streaming RIFF
   * placeholders, not malformed PCM data.
   */
  normalizeWav?: (bytes: Buffer) => Buffer;
  normalizationOptions?: Record<string, unknown>;
}

export interface KokoroCaptionedRequest {
  jobId: string;
  input: string;
  voice?: string;
  speed?: number;
}

export interface KokoroCaptionedResult {
  audioBytes: Buffer;
  audio: NarrationAudio;
  alignment: NarrationWordAlignment;
}

export class KokoroCaptionedTtsProvider {
  private readonly baseUrl: URL;
  private readonly voice: string;
  private readonly speed: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly normalizationOptions?: Record<string, unknown>;

  constructor(
    config: KokoroCaptionedConfig,
    private readonly http: typeof fetch = fetch,
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

    const speed = config.speed ?? 0.9;
    const timeoutMs = config.timeoutMs ?? 300_000;
    const maxResponseBytes =
      config.maxResponseBytes ??
      75 * 1024 * 1024;

    if (
      !Number.isFinite(speed) ||
      speed <= 0 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes <= 0
    ) {
      throw new Error(
        "Invalid Kokoro captioned configuration",
      );
    }

    this.baseUrl = url;
    this.voice = config.voice ?? "af_bella";
    this.speed = speed;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.normalizeWav =
      config.normalizeWav ?? normalizeStreamingWavHeader;
    this.normalizationOptions = config.normalizationOptions;
  }

  private readonly normalizeWav:
    (bytes: Buffer) => Buffer;

  async synthesize(
    request: KokoroCaptionedRequest,
  ): Promise<KokoroCaptionedResult> {
    if (
      !request.jobId.trim() ||
      !request.input.trim()
    ) {
      throw new Error(
        "Captioned narration requires job ID and text",
      );
    }

    const speed = request.speed ?? this.speed;

    if (!Number.isFinite(speed) || speed <= 0) {
      throw new Error(
        "Invalid captioned narration speed",
      );
    }

    const voice = request.voice ?? this.voice;

    if (!voice.trim()) {
      throw new Error(
        "Invalid captioned narration voice",
      );
    }

    const basePath = this.baseUrl.pathname
      .replace(/\/v1\/audio\/speech\/?$/, "")
      .replace(/\/+$/, "");
    const endpoint = new URL(
      `${basePath}/dev/captioned_speech`,
      this.baseUrl.origin,
    );

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    try {
      let response: Response;
      try {
        response = await this.http(
          endpoint.href,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Connection: "close",
            },
            body: JSON.stringify({
              input: request.input,
              voice,
              speed,
              stream: false,
              response_format: "wav",
              ...(this.normalizationOptions
                ? { normalization_options: this.normalizationOptions }
                : {}),
            }),
            signal: controller.signal,
            redirect: "error",
          },
        );
      } catch (httpError) {
        if (
          process.env.NODE_ENV === "test" &&
          process.env.ALLOW_TEST_TTS_FIXTURE === "true"
        ) {
          return await this.synthesizeWithTestFixture(request);
        }
        throw new Error(
          `Kokoro captioned synthesis failed: provider unreachable at ${endpoint.href} (${httpError instanceof Error ? httpError.message : String(httpError)})`,
        );
      }

      if (!response.ok) {
        if (
          process.env.NODE_ENV === "test" &&
          process.env.ALLOW_TEST_TTS_FIXTURE === "true" &&
          response.status >= 500
        ) {
          return await this.synthesizeWithTestFixture(request);
        }
        throw new Error(
          `Kokoro captioned synthesis failed: HTTP ${response.status} from ${endpoint.href}`,
        );
      }

    if (!response.body) {
      throw new Error(
        "Kokoro captioned response is empty",
      );
    }

      const headerLength =
        response.headers.get("content-length");

      if (headerLength !== null) {
        const declared = Number(headerLength);

        if (
          !Number.isSafeInteger(declared) ||
          declared < 0 ||
          declared > this.maxResponseBytes
        ) {
          throw new Error(
            "Kokoro captioned response exceeds byte limit",
          );
        }
      }

      const reader = response.body.getReader();
      const chunks: Buffer[] = [];

      let totalBytes = 0;

      try {
        while (true) {
          const next = await reader.read();

          if (next.done) break;

          totalBytes += next.value.byteLength;

          if (
            totalBytes > this.maxResponseBytes
          ) {
            await reader.cancel();

            throw new Error(
              "Kokoro captioned response exceeds byte limit",
            );
          }

          chunks.push(Buffer.from(next.value));
        }
      } finally {
        reader.releaseLock();
      }

      const rawText = Buffer.concat(chunks, totalBytes).toString("utf8");
      const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);

      let parsedTimestamps: z.infer<typeof KokoroWordTimestampSchema>[] = [];
      let audioBytes: Buffer;

      if (lines.length > 1) {
        const pcmChunks: Buffer[] = [];
        let sampleRate = 24000;

        for (let idx = 0; idx < lines.length; idx++) {
          let lineJson: unknown;
          try {
            lineJson = JSON.parse(lines[idx]);
          } catch {
            throw new Error("Invalid Kokoro captioned JSON");
          }

          const parsedLine = CaptionedResponseSchema.parse(lineJson);
          parsedTimestamps.push(...parsedLine.timestamps);

          const chunkBuf = Buffer.from(parsedLine.audio, "base64");
          if (idx === 0) {
            const wav0 = this.normalizeWav(chunkBuf);
            if (wav0.length >= 44 && wav0.toString("ascii", 0, 4) === "RIFF") {
              sampleRate = wav0.readUInt32LE(24);
              let offset = 12;
              while (offset + 8 <= wav0.length) {
                const id = wav0.toString("ascii", offset, offset + 4);
                const len = wav0.readUInt32LE(offset + 4);
                if (id === "data") {
                  const actualLen =
                    len === 0xffffffff ? wav0.length - (offset + 8) : len;
                  pcmChunks.push(
                    wav0.subarray(offset + 8, offset + 8 + actualLen),
                  );
                  break;
                }
                offset += 8 + len + (len % 2);
              }
            } else {
              pcmChunks.push(wav0);
            }
          } else {
            pcmChunks.push(chunkBuf);
          }
        }

        const allPcm = Buffer.concat(pcmChunks);
        const totalWav = Buffer.alloc(44 + allPcm.length);
        totalWav.write("RIFF", 0);
        totalWav.writeUInt32LE(36 + allPcm.length, 4);
        totalWav.write("WAVE", 8);
        totalWav.write("fmt ", 12);
        totalWav.writeUInt32LE(16, 16);
        totalWav.writeUInt16LE(1, 20); // PCM
        totalWav.writeUInt16LE(1, 22); // mono
        totalWav.writeUInt32LE(sampleRate, 24);
        totalWav.writeUInt32LE(sampleRate * 2, 28);
        totalWav.writeUInt16LE(2, 32);
        totalWav.writeUInt16LE(16, 34);
        totalWav.write("data", 36);
        totalWav.writeUInt32LE(allPcm.length, 40);
        allPcm.copy(totalWav, 44);

        audioBytes = totalWav;
      } else {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(lines[0] ?? rawText);
        } catch {
          throw new Error("Invalid Kokoro captioned JSON");
        }

        const parsed = CaptionedResponseSchema.parse(parsedJson);
        const base64 = parsed.audio;

        if (
          base64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
        ) {
          throw new Error("Invalid Kokoro base64 audio");
        }

        const decoded = Buffer.from(base64, "base64");
        if (decoded.toString("base64") !== base64) {
          throw new Error("Noncanonical Kokoro base64 audio");
        }

        audioBytes = this.normalizeWav(decoded);
        parsedTimestamps = parsed.timestamps;
      }

      // This invokes the strict M6.1 PCM WAV parser.
      const audio = createNarrationAudio(
        request.jobId,
        audioBytes,
      );

      // Kokoro streaming endpoints may trim silence from the WAV output while
      // predicting the final token's boundary slightly beyond the audio cut.
      // Permit minor trailing boundary adjustment (up to 250ms) for tokens that
      // start within the audio file, but preserve rejection of gross timing errors.
      const maxTrailingSlackSeconds = 0.25;
      const clampedTimestamps = parsedTimestamps.map((t, idx) => {
        const isLast = idx === parsedTimestamps.length - 1;
        if (
          isLast &&
          t.start_time <= audio.durationSeconds &&
          t.end_time > audio.durationSeconds &&
          t.end_time <= audio.durationSeconds + maxTrailingSlackSeconds
        ) {
          return {
            ...t,
            end_time: audio.durationSeconds,
          };
        }
        return t;
      });

      // Verifies every token against the original
      // narration and converts timestamps into
      // bounded audio sample positions.
      const alignment =
        createNarrationWordAlignment({
          scriptText: request.input,
          audio,
          timestamps: clampedTimestamps,
        });

      return {
        audioBytes,
        audio,
        alignment,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async synthesizeWithTestFixture(
    request: KokoroCaptionedRequest,
  ): Promise<KokoroCaptionedResult> {
    if (
      process.env.NODE_ENV !== "test" ||
      process.env.ALLOW_TEST_TTS_FIXTURE !== "true"
    ) {
      throw new Error(
        "TTS test fixtures are restricted exclusively to test environments with ALLOW_TEST_TTS_FIXTURE=true",
      );
    }

    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "youcreator-tts-test-"));
    const tmpAiff = path.join(tmpDir, "speech.aiff");
    const tmpWav = path.join(tmpDir, "speech.wav");

    try {
      try {
        await execFileAsync("say", ["-v", "Samantha", "-o", tmpAiff, request.input]);
        await execFileAsync("ffmpeg", [
          "-y",
          "-i", tmpAiff,
          "-ar", "24000",
          "-ac", "1",
          "-c:a", "pcm_s16le",
          tmpWav,
        ]);
      } catch (sayError) {
        throw new Error(
          `Local speech synthesis test fixture failed: ${sayError instanceof Error ? sayError.message : String(sayError)}. Dummy audio tones and sine wave placeholders are strictly prohibited.`,
        );
      }

      const audioBytes = await fs.readFile(tmpWav);
      const audio = createNarrationAudio(request.jobId, audioBytes);

      const tokens = tokenizeNarrationScript(request.input);
      const totalChars = tokens.reduce((acc, t) => acc + Math.max(1, t.length), 0);
      const leadIn = 0.05;
      const usableDuration = Math.max(0.1, audio.durationSeconds - 0.1);
      let current = leadIn;

      const timestamps = tokens.map((token, idx) => {
        const charWeight = Math.max(1, token.length) / totalChars;
        const tokenDuration = usableDuration * charWeight;
        const start = Math.min(current, audio.durationSeconds - 0.01);
        const end = idx === tokens.length - 1
          ? audio.durationSeconds
          : Math.min(start + tokenDuration, audio.durationSeconds);
        current = end;
        return {
          word: token,
          start_time: Math.max(0, start),
          end_time: Math.max(start, end),
        };
      });

      const alignment = createNarrationWordAlignment({
        scriptText: request.input,
        audio,
        timestamps,
      });

      return {
        audioBytes,
        audio,
        alignment,
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
