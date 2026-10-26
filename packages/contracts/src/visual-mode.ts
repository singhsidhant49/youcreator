import { z } from "zod";

/**
 * Version 2 Canonical Visual Modes:
 * - A: Intelligent Stock & Web (merged old Mode A + B)
 * - B: AI-Generated Visuals (old Mode C)
 * - C: Manual Visuals (old Mode D)
 */
export const CanonicalVisualModeSchema = z.enum(["A", "B", "C"]);
export type CanonicalVisualMode = z.infer<typeof CanonicalVisualModeSchema>;

/**
 * Historical Version 1 Visual Modes:
 * - A: Basic stock/web images (shared background)
 * - B: Intelligent stock/web/image-bank selection
 * - C: AI-generated images
 * - D: Fully manual selection
 */
export const LegacyVisualModeSchema = z.enum(["A", "B", "C", "D"]);
export type LegacyVisualMode = z.infer<typeof LegacyVisualModeSchema>;

/**
 * Human-readable aliases for Canonical Visual Modes.
 */
export const VisualModeAliasSchema = z.enum(["stock", "ai", "manual"]);
export type VisualModeAlias = z.infer<typeof VisualModeAliasSchema>;

/**
 * Canonical mapping from human-readable aliases to Version 2 visual modes.
 */
export const MODE_ALIAS_MAP = {
  stock: "A",
  ai: "B",
  manual: "C",
} as const satisfies Record<VisualModeAlias, CanonicalVisualMode>;

/**
 * Critical backward compatibility mapping:
 * - Legacy A ("basic stock") -> New A ("Intelligent Stock & Web")
 * - Legacy B ("intelligent stock") -> New A ("Intelligent Stock & Web")
 * - Legacy C ("AI generation") -> New B ("AI-Generated Visuals")
 * - Legacy D ("manual selection") -> New C ("Manual Visuals")
 */
export const LEGACY_MODE_MAP = {
  A: "A",
  B: "A",
  C: "B",
  D: "C",
} as const satisfies Record<LegacyVisualMode, CanonicalVisualMode>;

/**
 * Canonical Version 2 Visual Mode Configuration.
 */
export const VisualModeConfigurationSchema = z.object({
  version: z.literal(2),
  mode: CanonicalVisualModeSchema,
}).strict();

export type VisualModeConfiguration = z.infer<
  typeof VisualModeConfigurationSchema
>;

/**
 * Result of resolving visual mode configuration with full auditability.
 */
export interface ResolvedVisualMode {
  version: 1 | 2;
  canonicalMode: CanonicalVisualMode;
  rawMode: string;
  isLegacy: boolean;
  configuration: VisualModeConfiguration;
}

/**
 * Safely resolves a mode specification into a canonical Version 2 visual mode configuration.
 *
 * Rules:
 * - Explicit version 2 specifications are validated directly.
 * - Explicit version 1 specifications are positively identified and mapped via LEGACY_MODE_MAP.
 * - Unversioned strings/objects matching legacy storage semantics are mapped via LEGACY_MODE_MAP.
 * - Aliases ("stock", "ai", "manual") resolve directly to canonical Version 2 configuration.
 * - Ambiguous, invalid or unknown mode specifications FAIL CLOSED.
 */
export function resolveCanonicalVisualMode(input: unknown): ResolvedVisualMode {
  if (typeof input === "string") {
    const trimmed = input.trim().toLowerCase();

    // Check alias first
    if (trimmed in MODE_ALIAS_MAP) {
      const alias = trimmed as VisualModeAlias;
      const canonicalMode = MODE_ALIAS_MAP[alias];
      return {
        version: 2,
        canonicalMode,
        rawMode: input,
        isLegacy: false,
        configuration: {
          version: 2,
          mode: canonicalMode,
        },
      };
    }

    const upper = input.trim().toUpperCase();
    const legacyParsed = LegacyVisualModeSchema.safeParse(upper);
    if (!legacyParsed.success) {
      throw new Error(`Unknown visual mode: "${input}". Expected "A", "B", "C", "D" or aliases "stock", "ai", "manual".`);
    }

    // Unversioned historical string identifier maps through LEGACY_MODE_MAP
    const canonicalMode = LEGACY_MODE_MAP[legacyParsed.data];
    return {
      version: 1,
      canonicalMode,
      rawMode: input,
      isLegacy: true,
      configuration: {
        version: 2,
        mode: canonicalMode,
      },
    };
  }

  if (typeof input === "object" && input !== null) {
    const obj = input as Record<string, unknown>;

    // Case 1: Explicit Version 2 configuration
    if (obj.version === 2) {
      const rawMode = String(obj.mode ?? "");
      const trimmed = rawMode.trim().toLowerCase();
      let canonicalMode: CanonicalVisualMode;

      if (trimmed in MODE_ALIAS_MAP) {
        canonicalMode = MODE_ALIAS_MAP[trimmed as VisualModeAlias];
      } else {
        const parsed = CanonicalVisualModeSchema.safeParse(rawMode.trim().toUpperCase());
        if (!parsed.success) {
          throw new Error(`Invalid version 2 visual mode: "${rawMode}". Expected "A", "B", or "C".`);
        }
        canonicalMode = parsed.data;
      }

      return {
        version: 2,
        canonicalMode,
        rawMode,
        isLegacy: false,
        configuration: {
          version: 2,
          mode: canonicalMode,
        },
      };
    }

    // Case 2: Explicit Version 1 configuration
    if (obj.version === 1) {
      const rawMode = String(obj.mode ?? "").trim().toUpperCase();
      const parsed = LegacyVisualModeSchema.safeParse(rawMode);
      if (!parsed.success) {
        throw new Error(`Invalid legacy version 1 visual mode: "${rawMode}". Expected "A", "B", "C", or "D".`);
      }
      const canonicalMode = LEGACY_MODE_MAP[parsed.data];
      return {
        version: 1,
        canonicalMode,
        rawMode,
        isLegacy: true,
        configuration: {
          version: 2,
          mode: canonicalMode,
        },
      };
    }

    // Case 3: Unversioned object (historical job record)
    if ("mode" in obj && typeof obj.mode === "string") {
      const rawMode = obj.mode.trim();
      const lower = rawMode.toLowerCase();

      // If specified using new human-readable alias, treat as v2
      if (lower in MODE_ALIAS_MAP) {
        const canonicalMode = MODE_ALIAS_MAP[lower as VisualModeAlias];
        return {
          version: 2,
          canonicalMode,
          rawMode,
          isLegacy: false,
          configuration: {
            version: 2,
            mode: canonicalMode,
          },
        };
      }

      const upper = rawMode.toUpperCase();
      const legacyParsed = LegacyVisualModeSchema.safeParse(upper);
      if (!legacyParsed.success) {
        throw new Error(`Invalid unversioned visual mode: "${rawMode}". Expected legacy mode "A", "B", "C", "D" or alias.`);
      }

      const canonicalMode = LEGACY_MODE_MAP[legacyParsed.data];
      return {
        version: 1,
        canonicalMode,
        rawMode,
        isLegacy: true,
        configuration: {
          version: 2,
          mode: canonicalMode,
        },
      };
    }
  }

  throw new Error(`Ambiguous or invalid visual mode configuration: ${JSON.stringify(input)}`);
}
