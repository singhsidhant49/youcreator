import { z } from "zod";
import { inputHash } from "@youcreator/core";

export const StoryboardGenerationConfigSchema =
  z.object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),

    promptVersion: z.string().trim().min(1),
    plannerVersion: z.string().trim().min(1),

    segmentation: z.object({
      algorithmVersion: z.string().trim().min(1),
      profile: z.enum([
        "documentary",
        "educational",
        "meditation",
        "audiobook",
      ]),
      maxWordsPerShot: z.number().int().positive(),
      wordsPerMinute: z.number().finite().positive(),
    }).strict(),

    llm: z.object({
      maxTokensPerRequest: z.number().int().positive(),
      temperature: z.number().min(0).max(2),
      jsonMode: z.boolean(),
    }).strict(),
  }).strict();

export type StoryboardGenerationConfig =
  z.infer<typeof StoryboardGenerationConfigSchema>;

export function createStoryboardGenerationKey(
  input: StoryboardGenerationConfig,
): string {
  const configuration =
    StoryboardGenerationConfigSchema.parse(input);

  return `storyboard-config-v1:${inputHash({
    version: 1,
    configuration,
  })}`;
}
