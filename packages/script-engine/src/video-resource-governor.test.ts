import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  VideoResourceGovernor,
} from "./video-resource-governor.js";

import {
  createResourceAwareVideoRunner,
  createDefaultResourceProfiles,
} from "./resource-aware-video-runner.js";

const capacity = {
  cpuUnits: 4,
  memoryMb: 4096,
  aiSlots: 2,
};

describe("M9.6 resource management", () => {
  it("reserves and releases capacity", async () => {
    const governor =
      new VideoResourceGovernor(capacity);

    const release = await governor.acquire({
      cpuUnits: 2,
      memoryMb: 2048,
      aiSlots: 1,
    });

    expect(governor.snapshot().used).toEqual({
      cpuUnits: 2,
      memoryMb: 2048,
      aiSlots: 1,
    });

    release();

    expect(governor.snapshot().used.cpuUnits)
      .toBe(0);
  });

  it("never exceeds capacity", async () => {
    const governor =
      new VideoResourceGovernor(capacity);

    const first = await governor.acquire({
      cpuUnits: 4,
      memoryMb: 4096,
      aiSlots: 2,
    });

    let acquired = false;

    const second = governor.acquire({
      cpuUnits: 1,
      memoryMb: 512,
      aiSlots: 0,
    }).then((release) => {
      acquired = true;
      return release;
    });

    await Promise.resolve();

    expect(acquired).toBe(false);
    expect(governor.snapshot().waiting).toBe(1);

    first();

    const releaseSecond = await second;

    expect(acquired).toBe(true);
    releaseSecond();
  });

  it("rejects demand exceeding total capacity", async () => {
    const governor =
      new VideoResourceGovernor(capacity);

    await expect(
      governor.acquire({
        cpuUnits: 5,
        memoryMb: 1024,
        aiSlots: 1,
      }),
    ).rejects.toThrow(
      "M9 job resource demand exceeds capacity",
    );
  });

  it("releases reservations after execution failure", async () => {
    const governor =
      new VideoResourceGovernor(capacity);

    await expect(
      governor.withResources(
        {
          cpuUnits: 2,
          memoryMb: 1024,
          aiSlots: 1,
        },
        async () => {
          throw new Error("Render failure");
        },
      ),
    ).rejects.toThrow("Render failure");

    expect(governor.snapshot().used).toEqual({
      cpuUnits: 0,
      memoryMb: 0,
      aiSlots: 0,
    });
  });

  it("rejects double release", async () => {
    const governor =
      new VideoResourceGovernor(capacity);

    const release = await governor.acquire({
      cpuUnits: 1,
      memoryMb: 512,
      aiSlots: 0,
    });

    release();

    expect(() => release()).toThrow(
      "M9 resource reservation released twice",
    );
  });

  it("preserves FIFO scheduling", async () => {
    const governor =
      new VideoResourceGovernor(capacity);

    const full = await governor.acquire({
      cpuUnits: 4,
      memoryMb: 4096,
      aiSlots: 2,
    });

    const granted: string[] = [];

    const first = governor.acquire({
      cpuUnits: 3,
      memoryMb: 3072,
      aiSlots: 1,
    }).then((release) => {
      granted.push("first");
      return release;
    });

    const second = governor.acquire({
      cpuUnits: 1,
      memoryMb: 512,
      aiSlots: 0,
    }).then((release) => {
      granted.push("second");
      return release;
    });

    full();

    const releaseFirst = await first;
    const releaseSecond = await second;

    expect(granted).toEqual([
      "first",
      "second",
    ]);

    releaseFirst();
    releaseSecond();
  });

  it("resolves resource profiles independently", () => {
    const profiles =
      createDefaultResourceProfiles();

    const resolved = profiles.resolve({
      jobId: "test",
      topic: "AI",
      profileId: "story",
    });

    expect(resolved.memoryMb).toBe(4096);
  });

  it("rejects unknown resource profiles", () => {
    const profiles =
      createDefaultResourceProfiles();

    expect(() =>
      profiles.resolve({
        jobId: "test",
        topic: "AI",
        profileId: "unknown",
      }),
    ).toThrow(
      "M9 unknown resource profile",
    );
  });

  it("executes an existing runner with resource reservations", async () => {
    const governor =
      new VideoResourceGovernor(capacity);

    const execute = vi.fn(async () => ({
      exportHash: "a".repeat(64),
    }));

    const runner =
      createResourceAwareVideoRunner(
        { run: execute },
        governor,
        createDefaultResourceProfiles(),
      );

    await runner.run({
      jobId: "job-1",
      topic: "Technology",
      profileId: "explainer",
    });

    expect(execute).toHaveBeenCalledOnce();

    expect(governor.snapshot().used).toEqual({
      cpuUnits: 0,
      memoryMb: 0,
      aiSlots: 0,
    });
  });
});
