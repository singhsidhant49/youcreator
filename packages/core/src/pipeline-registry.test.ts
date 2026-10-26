import { describe, expect, it } from "vitest";

import { PipelineRegistry } from "./pipeline-registry.js";
import type { PipelineStage } from "./pipeline-stage.js";

function fakeStage(
  id: PipelineStage["id"],
  dependencies: PipelineStage["dependencies"] = [],
): PipelineStage {
  return {
    id,
    version: "1",
    dependencies,
    async execute() {
      return { success: true };
    },
  };
}

describe("PipelineRegistry", () => {
  it("resolves dependencies in the correct order", () => {
    const registry = new PipelineRegistry();

    registry.register(fakeStage("render", ["timeline"]));
    registry.register(fakeStage("timeline", ["audio", "media"]));
    registry.register(fakeStage("media", ["storyboard"]));
    registry.register(fakeStage("audio", ["script"]));
    registry.register(fakeStage("storyboard", ["script"]));
    registry.register(fakeStage("script"));

    const order = registry.resolveOrder().map((s) => s.id);

    expect(order.indexOf("script")).toBeLessThan(
      order.indexOf("storyboard"),
    );

    expect(order.indexOf("storyboard")).toBeLessThan(
      order.indexOf("media"),
    );

    expect(order.indexOf("media")).toBeLessThan(
      order.indexOf("timeline"),
    );

    expect(order.indexOf("audio")).toBeLessThan(
      order.indexOf("timeline"),
    );

    expect(order.at(-1)).toBe("render");
  });

  it("rejects duplicate stages", () => {
    const registry = new PipelineRegistry();

    registry.register(fakeStage("script"));

    expect(() =>
      registry.register(fakeStage("script")),
    ).toThrow("Duplicate stage");
  });

  it("rejects missing dependencies", () => {
    const registry = new PipelineRegistry();

    registry.register(fakeStage("render", ["timeline"]));

    expect(() => registry.resolveOrder()).toThrow(
      "Unknown stage: timeline",
    );
  });

  it("rejects circular dependencies", () => {
    const registry = new PipelineRegistry();

    registry.register(fakeStage("script", ["storyboard"]));
    registry.register(fakeStage("storyboard", ["script"]));

    expect(() => registry.resolveOrder()).toThrow(
      "Circular dependency",
    );
  });

  it("supports independent stages", () => {
    const registry = new PipelineRegistry();

    registry.register(fakeStage("script"));
    registry.register(fakeStage("audio"));

    expect(registry.resolveOrder().map((s) => s.id)).toEqual([
      "script",
      "audio",
    ]);
  });
});