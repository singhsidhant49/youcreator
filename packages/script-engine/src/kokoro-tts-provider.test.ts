import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  KokoroTtsProvider,
} from "./kokoro-tts-provider.js";

function wavFixture(
  samples = 24000,
): Buffer {
  const bytes = Buffer.alloc(
    44 + samples * 2,
  );

  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(
    bytes.length - 8,
    4,
  );

  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");

  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);

  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28);

  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);

  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(
    samples * 2,
    40,
  );

  return bytes;
}

describe("Kokoro TTS provider", () => {
  it("sends the correct Kokoro speech request", async () => {
    const http = vi.fn(async () =>
      new Response(
        new Uint8Array(wavFixture()),
        { status: 200 },
      ),
    );

    const provider = new KokoroTtsProvider(
      {
        baseUrl:
          "http://192.168.29.39:8880",
      },
      http as typeof fetch,
    );

    const result = await provider.synthesize(
      "job-m6",
      {
        input: "Hello from YouCreator.",
      },
    );

    expect(http).toHaveBeenCalledOnce();

    const [url, init] =
      http.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];

    expect(url).toBe(
      "http://192.168.29.39:8880/v1/audio/speech",
    );

    expect(JSON.parse(init.body as string))
      .toEqual({
        model: "kokoro",
        input: "Hello from YouCreator.",
        voice: "af_bella",
        response_format: "wav",
        speed: 0.9,
      });

    expect(result.audio.durationSeconds)
      .toBe(1);
    expect(result.audio.sampleRate)
      .toBe(24000);
  });

  it("rejects an HTTP synthesis failure", async () => {
    const http = vi.fn(async () =>
      new Response("error", {
        status: 500,
      }),
    );

    const provider = new KokoroTtsProvider(
      { baseUrl: "http://localhost:8880" },
      http as typeof fetch,
    );

    await expect(
      provider.synthesize("job-m6", {
        input: "Hello",
      }),
    ).rejects.toThrow(
      "HTTP 500",
    );

    expect(http).toHaveBeenCalledOnce();
  });

  it("rejects an invalid WAV response", async () => {
    const provider = new KokoroTtsProvider(
      { baseUrl: "http://localhost:8880" },
      (async () =>
        new Response(
          "not a WAV file",
          { status: 200 },
        )) as typeof fetch,
    );

    await expect(
      provider.synthesize("job-m6", {
        input: "Hello",
      }),
    ).rejects.toThrow();
  });

  it("enforces the response byte limit", async () => {
    const provider = new KokoroTtsProvider(
      {
        baseUrl: "http://localhost:8880",
        maxResponseBytes: 100,
      },
      (async () =>
        new Response(
          new Uint8Array(wavFixture()),
          { status: 200 },
        )) as typeof fetch,
    );

    await expect(
      provider.synthesize("job-m6", {
        input: "Hello",
      }),
    ).rejects.toThrow(
      "exceeds byte limit",
    );
  });
});
