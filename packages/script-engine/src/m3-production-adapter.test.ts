import { createHash } from "node:crypto";

import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createM3ProductionAdapter,
} from "./m3-production-adapter.js";

type TestPackage = {
  storyboard: {
    title: string;
  };

  mediaPlan: {
    mode: "B";
    shots: Array<{
      shotId: string;
    }>;
  };

  packageHash: string;
};

const HASH = "a".repeat(64);

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function makePackage(): TestPackage {
  return {
    storyboard: {
      title: "Documentary",
    },

    mediaPlan: {
      mode: "B",

      shots: [
        { shotId: "shot-001" },
        { shotId: "shot-002" },
      ],
    },

    packageHash: HASH,
  };
}

function makeEnvelope(pkg = makePackage()) {
  return {
    version: 1 as const,
    jobId: "job-001",
    generationFingerprint: "test",
    sourceScriptHash: HASH,
    package: pkg,
  };
}

function setup() {
  const verifyPackage = vi.fn(
    async (_pkg: TestPackage) => {},
  );

  const adapter = createM3ProductionAdapter({
    parseEnvelope(input: unknown) {
      return input as ReturnType<
        typeof makeEnvelope
      >;
    },

    verifyPackage,

    hashCanonical: hash,

    getStoryboard: (pkg: TestPackage) =>
      pkg.storyboard,

    getMediaPlan: (pkg: TestPackage) =>
      pkg.mediaPlan,

    getPackageHash: (pkg: TestPackage) =>
      pkg.packageHash,
  });

  return {
    adapter,
    verifyPackage,
  };
}

describe("M3 production adapter", () => {
  it("parses a valid envelope", () => {
    const env = setup();

    const parsed =
      env.adapter.parseEnvelope(
        makeEnvelope(),
      );

    expect(parsed.jobId).toBe("job-001");
    expect(parsed.version).toBe(1);
  });

  it("delegates package integrity verification", async () => {
    const env = setup();

    await env.adapter.verifyPackage(
      makePackage(),
    );

    expect(env.verifyPackage)
      .toHaveBeenCalledTimes(1);
  });

  it("propagates authoritative verifier failures", async () => {
    const env = setup();

    env.verifyPackage.mockRejectedValueOnce(
      new Error(
        "M3 package integrity failed",
      ),
    );

    await expect(
      env.adapter.verifyPackage(
        makePackage(),
      ),
    ).rejects.toThrow(
      "M3 package integrity failed",
    );
  });

  it("rejects duplicate authoritative shot IDs", async () => {
    const env = setup();

    const pkg = makePackage();

    pkg.mediaPlan.shots = [
      { shotId: "shot-001" },
      { shotId: "shot-001" },
    ];

    await expect(
      env.adapter.verifyPackage(pkg),
    ).rejects.toThrow(
      "duplicate shot IDs",
    );
  });

  it("rejects invalid canonical hash output", () => {
    const adapter = createM3ProductionAdapter({
      parseEnvelope: (input: unknown) =>
        input as ReturnType<
          typeof makeEnvelope
        >,

      verifyPackage: async () => {},

      hashCanonical: () => "not-a-sha256",

      getStoryboard: (
        pkg: TestPackage,
      ) => pkg.storyboard,

      getMediaPlan: (
        pkg: TestPackage,
      ) => pkg.mediaPlan,

      getPackageHash: (
        pkg: TestPackage,
      ) => pkg.packageHash,
    });

    expect(() =>
      adapter.hashCanonical({
        test: true,
      }),
    ).toThrow();
  });

  it("rejects malformed M3 envelopes", () => {
    const env = setup();

    expect(() =>
      env.adapter.parseEnvelope({
        version: 1,
        jobId: "job-001",
        package: {
          storyboard: {},
          packageHash: HASH,
        },
      }),
    ).toThrow();
  });
});
