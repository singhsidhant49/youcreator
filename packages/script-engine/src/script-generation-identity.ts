import { z } from "zod";
import { inputHash } from "@youcreator/core";

export const ScriptGenerationIdentityConfigSchema =
  z.object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),

    promptVersions: z.object({
      outline: z.string().trim().min(1),
      hook: z.string().trim().min(1),
      section: z.string().trim().min(1),
      outro: z.string().trim().min(1),
      revision: z.string().trim().min(1),
    }).strict(),

    scriptEngineVersion:
      z.string().trim().min(1),

    editorial: z.object({
      enabled: z.boolean(),
      requireExample: z.boolean(),
      minimumSectionWords:
        z.number().int().nonnegative(),
      revisionsEnabled: z.boolean(),
      maxRevisionCalls:
        z.number().int().nonnegative(),
    }).strict(),

    promotion: z.object({
      enabled: z.boolean(),
      maxWordDriftRatio:
        z.number().finite().nonnegative(),
      maxDurationDriftSeconds:
        z.number().finite().nonnegative(),
    }).strict(),

    generation: z.object({
      reviseSections: z.boolean(),
      enforceQuality: z.boolean(),
      wordsPerMinute:
        z.number().finite().positive(),
    }).strict(),

    narrativePlan: z.object({
      version: z.number().int().positive(),
      planHash: z.string().regex(/^[a-f0-9]{64}$/),
      profile: z.enum(["explainer", "documentary", "story"]),
    }).strict().optional(),
  }).strict();

export type ScriptGenerationIdentityConfig =
  z.infer<
    typeof ScriptGenerationIdentityConfigSchema
  >;

export function createScriptGenerationKey(
  input: ScriptGenerationIdentityConfig,
): string {
  const config =
    ScriptGenerationIdentityConfigSchema.parse(input);

  return `script-config-v1:${inputHash({
    identityVersion: 1,
    config,
  })}`;
}
