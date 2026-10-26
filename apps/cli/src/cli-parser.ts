import {
  resolveCanonicalVisualMode,
  type VisualModeAlias,
  type CanonicalVisualMode,
} from "@youcreator/contracts";

export interface ParsedResolution {
  width: number;
  height: number;
  resolutionString: string;
  aspectRatio: "16:9" | "9:16";
}

export interface CliCommandOptions {
  prompt?: string;
  topic?: string;
  title?: string;
  mode?: string;
  canonicalMode?: CanonicalVisualMode;
  modeAlias?: VisualModeAlias;
  duration?: number;
  aspectRatio?: "16:9" | "9:16";
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  profile?: string;
  voice?: string;
  voiceSpeed?: number;
  imageProvider?: string;
  imageModel?: string;
  imageQuality?: string;
  imageResolution?: string;
  budget?: number;
  maxCostPerImage?: number;
  music?: boolean;
  musicAssetId?: string;
  assignments?: string;
  styleGuide?: string;
  outputRoot?: string;
  json?: boolean;
}

export interface ParsedCliInput {
  command: "create" | "run" | "status" | "resume" | "cancel" | "export" | "help";
  jobId?: string;
  options: CliCommandOptions;
  rawArgs: string[];
}

export function parseResolution(
  rawResolution?: string,
  rawAspectRatio?: "16:9" | "9:16",
): ParsedResolution {
  const aspect: "16:9" | "9:16" =
    rawAspectRatio === "9:16" ? "9:16" : "16:9";

  if (!rawResolution) {
    if (aspect === "9:16") {
      return {
        width: 1080,
        height: 1920,
        resolutionString: "1080x1920",
        aspectRatio: "9:16",
      };
    }
    return {
      width: 1920,
      height: 1080,
      resolutionString: "1920x1080",
      aspectRatio: "16:9",
    };
  }

  const cleaned = rawResolution.trim().toLowerCase();

  // Pattern like 1920x1080 or 1080x1920
  const dimMatch = cleaned.match(/^(\d+)\s*[x×]\s*(\d+)$/);
  if (dimMatch) {
    const width = Number(dimMatch[1]);
    const height = Number(dimMatch[2]);
    const detectedAspect: "16:9" | "9:16" = width < height ? "9:16" : "16:9";
    return {
      width,
      height,
      resolutionString: `${width}x${height}`,
      aspectRatio: rawAspectRatio ?? detectedAspect,
    };
  }

  // Common shorthands: 1080p, 720p, 4k
  if (cleaned === "1080p" || cleaned === "1080") {
    if (aspect === "9:16") {
      return {
        width: 1080,
        height: 1920,
        resolutionString: "1080x1920",
        aspectRatio: "9:16",
      };
    }
    return {
      width: 1920,
      height: 1080,
      resolutionString: "1920x1080",
      aspectRatio: "16:9",
    };
  }

  if (cleaned === "720p" || cleaned === "720") {
    if (aspect === "9:16") {
      return {
        width: 720,
        height: 1280,
        resolutionString: "720x1280",
        aspectRatio: "9:16",
      };
    }
    return {
      width: 1280,
      height: 720,
      resolutionString: "1280x720",
      aspectRatio: "16:9",
    };
  }

  if (cleaned === "4k" || cleaned === "2160p") {
    if (aspect === "9:16") {
      return {
        width: 2160,
        height: 3840,
        resolutionString: "2160x3840",
        aspectRatio: "9:16",
      };
    }
    return {
      width: 3840,
      height: 2160,
      resolutionString: "3840x2160",
      aspectRatio: "16:9",
    };
  }

  // Fallback default
  if (aspect === "9:16") {
    return {
      width: 1080,
      height: 1920,
      resolutionString: "1080x1920",
      aspectRatio: "9:16",
    };
  }

  return {
    width: 1920,
    height: 1080,
    resolutionString: "1920x1080",
    aspectRatio: "16:9",
  };
}

