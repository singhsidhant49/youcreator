import { describe, expect, it } from "vitest";

import {
  buildAIShotPrompt,
  type AIShotPromptContextInput,
} from "./ai-shot-prompt-builder.js";

describe("AIShotPromptBuilder Unit Tests", () => {
  it("builds a rich, scene-specific prompt from narration and visual requirements", () => {
    const context: AIShotPromptContextInput = {
      shotId: "shot-neptune-1",
      narrationText: "Neptune's atmosphere contains some of the fastest winds in the solar system.",
      visualDescription: "Photorealistic view of Neptune from orbit with atmospheric storm bands and cloud formations",
      profile: "documentary",
      aspectRatio: "16:9",
      framing: "wide_shot",
      cameraAngle: "low_angle",
      requiredConcepts: ["planetary storm bands", "deep blue atmosphere"],
      excludedConcepts: ["terrestrial oceans", "Earth landscapes"],
      negativeTerms: ["watermark", "text"],
    };

    const built = buildAIShotPrompt(context);

    // Contains profile aesthetics
    expect(built.prompt).toContain("Photorealistic cinematic documentary capture");
    // Contains visual description
    expect(built.prompt).toContain("Neptune from orbit with atmospheric storm bands");
    // Contains scene narration context
    expect(built.prompt).toContain("Scene context: Neptune's atmosphere contains");
    // Contains required concepts
    expect(built.prompt).toContain("Key elements: planetary storm bands, deep blue atmosphere");
    // Contains composition & framing
    expect(built.prompt).toContain("wide shot, low angle angle, horizontal 16:9 composition");
    // Contains negative terms and domain exclusions
    expect(built.prompt).toContain("no text");
    expect(built.prompt).toContain("no watermark");
    expect(built.prompt).toContain("no terrestrial oceans");
    expect(built.prompt).toContain("no Earth landscapes");

    // Clean negative prompt output
    expect(built.negativePrompt).toContain("text");
    expect(built.negativePrompt).toContain("watermark");
    expect(built.negativePrompt).toContain("terrestrial oceans");
  });

  it("sanitizes generic placeholder phrases", () => {
    const context: AIShotPromptContextInput = {
      shotId: "shot-clean-1",
      visualDescription: "A technology background with beautiful cinematic image of computer chip wafer",
      aspectRatio: "16:9",
      requiredConcepts: [],
      excludedConcepts: [],
      identityReferences: [],
      negativeTerms: [],
    };

    const built = buildAIShotPrompt(context);

    expect(built.prompt).not.toContain("technology background");
    expect(built.prompt).not.toContain("beautiful cinematic image");
    expect(built.prompt).toContain("computer chip wafer");
  });

  it("incorporates custom styleGuide when provided", () => {
    const customStyle = "Premium 2D cartoon storybook illustration, hand-painted texture, golden lighting";
    const built = buildAIShotPrompt({
      shotId: "shot-style-1",
      visualDescription: "A young explorer with blue backpack in misty enchanted forest",
      styleGuide: customStyle,
      aspectRatio: "16:9",
      requiredConcepts: [],
      excludedConcepts: [],
      identityReferences: [],
      negativeTerms: [],
    });

    expect(built.prompt).toContain(customStyle);
  });

  it("builds story profile prompts with high bokeh quality and visual continuity", () => {
    const built = buildAIShotPrompt({
      shotId: "shot-story-1",
      visualDescription: "Close-up portrait of the warrior looking toward the burning horizon",
      continuityPrompt: "Consistent scarred cheek and crimson cape from shot 1",
      profile: "story",
      aspectRatio: "16:9",
      framing: "close_up",
      cameraAngle: "eye_level",
      requiredConcepts: ["crimson cape"],
      excludedConcepts: [],
      identityReferences: ["Marcus the warrior"],
      negativeTerms: [],
    });

    expect(built.prompt).toContain("Cinematic narrative storytelling masterpiece");
    expect(built.prompt).toContain("smooth creamy bokeh and shallow depth of field");
    expect(built.prompt).toContain("Visual continuity: Consistent scarred cheek");
    expect(built.prompt).toContain("shallow depth of field, creamy bokeh background");
    expect(built.negativePrompt).toContain("deformed limbs");
    expect(built.negativePrompt).toContain("blurry subject");
  });
});
