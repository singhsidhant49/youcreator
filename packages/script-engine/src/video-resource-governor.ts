import { z } from "zod";

const Unit = z.number().int().safe().nonnegative();

export const VideoResourceDemandSchema = z.object({
  cpuUnits: Unit,
  memoryMb: Unit,
  aiSlots: Unit,
}).strict().refine(
  (value) =>
    value.cpuUnits +
      value.memoryMb +
      value.aiSlots > 0,
  "Resource demand cannot be empty",
);

export const VideoResourceCapacitySchema = z.object({
  cpuUnits: Unit,
  memoryMb: Unit,
  aiSlots: Unit,
}).strict();

export type VideoResourceDemand =
  z.infer<typeof VideoResourceDemandSchema>;

export type VideoResourceCapacity =
  z.infer<typeof VideoResourceCapacitySchema>;

export interface ResourceSnapshot {
  capacity: VideoResourceCapacity;
  used: VideoResourceCapacity;
  waiting: number;
}

interface Waiter {
  demand: VideoResourceDemand;
  grant(release: () => void): void;
}

export class VideoResourceGovernor {
  private used: VideoResourceCapacity = {
    cpuUnits: 0,
    memoryMb: 0,
    aiSlots: 0,
  };

  private readonly capacity: VideoResourceCapacity;
  private readonly waiting: Waiter[] = [];

  constructor(capacity: VideoResourceCapacity) {
    this.capacity =
      VideoResourceCapacitySchema.parse(capacity);

    if (
      this.capacity.cpuUnits === 0 &&
      this.capacity.memoryMb === 0 &&
      this.capacity.aiSlots === 0
    ) {
      throw new Error(
        "M9 resource capacity cannot be empty",
      );
    }
  }

  private fits(demand: VideoResourceDemand): boolean {
    return (
      this.used.cpuUnits + demand.cpuUnits <=
        this.capacity.cpuUnits &&
      this.used.memoryMb + demand.memoryMb <=
        this.capacity.memoryMb &&
      this.used.aiSlots + demand.aiSlots <=
        this.capacity.aiSlots
    );
  }

  private validateDemand(
    candidate: VideoResourceDemand,
  ): VideoResourceDemand {
    const demand =
      VideoResourceDemandSchema.parse(candidate);

    if (
      demand.cpuUnits > this.capacity.cpuUnits ||
      demand.memoryMb > this.capacity.memoryMb ||
      demand.aiSlots > this.capacity.aiSlots
    ) {
      throw new Error(
        "M9 job resource demand exceeds capacity",
      );
    }

    return demand;
  }

  private drain(): void {
    // Strict FIFO prevents later small jobs from
    // starving a resource-heavy waiting job.
    while (this.waiting.length > 0) {
      const first = this.waiting[0]!;

      if (!this.fits(first.demand)) {
        break;
      }

      this.waiting.shift();

      this.used.cpuUnits += first.demand.cpuUnits;
      this.used.memoryMb += first.demand.memoryMb;
      this.used.aiSlots += first.demand.aiSlots;

      let released = false;

      first.grant(() => {
        if (released) {
          throw new Error(
            "M9 resource reservation released twice",
          );
        }

        released = true;

        this.used.cpuUnits -= first.demand.cpuUnits;
        this.used.memoryMb -= first.demand.memoryMb;
        this.used.aiSlots -= first.demand.aiSlots;

        this.drain();
      });
    }
  }

  async acquire(
    candidate: VideoResourceDemand,
  ): Promise<() => void> {
    const demand = this.validateDemand(candidate);

    return new Promise((resolve) => {
      this.waiting.push({
        demand,
        grant: resolve,
      });

      this.drain();
    });
  }

  async withResources<T>(
    demand: VideoResourceDemand,
    work: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(demand);

    try {
      return await work();
    } finally {
      release();
    }
  }

  snapshot(): ResourceSnapshot {
    return {
      capacity: { ...this.capacity },
      used: { ...this.used },
      waiting: this.waiting.length,
    };
  }
}
