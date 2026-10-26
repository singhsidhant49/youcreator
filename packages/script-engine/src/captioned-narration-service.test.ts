import {
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createNarrationAudio,
} from "./narration-audio-contract.js";

import {
  createNarrationWordAlignment,
} from "./narration-alignment-contract.js";

import {
  type KokoroCaptionedRequest,
  type KokoroCaptionedResult,
  type KokoroCaptionedTtsProvider,
} from "./kokoro-captioned-tts-provider.js";

import {
  CaptionedNarrationCheckpointSchema,
  createCaptionedNarrationRequestIdentity,
} from "./captioned-narration-contract.js";

import {
  getPersistedCaptionedNarrationPaths,
  PersistentCaptionedNarrationStore,
} from "./persistent-captioned-narration.js";

import {
  CaptionedNarrationService,
} from "./captioned-narration-service.js";

const JOB_ID = "job-m6-captioned-persistence";
const SCRIPT = "Hello world. This is YouCreator.";

function wavFixture(
  sampleFrames = 72000,
  sampleRate = 24000,
): Buffer {
  const dataBytes = sampleFrames * 2;
  const bytes = Buffer.alloc(44 + dataBytes);

  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");

  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);

  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);

  return bytes;
}

function timestampsFixture() {
  return [
    { word: "Hello", start_time: 0.041, end_time: 0.391 },
    { word: "world", start_time: 0.391, end_time: 0.966 },
    { word: ".", start_time: 0.966, end_time: 1.128 },
    { word: "This", start_time: 1.128, end_time: 1.341 },
    { word: "is", start_time: 1.341, end_time: 1.491 },
    { word: "YouCreator", start_time: 1.491, end_time: 2.541 },
    { word: ".", start_time: 2.541, end_time: 2.766 },
  ];
}

function createMockProvider(overrides?: Partial<KokoroCaptionedResult>) {
  const synthesize = vi.fn(
    async (request: KokoroCaptionedRequest): Promise<KokoroCaptionedResult> => {
      const audioBytes = wavFixture();
      const audio = createNarrationAudio(request.jobId, audioBytes);
      const alignment = createNarrationWordAlignment({
        scriptText: request.input,
        audio,
        timestamps: timestampsFixture(),
      });

      return {
        audioBytes,
        audio,
        alignment,
        ...overrides,
      };
    },
  );

  return {
    synthesize,
  } as unknown as KokoroCaptionedTtsProvider & {
    synthesize: ReturnType<typeof vi.fn>;
  };
}