export function parseCliArgs(args: string[]): ParsedCliInput {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    return {
      command: "help",
      options: {},
      rawArgs: args,
    };
  }

  const rawCommand = args[0].toLowerCase();
  const rest = args.slice(1);

  const validCommands = ["create", "run", "status", "resume", "cancel", "export", "help"] as const;
  const command = validCommands.find((c) => c === rawCommand) ?? "help";

  const options: CliCommandOptions = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (arg.startsWith("--") || arg.startsWith("-")) {
      const isLong = arg.startsWith("--");
      const stripped = isLong ? arg.slice(2) : arg.slice(1);
      const [key, inlineValue] = stripped.split("=", 2);

      const getValue = (): string | undefined => {
        if (inlineValue !== undefined) {
          return inlineValue;
        }
        if (i + 1 < rest.length && !rest[i + 1].startsWith("-")) {
          i++;
          return rest[i];
        }
        return undefined;
      };

      const normalizedKey = key.toLowerCase().replace(/_/g, "-");

      switch (normalizedKey) {
        case "prompt":
        case "p":
          options.prompt = getValue();
          break;
        case "topic":
          options.topic = getValue();
          break;
        case "title":
          options.title = getValue();
          break;
        case "mode":
        case "m":
          options.mode = getValue();
          break;
        case "duration":
        case "d": {
          const val = getValue();
          if (val) options.duration = Number(val);
          break;
        }
        case "aspect-ratio":
        case "aspectratio":
        case "ar": {
          const val = getValue();
          if (val === "9:16" || val === "16:9") {
            options.aspectRatio = val;
          }
          break;
        }
        case "resolution":
        case "res":
        case "r":
          options.resolution = getValue();
          break;
        case "fps": {
          const val = getValue();
          if (val) options.fps = Number(val);
          break;
        }
        case "profile":
          options.profile = getValue();
          break;
        case "voice":
          options.voice = getValue();
          break;
        case "voice-speed":
        case "speed": {
          const val = getValue();
          if (val) options.voiceSpeed = Number(val);
          break;
        }
        case "provider":
        case "image-provider":
          options.imageProvider = getValue();
          break;
        case "image-model":
        case "model":
          options.imageModel = getValue();
          break;
        case "image-quality":
        case "quality":
          options.imageQuality = getValue();
          break;
        case "image-resolution":
          options.imageResolution = getValue();
          break;
        case "budget":
        case "max-cost": {
          const val = getValue();
          if (val) options.budget = Number(val);
          break;
        }
        case "max-cost-per-image": {
          const val = getValue();
          if (val) options.maxCostPerImage = Number(val);
          break;
        }
        case "music": {
          const val = getValue();
          options.music = val !== "false";
          break;
        }
        case "music-asset-id":
          options.musicAssetId = getValue();
          break;
        case "assignments":
          options.assignments = getValue();
          break;
        case "style":
        case "style-guide":
        case "styleguide":
          options.styleGuide = getValue();
          break;
        case "output-root":
        case "outputroot":
          options.outputRoot = getValue();
          break;
        case "json":
          options.json = true;
          break;
      }
    } else {
      positionals.push(arg);
    }
  }

  // Handle positionals depending on command
  let jobId: string | undefined;

  if (command === "create") {
    // If flags not given, check positionals: create "<title>" <mode> <duration>
    if (!options.prompt && !options.topic && !options.title && positionals.length > 0) {
      options.prompt = positionals[0];
      options.title = positionals[0];
    }
    if (!options.mode && positionals.length > 1) {
      options.mode = positionals[1];
    }
    if (options.duration === undefined && positionals.length > 2) {
      options.duration = Number(positionals[2]);
    }
  } else {
    // run, status, resume, cancel, export: first positional is jobId
    if (positionals.length > 0) {
      jobId = positionals[0];
    }
  }

  // Resolve resolution and dimensions if duration or resolution passed
  const resolvedRes = parseResolution(options.resolution, options.aspectRatio);
  options.width = resolvedRes.width;
  options.height = resolvedRes.height;
  options.resolution = resolvedRes.resolutionString;
  options.aspectRatio = resolvedRes.aspectRatio;

  // Resolve canonical mode if mode given
  if (options.mode) {
    try {
      const resolvedMode = resolveCanonicalVisualMode({ version: 2, mode: options.mode });
      options.canonicalMode = resolvedMode.canonicalMode;
      const lower = options.mode.toLowerCase();
      if (lower === "stock" || lower === "ai" || lower === "manual") {
        options.modeAlias = lower;
      }
    } catch {
      // Let validator catch invalid mode
    }
  }

  return {
    command,
    jobId,
    options,
    rawArgs: args,
  };
}
