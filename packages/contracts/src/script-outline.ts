import { z } from "zod";

export const ScriptOutlineSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).min(1),
  targetWords: z.number().int().positive(),
});

export const ScriptOutlineSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  centralIdea: z.string().min(1),
  hookPlan: z.string().min(1),
  hookTargetWords: z.number().int().positive(),
  sections: z.array(ScriptOutlineSectionSchema).min(1),
  outroPlan: z.string().min(1),
  outroTargetWords: z.number().int().positive(),
});

export type ScriptOutlineSection = z.infer<
  typeof ScriptOutlineSectionSchema
>;

export type ScriptOutline = z.infer<
  typeof ScriptOutlineSchema
>;
