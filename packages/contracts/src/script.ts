import { z } from "zod";

export const ScriptSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  narration: z.string().min(1),
  estimatedDurationSeconds: z.number().positive(),
});

export const VideoScriptSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  language: z.string().min(2),
  tone: z.string().min(1),
  hook: z.string().min(1),
  sections: z.array(ScriptSectionSchema).min(1),
  outro: z.string().min(1),
});

export type ScriptSection = z.infer<
  typeof ScriptSectionSchema
>;

export type VideoScript = z.infer<
  typeof VideoScriptSchema
>;
