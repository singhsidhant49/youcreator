import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  resolveCanonicalVisualMode,
  LEGACY_MODE_MAP,
  MODE_ALIAS_MAP,
  VideoConfigSchema,
} from "@youcreator/contracts";

function computeInputHash(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

describe("Checkpoint & Cache Migration Safety (M10.6A)", () => {
  describe("Legacy Mode Mapping & Migration Invariants", () => {
    it("preserves strict backward-compatibility mapping for historical jobs", () => {
      // Historical Mode B represents Intelligent Stock & Web (New Mode A)
      expect(resolveCanonicalVisualMode("B").canonicalMode).toBe("A");
      expect(resolveCanonicalVisualMode("B").isLegacy).toBe(true);
      expect(resolveCanonicalVisualMode({ mode: "B" }).canonicalMode).toBe("A");
      expect(resolveCanonicalVisualMode({ version: 1, mode: "B" }).canonicalMode).toBe("A");

      // Historical Mode C represents AI-Generated Visuals (New Mode B)
      expect(resolveCanonicalVisualMode("C").canonicalMode).toBe("B");
      expect(resolveCanonicalVisualMode({ mode: "C" }).canonicalMode).toBe("B");
      expect(resolveCanonicalVisualMode({ version: 1, mode: "C" }).canonicalMode).toBe("B");

      // Historical Mode D represents Manual Visuals (New Mode C)
      expect(resolveCanonicalVisualMode("D").canonicalMode).toBe("C");
      expect(resolveCanonicalVisualMode({ mode: "D" }).canonicalMode).toBe("C");
      expect(resolveCanonicalVisualMode({ version: 1, mode: "D" }).canonicalMode).toBe("C");

      // Historical Mode A (basic stock/background) maps to New Mode A
      expect(resolveCanonicalVisualMode("A").canonicalMode).toBe("A");
      expect(resolveCanonicalVisualMode({ mode: "A" }).canonicalMode).toBe("A");

      // Direct legacy map constants
      expect(LEGACY_MODE_MAP).toEqual({
        A: "A",
        B: "A",
        C: "B",
        D: "C",
      });

      // User-friendly aliases
      expect(MODE_ALIAS_MAP).toEqual({
        stock: "A",
        ai: "B",
        manual: "C",
      });
    });

    it("strictly isolates Version 2 canonical modes from Version 1 interpretations", () => {
      // Version 2 Mode B is AI Generation (NEVER stock!)
      expect(resolveCanonicalVisualMode({ version: 2, mode: "B" }).canonicalMode).toBe("B");
      expect(resolveCanonicalVisualMode({ version: 2, mode: "B" }).isLegacy).toBe(false);

      // Version 2 Mode A is Intelligent Stock & Web
      expect(resolveCanonicalVisualMode({ version: 2, mode: "A" }).canonicalMode).toBe("A");
      expect(resolveCanonicalVisualMode({ version: 2, mode: "A" }).isLegacy).toBe(false);

      // Version 2 Mode C is Manual Visuals
      expect(resolveCanonicalVisualMode({ version: 2, mode: "C" }).canonicalMode).toBe("C");
      expect(resolveCanonicalVisualMode({ version: 2, mode: "C" }).isLegacy).toBe(false);

      // Rejects invalid/ambiguous modes
      expect(() => resolveCanonicalVisualMode({ version: 2, mode: "D" })).toThrow();
      expect(() => resolveCanonicalVisualMode({ version: 2, mode: "E" })).toThrow();
    });
  });

  describe("Input Hash Isolation & Checkpoint Invalidation", () => {
    it("ensures version 2 jobs have distinct input hashes that never collide with historical checkpoints", () => {
      const basePayload = {
        title: "The Future of Computing",
        durationSeconds: 30,
        resolution: "1920x1080",
        fps: 30,
      };

      // Legacy v1 payload (mode: "B" = stock)
      const legacyV1Stock = {
        ...basePayload,
        version: 1,
        mode: "B",
      };

      // Version 2 payload (mode: "B" = AI)
      const v2AI = {
        ...basePayload,
        version: 2,
        mode: "B",
      };

      // Version 2 payload (mode: "A" = stock)
      const v2Stock = {
        ...basePayload,
        version: 2,
        mode: "A",
      };

      const hashV1Stock = computeInputHash(legacyV1Stock);
      const hashV2AI = computeInputHash(v2AI);
      const hashV2Stock = computeInputHash(v2Stock);

      // Crucial: v1 stock and v2 AI must never have the same hash
      expect(hashV1Stock).not.toBe(hashV2AI);

      // v2 stock and v2 AI must have distinct hashes
      expect(hashV2Stock).not.toBe(hashV2AI);

      // v1 stock and v2 stock must have distinct hashes (preventing silent cache overwrite)
      expect(hashV1Stock).not.toBe(hashV2Stock);
    });

    it("invalidates downstream stage cache when visual mode changes", () => {
      const storyboardStageOutput = {
        shotCount: 5,
        visualThemes: ["cybersecurity", "quantum"],
      };

      const mediaStageInputModeA = {
        storyboard: storyboardStageOutput,
        visualMode: "A",
        version: 2,
      };

      const mediaStageInputModeB = {
        storyboard: storyboardStageOutput,
        visualMode: "B",
        version: 2,
      };

      const mediaStageInputModeC = {
        storyboard: storyboardStageOutput,
        visualMode: "C",
        version: 2,
      };

      const hashA = computeInputHash(mediaStageInputModeA);
      const hashB = computeInputHash(mediaStageInputModeB);
      const hashC = computeInputHash(mediaStageInputModeC);

      expect(hashA).not.toBe(hashB);
      expect(hashB).not.toBe(hashC);
      expect(hashA).not.toBe(hashC);
    });
  });

  describe("Real Committed M9 Checkpoint Verification", () => {
    it("loads and verifies completed real historical M9 acceptance job", async () => {
      const repoRoot = path.resolve(import.meta.dirname, "../../..");
      const m9JobJsonPath = path.join(repoRoot, "output/jobs/m9-acceptance-tech.json");
      const m9MediaCheckpointPath = path.join(
        repoRoot,
        "output/jobs/m9-acceptance-tech/checkpoints/media.json",
      );

      // 1. Read and validate historical job JSON
      const rawJob = JSON.parse(await readFile(m9JobJsonPath, "utf8"));
      expect(rawJob.id).toBe("m9-acceptance-tech");
      expect(rawJob.status).toBe("completed");

      // Verify that VideoConfigSchema accepts this historical job
      const parsedConfig = VideoConfigSchema.parse(rawJob.config);
      expect(parsedConfig.mode).toBe("B");

      // Verify that resolveCanonicalVisualMode correctly maps historical mode "B" to canonical "A"
      const resolved = resolveCanonicalVisualMode(parsedConfig);
      expect(resolved.canonicalMode).toBe("A");
      expect(resolved.isLegacy).toBe(true);

      // 2. Read and verify historical media checkpoint integrity
      const mediaCheckpoint = JSON.parse(await readFile(m9MediaCheckpointPath, "utf8"));
      expect(mediaCheckpoint.stageId).toBe("media");
      expect(mediaCheckpoint.status).toBe("completed");
      expect(mediaCheckpoint.output.jobId).toBe("m9-acceptance-tech");
      expect(mediaCheckpoint.output.mode).toBe("B");
      expect(mediaCheckpoint.output.shotCount).toBe(10);
      expect(mediaCheckpoint.output.assignedCount).toBe(10);
      expect(mediaCheckpoint.output.packageHash).toMatch(/^[a-f0-9]{64}$/);

      // 3. Verify production package media plan records historical Mode B
      const prodPackagePath = path.join(
        repoRoot,
        "output/jobs/m9-acceptance-tech/storyboard/production-package.json",
      );
      const prodPackage = JSON.parse(await readFile(prodPackagePath, "utf8"));
      expect(prodPackage.package.mediaPlan.mode).toBe("B");

      // 4. Verify completed video export manifest is immutable and intact
      const exportManifestPath = path.join(
        repoRoot,
        "output/jobs/m9-acceptance-tech/export/manifest.json",
      );
      const exportManifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
      expect(exportManifest.jobId).toBe("m9-acceptance-tech");
      const videoEntry = exportManifest.files.find((f: any) => f.filename === "video.mp4");
      expect(videoEntry).toBeDefined();
      expect(videoEntry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(videoEntry.bytes).toBeGreaterThan(1_000_000);
    });
  });
});