describe("Captioned narration persistence and safe generation service", () => {
  let root: string | undefined;

  async function fixture() {
    root = await mkdtemp(
      path.join(os.tmpdir(), "youcreator-captioned-narration-"),
    );

    const jobDirectory = (jobId: string) => path.join(root!, "jobs", jobId);
    const store = new PersistentCaptionedNarrationStore(jobDirectory);
    const provider = createMockProvider();
    const service = new CaptionedNarrationService({
      provider,
      store,
      jobDirectory,
      defaultVoice: "af_bella",
      defaultSpeed: 0.9,
    });

    return {
      root,
      jobDirectory,
      store,
      provider,
      service,
    };
  }

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("synthesizes, verifies, and persists captioned narration atomically", async () => {
    const { service, provider, jobDirectory } = await fixture();

    const result = await service.generate({
      jobId: JOB_ID,
      input: SCRIPT,
    });

    expect(result.reused).toBe(false);
    expect(provider.synthesize).toHaveBeenCalledOnce();

    const paths = getPersistedCaptionedNarrationPaths(
      jobDirectory(JOB_ID),
      JOB_ID,
    );

    // Verify all four persisted files exist
    const attempt = JSON.parse(await readFile(paths.attemptPath, "utf8"));
    expect(attempt.state).toBe("started");
    expect(attempt.jobId).toBe(JOB_ID);

    const savedWav = await readFile(paths.audioPath);
    expect(savedWav.length).toBe(result.audioBytes.length);

    const savedAlignment = JSON.parse(await readFile(paths.alignmentPath, "utf8"));
    expect(savedAlignment.alignmentHash).toBe(result.alignment.alignmentHash);

    const savedManifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
    expect(savedManifest.manifestHash).toBe(result.manifest.manifestHash);
    expect(savedManifest.audioSha256).toBe(result.manifest.audioSha256);
    expect(savedManifest.alignmentHash).toBe(result.manifest.alignmentHash);

    // Checkpoint verification
    const checkpoint = CaptionedNarrationCheckpointSchema.parse(result.checkpoint);
    expect(checkpoint.jobId).toBe(JOB_ID);
    expect(checkpoint.manifestHash).toBe(result.manifest.manifestHash);
    expect(checkpoint.wordCount).toBe(7);
  });

  it("reuses existing verified captioned narration with zero TTS calls", async () => {
    const { service, provider } = await fixture();

    const first = await service.generate({
      jobId: JOB_ID,
      input: SCRIPT,
    });

    const second = await service.generate({
      jobId: JOB_ID,
      input: SCRIPT,
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.audioBytes).toEqual(first.audioBytes);
    expect(second.alignment).toEqual(first.alignment);

    // Kokoro synthesis called strictly once
    expect(provider.synthesize).toHaveBeenCalledOnce();
  });

  it("rejects request identity mismatch when voice, speed, or script drift", async () => {
    const { service, provider } = await fixture();

    await service.generate({
      jobId: JOB_ID,
      input: SCRIPT,
      voice: "af_bella",
      speed: 0.9,
    });

    expect(provider.synthesize).toHaveBeenCalledOnce();

    // Voice drift
    await expect(
      service.generate({
        jobId: JOB_ID,
        input: SCRIPT,
        voice: "af_sky",
        speed: 0.9,
      }),
    ).rejects.toThrow("Captioned narration request identity mismatch");

    // Speed drift
    await expect(
      service.generate({
        jobId: JOB_ID,
        input: SCRIPT,
        voice: "af_bella",
        speed: 1.1,
      }),
    ).rejects.toThrow("Captioned narration request identity mismatch");

    // Script drift
    await expect(
      service.generate({
        jobId: JOB_ID,
        input: "Different narration script.",
        voice: "af_bella",
        speed: 0.9,
      }),
    ).rejects.toThrow("Captioned narration request identity mismatch");

    // No additional TTS synthesis calls were made
    expect(provider.synthesize).toHaveBeenCalledOnce();
  });

  it("rejects interrupted attempt and prevents automatic repeat synthesis", async () => {
    const { service, provider, jobDirectory } = await fixture();

    const paths = getPersistedCaptionedNarrationPaths(
      jobDirectory(JOB_ID),
      JOB_ID,
    );

    const { mkdir } = await import("node:fs/promises");
    await mkdir(paths.directory, { recursive: true });

    const requestIdentity = createCaptionedNarrationRequestIdentity({
      jobId: JOB_ID,
      input: SCRIPT,
    });

    // Simulate an earlier interrupted attempt (e.g. process crash or timeout)
    await writeFile(
      paths.attemptPath,
      JSON.stringify({
        version: 1,
        jobId: JOB_ID,
        requestHash: requestIdentity.requestHash,
        state: "started",
      }),
    );

    await expect(
      service.generate({
        jobId: JOB_ID,
        input: SCRIPT,
      }),
    ).rejects.toThrow(
      "Captioned narration attempt already exists; manual recovery required",
    );

    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it("rejects incomplete publication where commit manifest is missing", async () => {
    const { service, store, jobDirectory } = await fixture();

    const saved = await service.generate({
      jobId: JOB_ID,
      input: SCRIPT,
    });

    const paths = getPersistedCaptionedNarrationPaths(
      jobDirectory(JOB_ID),
      JOB_ID,
    );

    // Remove the commit manifest to simulate an interrupted write before commit
    await unlink(paths.manifestPath);

    await expect(store.load(JOB_ID)).rejects.toThrow(
      "Incomplete persisted captioned narration publication: commit manifest missing",
    );

    await expect(
      store.save(
        saved.manifest.request,
        saved.audioBytes,
        saved.alignment,
      ),
    ).rejects.toThrow(
      "Incomplete persisted captioned narration publication: commit manifest missing",
    );

    expect(await service.validate(JOB_ID, saved.manifest.manifestHash)).toBe(
      false,
    );
  });

  it("rejects incomplete publication where audio or alignment payload is missing", async () => {
    const { service, store, jobDirectory } = await fixture();

    await service.generate({
      jobId: JOB_ID,
      input: SCRIPT,
    });

    const paths = getPersistedCaptionedNarrationPaths(
      jobDirectory(JOB_ID),
      JOB_ID,
    );

    // Missing audio
    await unlink(paths.audioPath);
    await expect(store.load(JOB_ID)).rejects.toThrow(
      "Incomplete persisted captioned narration publication: payload missing",
    );

    // Restore audio and remove alignment
    await writeFile(paths.audioPath, wavFixture());
    await unlink(paths.alignmentPath);
    await expect(store.load(JOB_ID)).rejects.toThrow(
      "Incomplete persisted captioned narration publication: payload missing",
    );
  });

  it("rejects corrupted audio or alignment data and tampered manifest", async () => {
    const { service, store, jobDirectory } = await fixture();

    const saved = await service.generate({
      jobId: JOB_ID,
      input: SCRIPT,
    });

    const paths = getPersistedCaptionedNarrationPaths(
      jobDirectory(JOB_ID),
      JOB_ID,
    );

    // Corrupt audio bytes
    await writeFile(paths.audioPath, Buffer.from("corrupted-bytes"));
    expect(await service.validate(JOB_ID, saved.manifest.manifestHash)).toBe(
      false,
    );
    await expect(store.load(JOB_ID)).rejects.toThrow();

    // Restore audio and tamper manifest
    await writeFile(paths.audioPath, saved.audioBytes);
    const tamperedManifest = {
      ...saved.manifest,
      manifestHash: "0".repeat(64),
    };
    await writeFile(paths.manifestPath, JSON.stringify(tamperedManifest));
    await expect(store.load(JOB_ID)).rejects.toThrow(
      "Captioned narration manifest integrity mismatch",
    );
  });

  it("supports concurrent saves of identical package safely", async () => {
    const { store } = await fixture();

    const requestIdentity = createCaptionedNarrationRequestIdentity({
      jobId: JOB_ID,
      input: SCRIPT,
    });

    const audioBytes = wavFixture();
    const audio = createNarrationAudio(JOB_ID, audioBytes);
    const alignment = createNarrationWordAlignment({
      scriptText: SCRIPT,
      audio,
      timestamps: timestampsFixture(),
    });

    const [first, second] = await Promise.all([
      store.save(requestIdentity, audioBytes, alignment),
      store.save(requestIdentity, audioBytes, alignment),
    ]);

    expect(first.manifest.manifestHash).toBe(second.manifest.manifestHash);
    expect(first.audioBytes).toEqual(second.audioBytes);
  });

  it("rejects concurrent save of conflicting package", async () => {
    const { store } = await fixture();

    const requestIdentity = createCaptionedNarrationRequestIdentity({
      jobId: JOB_ID,
      input: SCRIPT,
    });

    const audioBytesA = wavFixture(72000);
    const audioA = createNarrationAudio(JOB_ID, audioBytesA);
    const alignmentA = createNarrationWordAlignment({
      scriptText: SCRIPT,
      audio: audioA,
      timestamps: timestampsFixture(),
    });

    await store.save(requestIdentity, audioBytesA, alignmentA);

    const timestampsB = [
      { word: "Hello", start_time: 0.02, end_time: 0.25 },
      { word: "world", start_time: 0.25, end_time: 0.6 },
      { word: ".", start_time: 0.6, end_time: 0.7 },
      { word: "This", start_time: 0.7, end_time: 0.9 },
      { word: "is", start_time: 0.9, end_time: 1.0 },
      { word: "YouCreator", start_time: 1.0, end_time: 1.8 },
      { word: ".", start_time: 1.8, end_time: 1.95 },
    ];

    const audioBytesB = wavFixture(48000);
    const audioB = createNarrationAudio(JOB_ID, audioBytesB);
    const alignmentB = createNarrationWordAlignment({
      scriptText: SCRIPT,
      audio: audioB,
      timestamps: timestampsB,
    });

    await expect(
      store.save(requestIdentity, audioBytesB, alignmentB),
    ).rejects.toThrow("Conflicting persisted captioned narration");
  });

  it("validates checkpoint metadata for M1 compatibility", async () => {
    const { service } = await fixture();

    const result = await service.generate({
      jobId: JOB_ID,
      input: SCRIPT,
    });

    // validate() returns true for matching manifest hash
    expect(
      await service.validate(JOB_ID, result.manifest.manifestHash),
    ).toBe(true);

    // validate() returns false for mismatched manifest hash
    expect(
      await service.validate(JOB_ID, "f".repeat(64)),
    ).toBe(false);

    // validate() returns false for unknown job
    expect(
      await service.validate("unknown-job", result.manifest.manifestHash),
    ).toBe(false);

    // getCheckpoint() returns schema-conforming checkpoint metadata
    const checkpoint = await service.getCheckpoint(JOB_ID);
    expect(checkpoint.jobId).toBe(JOB_ID);
    expect(checkpoint.manifestHash).toBe(result.manifest.manifestHash);
    expect(checkpoint.audioSha256).toBe(result.manifest.audioSha256);
    expect(checkpoint.alignmentHash).toBe(result.manifest.alignmentHash);
    expect(checkpoint.durationSeconds).toBe(3);
    expect(checkpoint.wordCount).toBe(7);
  });
});
