import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  MediaResolver,
  type MediaCandidateProvider,
  type MediaRequirement,
} from "./media-resolver.js";

import {
  planVisualContinuity,
} from "./visual-continuity.js";

import {
  createSceneMediaPlan,
} from "./scene-media-plan.js";

import {
  storyboard,
} from "./visual-continuity.test-fixture.js";

const continuity = planVisualContinuity(
  storyboard,
  "documentary",
);

const mediaPlan = createSceneMediaPlan(
  storyboard,
  continuity,
  "B",
);

const requirement: MediaRequirement =
  mediaPlan.shots[0]!;

function candidate(
  id: string,
  kind: "image" | "video" = "image",
) {
  return {
    id,
    provider: "local_library" as const,
    kind,
    description: "A person working at a desk",
    localPath: `/test/media/${id}.jpg`,
    width: 1920,
    height: 1080,
    keywords: [
      "person",
      "desk",
      "working",
    ],
  };
}

function provider(
  id: string,
  results: ReturnType<typeof candidate>[],
): MediaCandidateProvider {
  return {
    id,
    supports: () => true,
    search: vi.fn(async () => results),
  };
}

describe("MediaResolver", () => {
  it("collects candidates from supported providers", async () => {
    const resolver = new MediaResolver([
      provider("local-bank", [
        candidate("asset-1"),
      ]),
      provider("another-bank", [
        candidate("asset-2"),
      ]),
    ]);

    const result = await resolver.discover(
      requirement,
      {
        jobId: "job-001",
        mode: "B",
      },
    );

    expect(result.status).toBe(
      "candidates_found",
    );

    expect(result.candidates).toHaveLength(2);

    expect(result.attemptedProviders).toEqual([
      "local-bank",
      "another-bank",
    ]);
  });

  it("ignores providers that do not support the shot", async () => {
    const search = vi.fn(async () => [
      candidate("asset-1"),
    ]);

    const resolver = new MediaResolver([
      {
        id: "unsupported",
        supports: () => false,
        search,
      },
    ]);

    const result = await resolver.discover(
      requirement,
      {
        jobId: "job-001",
        mode: "B",
      },
    );

    expect(result.status).toBe(
      "no_candidates",
    );

    expect(search).not.toHaveBeenCalled();
  });

  it("deduplicates repeated provider candidates", async () => {
    const resolver = new MediaResolver([
      provider("local-bank", [
        candidate("asset-1"),
        candidate("asset-1"),
      ]),
    ]);

    const result = await resolver.discover(
      requirement,
      {
        jobId: "job-001",
        mode: "B",
      },
    );

    expect(result.candidates).toHaveLength(1);
  });

  it("filters incompatible media kinds", async () => {
    const resolver = new MediaResolver([
      provider("local-bank", [
        candidate("asset-1", "image"),
        candidate("asset-2", "video"),
      ]),
    ]);

    const result = await resolver.discover(
      {
        ...requirement,
        preferredMediaKind: "video",
      },
      {
        jobId: "job-001",
        mode: "B",
      },
    );

    expect(result.candidates).toHaveLength(1);

    expect(result.candidates[0]?.kind).toBe(
      "video",
    );
  });

  it("continues when a provider fails", async () => {
    const resolver = new MediaResolver([
      {
        id: "broken",
        supports: () => true,
        search: async () => {
          throw new Error(
            "Provider offline",
          );
        },
      },
      provider("working", [
        candidate("asset-1"),
      ]),
    ]);

    const result = await resolver.discover(
      requirement,
      {
        jobId: "job-001",
        mode: "B",
      },
    );

    expect(result.status).toBe(
      "candidates_found",
    );

    expect(result.providerErrors).toContain(
      "broken: Provider offline",
    );
  });

  it("supports strict provider failure behavior", async () => {
    const resolver = new MediaResolver(
      [
        {
          id: "broken",
          supports: () => true,
          search: async () => {
            throw new Error(
              "Provider offline",
            );
          },
        },
      ],
      {
        failOnProviderError: true,
      },
    );

    await expect(
      resolver.discover(
        requirement,
        {
          jobId: "job-001",
          mode: "B",
        },
      ),
    ).rejects.toThrow(
      "Media provider broken failed",
    );
  });

  it("rejects invalid provider limits", () => {
    expect(() =>
      new MediaResolver(
        [],
        {
          maxCandidatesPerProvider: 0,
        },
      ),
    ).toThrow(
      "Invalid maxCandidatesPerProvider",
    );
  });

  it("rejects duplicate provider IDs", () => {
    expect(() =>
      new MediaResolver([
        provider("same", []),
        provider("same", []),
      ]),
    ).toThrow(
      "unique non-empty IDs",
    );
  });
});
