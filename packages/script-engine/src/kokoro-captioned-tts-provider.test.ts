import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  KokoroCaptionedTtsProvider,
} from "./kokoro-captioned-tts-provider.js";

const JOB_ID = "job-m6-captioned";

function wavFixture(): Buffer {
  const sampleRate = 24000;
  const sampleFrames = 72000;

  const bytes = Buffer.alloc(
    44 + sampleFrames * 2,
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
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(
    sampleRate * 2,
    28,
  );
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);

  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(
    sampleFrames * 2,
    40,
  );

  return bytes;
}

function timestamps() {
  return [
    {
      word: "Hello",
      start_time: 0.041,
      end_time: 0.391,
    },
    {
      word: "world",
      start_time: 0.391,
      end_time: 0.966,
    },
    {
      word: ".",
      start_time: 0.966,
      end_time: 1.128,
    },
    {
      word: "This",
      start_time: 1.128,
      end_time: 1.341,
    },
    {
      word: "is",
      start_time: 1.341,
      end_time: 1.491,
    },
    {
      word: "YouCreator",
      start_time: 1.491,
      end_time: 2.541,
    },
    {
      word: ".",
      start_time: 2.541,
      end_time: 2.766,
    },
  ];
}

function captionedResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      audio: wavFixture().toString("base64"),
      audio_format: "wav",
      timestamps: timestamps(),
      ...overrides,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

function provider(http: typeof fetch) {
  return new KokoroCaptionedTtsProvider(
    {
      baseUrl:
        "http://192.168.29.39:8880",
    },
    http,
  );
}

const input =
  "Hello world. This is YouCreator.";

describe("Kokoro native captioned TTS", () => {
  it("generates WAV and alignment in one request", async () => {
    const http = vi.fn(
      async () => captionedResponse(),
    );

    const result = await provider(
      http as typeof fetch,
    ).synthesize({
      jobId: JOB_ID,
      input,
    });

    expect(http).toHaveBeenCalledOnce();

    const [url, options] =
      http.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];

    expect(url).toBe(
      "http://192.168.29.39:8880/dev/captioned_speech",
    );

    expect(
      JSON.parse(options.body as string),
    ).toEqual({
      input,
      voice: "af_bella",
      speed: 0.9,
      stream: false,
      response_format: "wav",
    });

    expect(result.audio.sampleRate).toBe(
      24000,
    );

    expect(result.audio.sampleFrames).toBe(
      72000,
    );

    expect(result.audio.durationSeconds).toBe(
      3,
    );

    expect(result.alignment.words).toHaveLength(
      7,
    );

    expect(result.alignment.audioSha256).toBe(
      result.audio.sha256,
    );
  });

  it("converts real Kokoro timestamps into audio samples", async () => {
    const result = await provider(
      (async () =>
        captionedResponse()) as typeof fetch,
    ).synthesize({
      jobId: JOB_ID,
      input,
    });

    expect(
      result.alignment.words[0]?.startSample,
    ).toBe(984);

    expect(
      result.alignment.words[0]?.endSampleExclusive,
    ).toBe(9384);

    expect(
      result.alignment.words[6]?.endSampleExclusive,
    ).toBe(66384);
  });

  it("rejects missing words without retrying TTS", async () => {
    const http = vi.fn(async () =>
      captionedResponse({
        timestamps: timestamps().slice(0, -1),
      }),
    );

    await expect(
      provider(
        http as typeof fetch,
      ).synthesize({
        jobId: JOB_ID,
        input,
      }),
    ).rejects.toThrow(
      "Narration token coverage mismatch",
    );

    expect(http).toHaveBeenCalledOnce();
  });

  it("rejects token drift", async () => {
    const wrong = timestamps();
    wrong[1]!.word = "planet";

    await expect(
      provider(
        (async () =>
          captionedResponse({
            timestamps: wrong,
          })) as typeof fetch,
      ).synthesize({
        jobId: JOB_ID,
        input,
      }),
    ).rejects.toThrow(
      "Narration token mismatch",
    );
  });

  it("rejects audio-format mismatch", async () => {
    await expect(
      provider(
        (async () =>
          captionedResponse({
            audio_format: "mp3",
          })) as typeof fetch,
      ).synthesize({
        jobId: JOB_ID,
        input,
      }),
    ).rejects.toThrow();
  });

  it("rejects invalid base64 audio", async () => {
    await expect(
      provider(
        (async () =>
          captionedResponse({
            audio: "not-base64!!!",
          })) as typeof fetch,
      ).synthesize({
        jobId: JOB_ID,
        input,
      }),
    ).rejects.toThrow(
      "Invalid Kokoro base64 audio",
    );
  });

  it("rejects responses exceeding the configured byte limit", async () => {
    const http = vi.fn(
      async () => captionedResponse(),
    );

    const limited =
      new KokoroCaptionedTtsProvider(
        {
          baseUrl:
            "http://192.168.29.39:8880",
          maxResponseBytes: 100,
        },
        http as typeof fetch,
      );

    await expect(
      limited.synthesize({
        jobId: JOB_ID,
        input,
      }),
    ).rejects.toThrow(
      "exceeds byte limit",
    );
  });

  it("rejects out-of-bounds audio timing", async () => {
    const invalid = timestamps();

    invalid[6]!.end_time = 3.5;

    await expect(
      provider(
        (async () =>
          captionedResponse({
            timestamps: invalid,
          })) as typeof fetch,
      ).synthesize({
        jobId: JOB_ID,
        input,
      }),
    ).rejects.toThrow(
      "Invalid narration sample bounds",
    );
  });

  it("fails clearly when Kokoro service is unreachable without dummy fallback", async () => {
    const failingHttp = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 192.168.29.39:8880");
    });

    const origEnv = process.env.ALLOW_TEST_TTS_FIXTURE;
    delete process.env.ALLOW_TEST_TTS_FIXTURE;

    try {
      await expect(
        provider(failingHttp as typeof fetch).synthesize({
          jobId: JOB_ID,
          input,
        }),
      ).rejects.toThrow(/Kokoro captioned synthesis failed: provider unreachable/);
    } finally {
      if (origEnv !== undefined) {
        process.env.ALLOW_TEST_TTS_FIXTURE = origEnv;
      }
    }
  });

  it("fails clearly on HTTP 500 error from Kokoro without dummy fallback", async () => {
    const errorHttp = vi.fn(async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    const origEnv = process.env.ALLOW_TEST_TTS_FIXTURE;
    delete process.env.ALLOW_TEST_TTS_FIXTURE;

    try {
      await expect(
        provider(errorHttp as typeof fetch).synthesize({
          jobId: JOB_ID,
          input,
        }),
      ).rejects.toThrow(/Kokoro captioned synthesis failed: HTTP 500/);
    } finally {
      if (origEnv !== undefined) {
        process.env.ALLOW_TEST_TTS_FIXTURE = origEnv;
      }
    }
  });
});

