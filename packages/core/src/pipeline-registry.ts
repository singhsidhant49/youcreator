import type {
  PipelineStage,
} from "./pipeline-stage.js";

import type {
  PipelineStageId,
} from "@youcreator/contracts";

export class PipelineRegistry {
  private readonly stages = new Map<
    PipelineStageId,
    PipelineStage
  >();

  register(stage: PipelineStage): void {
    if (this.stages.has(stage.id)) {
      throw new Error(`Duplicate stage: ${stage.id}`);
    }

    this.stages.set(stage.id, stage);
  }

  get(id: PipelineStageId): PipelineStage {
    const stage = this.stages.get(id);

    if (!stage) {
      throw new Error(`Unknown stage: ${id}`);
    }

    return stage;
  }

  resolveOrder(): PipelineStage[] {
    const visited = new Set<PipelineStageId>();
    const visiting = new Set<PipelineStageId>();
    const result: PipelineStage[] = [];

    const visit = (id: PipelineStageId): void => {
      if (visiting.has(id)) {
        throw new Error(
          `Circular dependency detected at stage: ${id}`,
        );
      }

      if (visited.has(id)) {
        return;
      }

      const stage = this.get(id);

      visiting.add(id);

      for (const dependency of stage.dependencies) {
        visit(dependency);
      }

      visiting.delete(id);
      visited.add(id);
      result.push(stage);
    };

    for (const id of this.stages.keys()) {
      visit(id);
    }

    return result;
  }
}