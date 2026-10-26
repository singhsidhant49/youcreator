import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  PexelsPhotoProvider,
  type PexelsHttpClient,
} from "./pexels-photo-provider.js";

import { MediaResolver } from "./media-resolver.js";

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

const requirement = {
  ...mediaPlan.shots[0]!,
  searchQueries: [
    "person working at desk",
  ],
  preferredMediaKind: "image" as const,
};

const context = {
  jobId: "job-001",
  mode: "B" as const,
  maxCandidatesPerProvider: 10,
};

const photo = {
  id: 12345,
  width: 1920,
  height: 1080,
  url: "https://www.pexels.com/photo/12345/",
  photographer: "Test Photographer",
  alt: "Person working at a laptop",
  src: {
    original:
      "https://images.pexels.com/photos/12345/original.jpeg",
    medium:
      "https://images.pexels.com/photos/12345/medium.jpeg",
  },
};

function mockHttp(
  payload: unknown,
  status = 200,
) {
  const client = vi.fn(
    async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }),
  );

  return client;
}

function providerWith(
  client: PexelsHttpClient,
  perPage = 15,
) {
  return new PexelsPhotoProvider({
    apiKey: "test-api-key",
    httpClient: client,
    perPage,
  });
}

function response(photos: unknown[]) {
  return {
    photos,
    page: 1,
    per_page: photos.length || 1,
  };
}

describe("PexelsPhotoProvider", () => {
  it("maps provider photos into media candidates", async () => {
    const client = mockHttp(response([photo]));
    const provider = providerWith(client);

    const result = await provider.search(
      requirement,
      context,
    );

    expect(result).toHaveLength(1);

    expect(result[0]).toMatchObject({
      id: "pexels-photo-12345",
      provider: "pexels",
      kind: "image",
      providerAssetId: "12345",
      width: 1920,
      height: 1080,
      licenseName: "Pexels License",
    });

    expect(result[0]?.sourceUrl).toBe(
      photo.src.original,
    );

    expect(result[0]?.previewUrl).toBe(
      photo.src.medium,
    );
  });

  it("encodes query and sends API key in Authorization header", async () => {
    const client = mockHttp(response([]));
    const provider = providerWith(client);

    await provider.search(
      {
        ...requirement,
        searchQueries: [
          "desk work & laptop",
        ],
      },
      context,
    );

    expect(client).toHaveBeenCalledTimes(1);

    const [requestUrl, options] =
      client.mock.calls[0] as unknown as [
        string,
        { headers: { Authorization: string } },
      ];

    const url = new URL(requestUrl);

    expect(url.origin).toBe(
      "https://api.pexels.com",
    );

    expect(url.pathname).toBe(
      "/v1/search",
    );

    expect(url.searchParams.get("query"))
      .toBe("desk work & laptop");

    expect(options.headers.Authorization)
      .toBe("test-api-key");
  });

  it("does not search unsupported media requirements", async () => {
    const client = mockHttp(response([photo]));
    const provider = providerWith(client);

    const result = await provider.search(
      {
        ...requirement,
        preferredMediaKind: "video",
      },
      context,
    );

    expect(result).toEqual([]);
    expect(client).not.toHaveBeenCalled();
  });

  it("respects the candidate limit", async () => {
    const photos = Array.from(
      { length: 10 },
      (_, index) => ({
        ...photo,
        id: index + 1,
      }),
    );

    const client = mockHttp(
      response(photos),
    );

    const provider = providerWith(
      client,
      20,
    );

    const result = await provider.search(
      requirement,
      {
        ...context,
        maxCandidatesPerProvider: 3,
      },
    );

    expect(result).toHaveLength(3);

    const [requestUrl] =
      client.mock.calls[0] as unknown as [string];

    const url = new URL(requestUrl);

    expect(
      url.searchParams.get("per_page"),
    ).toBe("3");
  });

  it("skips malformed photos and duplicate IDs", async () => {
    const client = mockHttp(
      response([
        photo,
        photo,
        {
          ...photo,
          id: -5,
        },
        {
          ...photo,
          id: 67890,
        },
      ]),
    );

    const provider = providerWith(client);

    const result = await provider.search(
      requirement,
      context,
    );

    expect(result.map((item) => item.id))
      .toEqual([
        "pexels-photo-12345",
        "pexels-photo-67890",
      ]);
  });

  it("rejects invalid response envelopes", async () => {
    const client = mockHttp({
      unexpected: true,
    });

    const provider = providerWith(client);

    await expect(
      provider.search(
        requirement,
        context,
      ),
    ).rejects.toThrow();
  });

  it("reports provider HTTP failures", async () => {
    const client = mockHttp(
      {},
      429,
    );

    const provider = providerWith(client);

    await expect(
      provider.search(
        requirement,
        context,
      ),
    ).rejects.toThrow(
      "HTTP 429",
    );
  });

  it("integrates with MediaResolver error isolation", async () => {
    const client = mockHttp(
      {},
      503,
    );

    const resolver = new MediaResolver([
      providerWith(client),
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

    expect(result.providerErrors).toHaveLength(1);

    expect(result.providerErrors[0])
      .toContain("HTTP 503");
  });

  it("rejects invalid provider configuration", () => {
    expect(() =>
      new PexelsPhotoProvider({
        apiKey: "",
      }),
    ).toThrow();

    expect(() =>
      new PexelsPhotoProvider({
        apiKey: "test",
        perPage: 81,
      }),
    ).toThrow();
  });
});
