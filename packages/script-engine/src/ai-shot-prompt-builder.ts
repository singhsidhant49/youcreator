import { z } from "zod";

export const AIShotPromptContextSchema = z.object({
  shotId: z.string().min(1),
  narrationText: z.string().optional(),
  visualDescription: z.string().min(5),
  scenePurpose: z.string().optional(),
  styleGuide: z.string().optional(),
  profile: z.enum(["explainer", "documentary", "story"]).optional(),
  aspectRatio: z.string().default("16:9"),
  framing: z.string().optional(),
  cameraAngle: z.string().optional(),
  continuityPrompt: z.string().optional(),
  requiredConcepts: z.array(z.string()).default([]),
  excludedConcepts: z.array(z.string()).default([]),
  identityReferences: z.array(z.string()).default([]),
  negativeTerms: z.array(z.string()).default([]),
}).strict();

export type AIShotPromptContext = z.infer<typeof AIShotPromptContextSchema>;
export type AIShotPromptContextInput = z.input<typeof AIShotPromptContextSchema>;

export interface BuiltAIShotPrompt {
  prompt: string;
  negativePrompt: string;
}

const GENERIC_PHRASES = [
  /technology background/i,
  /beautiful cinematic image/i,
  /cool wallpaper/i,
  /abstract background/i,
  /generic photo/i,
];

function sanitizePromptContent(text: string): string {
  let cleaned = text.trim();
  for (const pattern of GENERIC_PHRASES) {
    cleaned = cleaned.replace(pattern, "").trim();
  }
  return cleaned.replace(/\s+/g, " ");
}

/**
 * Builds scene-specific, rich image prompts for AI generation that satisfy:
 * - Specific subject representation from narration and visual requirements
 * - Profile and video-level aesthetic coherence
 * - Framing, camera angle, and aspect ratio guidance
 * - Mandatory exclusion rules (no text, no watermark, plus domain exclusions)
 */
export function buildAIShotPrompt(input: AIShotPromptContextInput): BuiltAIShotPrompt {
  const context = AIShotPromptContextSchema.parse(input);

  const parts: string[] = [];

  // 1. Style foundation based on profile or explicit style guide
  if (context.styleGuide && context.styleGuide.trim().length > 10) {
    parts.push(sanitizePromptContent(context.styleGuide));
  } else {
    switch (context.profile) {
      case "story":
        parts.push("Cinematic narrative storytelling masterpiece, rich visual depth with smooth creamy bokeh and shallow depth of field, sharp crisp character focus, expressive emotion, soft volumetric lighting, 8k resolution, cinematic color grading");
        break;
      case "documentary":
        parts.push("Photorealistic cinematic documentary capture, authentic environmental detail, natural lighting, high dynamic range");
        break;
      case "explainer":
      default:
        parts.push("Photorealistic cinematic visual explainer composition, crisp clarity, focused subject, dramatic editorial lighting");
        break;
    }
  }

  // 2. Core visual subject description
  const cleanVisual = sanitizePromptContent(context.visualDescription);
  if (cleanVisual) {
    parts.push(cleanVisual);
  }

  // 3. Continuity across shots
  if (context.continuityPrompt && context.continuityPrompt.trim()) {
    const cleanContinuity = sanitizePromptContent(context.continuityPrompt);
    parts.push(`Visual continuity: ${cleanContinuity}`);
  }

  // 4. Narration context (if distinct from visual description)
  if (context.narrationText && context.narrationText.trim()) {
    const cleanNarration = sanitizePromptContent(context.narrationText);
    if (!cleanVisual.toLowerCase().includes(cleanNarration.toLowerCase().slice(0, 20))) {
      parts.push(`Scene context: ${cleanNarration}`);
    }
  }

  // 5. Required subject concepts
  if (context.requiredConcepts.length > 0) {
    const conceptText = context.requiredConcepts.join(", ");
    parts.push(`Key elements: ${conceptText}`);
  }

  // 6. Identity continuity references
  if (context.identityReferences.length > 0) {
    parts.push(`Characters and entities: ${context.identityReferences.join("; ")}`);
  }

  // 7. Framing, camera angle & composition
  const framingParts: string[] = [];
  if (context.framing) {
    framingParts.push(context.framing.replaceAll("_", " "));
  }
  if (context.cameraAngle) {
    framingParts.push(`${context.cameraAngle.replaceAll("_", " ")} angle`);
  }
  if (context.profile === "story") {
    framingParts.push("shallow depth of field, creamy bokeh background, sharp foreground subject");
  }
  const normAspect = context.aspectRatio.includes(":") ? context.aspectRatio : context.aspectRatio.replace("x", ":");
  framingParts.push(`horizontal ${normAspect} composition`);
  parts.push(framingParts.join(", "));

  // 8. Negative terms and exclusions
  const negativeItems = new Set<string>([
    "no text",
    "no watermark",
    "no logos",
    "no subtitles",
    "no low resolution artifacts",
    "no blurry subject",
    "no deformed limbs",
    "no mutated faces",
    "no extra fingers",
    "no bad anatomy",
    "no distorted features",
    "no ugly oversaturated colors",
  ]);

  for (const term of context.negativeTerms) {
    if (term.trim()) {
      negativeItems.add(term.trim().toLowerCase().startsWith("no ") ? term.trim() : `no ${term.trim()}`);
    }
  }

  for (const term of context.excludedConcepts) {
    if (term.trim()) {
      negativeItems.add(term.trim().toLowerCase().startsWith("no ") ? term.trim() : `no ${term.trim()}`);
    }
  }

  const negativeString = Array.from(negativeItems).join(", ");
  parts.push(negativeString);

  // Combine into a cohesive prompt
  const fullPrompt = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ");

  const cleanNegativePrompt = Array.from(negativeItems)
    .map((item) => item.replace(/^no\s+/i, ""))
    .join(", ");

  return {
    prompt: fullPrompt,
    negativePrompt: cleanNegativePrompt,
  };
}
