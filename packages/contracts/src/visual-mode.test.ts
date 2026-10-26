import { describe, expect, it } from "vitest";
import {
  CanonicalVisualModeSchema,
  LEGACY_MODE_MAP,
  LegacyVisualModeSchema,
  MODE_ALIAS_MAP,
  VisualModeConfigurationSchema,
  resolveCanonicalVisualMode,
} from "./visual-mode.js";

describe("Visual Mode Contracts & Migration Resolver", () => {
  describe("Legacy mapping invariants", () => {
    it("maps historical Legacy Mode A to Canonical Mode A (Intelligent Stock & Web)", () => {
      expect(LEGACY_MODE_MAP["A"]).toBe("A");
      const res = resolveCanonicalVisualMode("A");
      expect(res.canonicalMode).toBe("A");
      expect(res.isLegacy).toBe(true);
      expect(res.version).toBe(1);
    });

    it("maps historical Legacy Mode B to Canonical Mode A (Intelligent Stock & Web - NOT AI!)", () => {
      expect(LEGACY_MODE_MAP["B"]).toBe("A");
      const res = resolveCanonicalVisualMode("B");
      expect(res.canonicalMode).toBe("A");
      expect(res.isLegacy).toBe(true);
      expect(res.version).toBe(1);
    });

    it("maps historical Legacy Mode C to Canonical Mode B (AI-Generated Visuals)", () => {
      expect(LEGACY_MODE_MAP["C"]).toBe("B");
      const res = resolveCanonicalVisualMode("C");
      expect(res.canonicalMode).toBe("B");
      expect(res.isLegacy).toBe(true);
      expect(res.version).toBe(1);
    });

    it("maps historical Legacy Mode D to Canonical Mode C (Manual Visuals)", () => {
      expect(LEGACY_MODE_MAP["D"]).toBe("C");
      const res = resolveCanonicalVisualMode("D");
      expect(res.canonicalMode).toBe("C");
      expect(res.isLegacy).toBe(true);
      expect(res.version).toBe(1);
    });
  });

  describe("Version 2 Canonical Visual Modes", () => {
    it("validates version 2 Mode A", () => {
      const res = resolveCanonicalVisualMode({ version: 2, mode: "A" });
      expect(res.version).toBe(2);
      expect(res.canonicalMode).toBe("A");
      expect(res.isLegacy).toBe(false);
      expect(res.configuration).toEqual({ version: 2, mode: "A" });
    });

    it("validates version 2 Mode B (AI Generation)", () => {
      const res = resolveCanonicalVisualMode({ version: 2, mode: "B" });
      expect(res.version).toBe(2);
      expect(res.canonicalMode).toBe("B");
      expect(res.isLegacy).toBe(false);
      expect(res.configuration).toEqual({ version: 2, mode: "B" });
    });

    it("validates version 2 Mode C (Manual)", () => {
      const res = resolveCanonicalVisualMode({ version: 2, mode: "C" });
      expect(res.version).toBe(2);
      expect(res.canonicalMode).toBe("C");
      expect(res.isLegacy).toBe(false);
      expect(res.configuration).toEqual({ version: 2, mode: "C" });
    });

    it("rejects version 2 with legacy Mode D", () => {
      expect(() =>
        resolveCanonicalVisualMode({ version: 2, mode: "D" }),
      ).toThrow(/Invalid version 2 visual mode/);
    });
  });

  describe("Human-readable aliases", () => {
    it("resolves alias 'stock' to Canonical Mode A", () => {
      expect(MODE_ALIAS_MAP["stock"]).toBe("A");
      const res = resolveCanonicalVisualMode("stock");
      expect(res.canonicalMode).toBe("A");
      expect(res.version).toBe(2);
      expect(res.isLegacy).toBe(false);
    });

    it("resolves alias 'ai' to Canonical Mode B", () => {
      expect(MODE_ALIAS_MAP["ai"]).toBe("B");
      const res = resolveCanonicalVisualMode("ai");
      expect(res.canonicalMode).toBe("B");
      expect(res.version).toBe(2);
      expect(res.isLegacy).toBe(false);
    });

    it("resolves alias 'manual' to Canonical Mode C", () => {
      expect(MODE_ALIAS_MAP["manual"]).toBe("C");
      const res = resolveCanonicalVisualMode("manual");
      expect(res.canonicalMode).toBe("C");
      expect(res.version).toBe(2);
      expect(res.isLegacy).toBe(false);
    });

    it("resolves alias inside version 2 configuration object", () => {
      const res = resolveCanonicalVisualMode({ version: 2, mode: "stock" });
      expect(res.canonicalMode).toBe("A");
      expect(res.version).toBe(2);
      expect(res.configuration).toEqual({ version: 2, mode: "A" });
    });
  });

  describe("Failure cases and closed boundaries", () => {
    it("fails closed on unknown letter mode 'E'", () => {
      expect(() => resolveCanonicalVisualMode("E")).toThrow(/Unknown visual mode/);
    });

    it("fails closed on hybrid mode string", () => {
      expect(() => resolveCanonicalVisualMode("hybrid")).toThrow(/Unknown visual mode/);
      expect(() => resolveCanonicalVisualMode("stock+ai")).toThrow(/Unknown visual mode/);
    });

    it("fails closed on empty string or null or undefined", () => {
      expect(() => resolveCanonicalVisualMode("")).toThrow(/Unknown visual mode/);
      expect(() => resolveCanonicalVisualMode(null)).toThrow(/Ambiguous or invalid/);
      expect(() => resolveCanonicalVisualMode(undefined)).toThrow(/Ambiguous or invalid/);
    });

    it("fails closed on ambiguous objects without recognizable mode", () => {
      expect(() => resolveCanonicalVisualMode({})).toThrow(/Ambiguous or invalid/);
      expect(() => resolveCanonicalVisualMode({ foo: "bar" })).toThrow(/Ambiguous or invalid/);
      expect(() => resolveCanonicalVisualMode({ mode: 123 })).toThrow(/Ambiguous or invalid/);
    });
  });

  describe("Unversioned historical jobs compatibility", () => {
    it("positively identifies unversioned object with mode 'B' as legacy stock mode", () => {
      const legacyJobConfig = {
        title: "Historical Job",
        mode: "B",
        durationSeconds: 45,
      };
      const resolved = resolveCanonicalVisualMode(legacyJobConfig);
      expect(resolved.version).toBe(1);
      expect(resolved.isLegacy).toBe(true);
      expect(resolved.canonicalMode).toBe("A");
    });
  });
});
