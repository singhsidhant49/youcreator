import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  MediaResolver,
  type MediaRequirement,
} from "./media-resolver.js";

import {
  MediaCandidateSelector,
} from "./media-candidate-selector.js";

import { MediaAcquirer } from "./media-acquirer.js";
import { MediaObjectStore } from "./media-object-store.js";

import {
  StockShotMediaResolver,
} from "./stock-shot-media-resolver.js";

import {
  planVisualContinuity,
} from "./visual-continuity.js";

import {
  createSceneMediaPlan,
} from "./scene-media-plan.js";

import {
  storyboard,
} from "./visual-continuity.test-fixture.js";

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33);

  Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]).copy(bytes);

  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");

  bytes.writeUInt32BE(1920, 16);
  bytes.writeUInt32BE(1080, 20);

  bytes[24] = 8;
  bytes[25] = 2;

  return bytes;
}

describe("Stock shot media resolver", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });

      root = undefined;
    }
  });

  it(
    "discovers, selects, acquires and stores local media",
    async () => {
      root = await mkdtemp(
        path.join(
          os.tmpdir(),
          "youcreator-stock-shot-",
        ),
      );

      const bankRoot = path.join(
        root,
        "bank",
      );

      const storageRoot = path.join(
        root,
        "store",
      );

      await mkdir(bankRoot);

      const filename = path.join(
        bankRoot,
        "desk.png",
      );

      await writeFile(filename, pngBytes());

      const continuity = planVisualContinuity(
        storyboard,
        "documentary",
      );

      const plan = createSceneMediaPlan(
        storyboard,
        continuity,
        "B",
      );

      const requirement: MediaRequirement = {
        ...plan.shots[0]!,
        preferredMediaKind: "image",
        description:
          "Person working at desk with laptop",
        searchQueries: [
          "person working desk laptop",
        ],
      };

      const discovery = new MediaResolver([
        {
          id: "test-local-provider",

          supports: () => true,

          search: async () => [{
            id: "bank-test-desk-001",
            provider: "local_library",
            kind: "image",

            description:
              "Person working at desk with laptop",

            localPath: filename,
            width: 1920,
            height: 1080,

            keywords: [
              "person",
              "desk",
              "working",
              "laptop",
            ],

            providerScore: 0.9,
          }],
        },
      ]);

      const objectStore = new MediaObjectStore({
        storageRoot,
      });

      const resolver = new StockShotMediaResolver({
        jobId: "job-test",
        requirements: [requirement],
        discovery,

        selector:
          new MediaCandidateSelector(),

        acquirer: new MediaAcquirer({
          storageRoot,
          allowedLocalRoots: [bankRoot],
        }),

        objectStore,
      });

      const outcome = await resolver.resolve(
        requirement.shotId,
      );

      expect(outcome.status).toBe("assigned");

      if (outcome.status === "assigned") {
        const stored = await objectStore.lookup({
          provider: "local_library",
          id: "bank-test-desk-001",
        });

        expect(stored?.sha256).toBe(
          outcome.assignment.asset.sha256,
        );

        expect(
          outcome.assignment.asset.provenance
            .providerAssetId,
        ).toBe("bank-test-desk-001");
      }
    },
  );
});
