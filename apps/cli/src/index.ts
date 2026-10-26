import { parseCliArgs } from "./cli-parser.js";

try {
  process.loadEnvFile?.();
} catch {
  // Ignore if .env is missing or already loaded
}

import {
  handleCreate,
  handleRun,
  handleStatus,
  handleResume,
  handleCancel,
  handleExport,
  classifyCliError,
  ExitCodes,
} from "./cli-commands.js";

function printUsage(): void {
  console.log(`
YouCreator Production CLI

Usage:
  npm run cli -- create --prompt "<prompt>" --mode <stock|ai|manual|A|B|C> --duration <seconds> [options]
  npm run cli -- run <job-id>
  npm run cli -- status <job-id> [--json]
  npm run cli -- resume <job-id>
  npm run cli -- cancel <job-id>
  npm run cli -- export <job-id>

Create Options:
  --prompt, -p <string>        Video topic or creative prompt (required)
  --mode, -m <string>          Visual generation mode: stock (A), ai (B), manual (C) (required)
  --duration, -d <number>      Target duration in seconds (required)
  --aspect-ratio, -ar <string> Aspect ratio: "16:9" or "9:16" (default: 16:9)
  --resolution, -r <string>    Resolution: "1080p", "720p", "4k", or "WIDTHxHEIGHT"
  --fps <number>               Frames per second: 24, 30, 60 (default: 30)
  --profile <string>           Editorial narrative profile: "documentary", "explainer", "story"
  --voice <string>             TTS voice identifier (default: af_bella)
  --voice-speed <number>       TTS narration speed (default: 0.9)
  --image-provider <string>    AI image provider (default: ideogram)
  --image-model <string>       AI image model (default: p-image-ideogram)
  --image-quality <string>     AI image quality: very_low, low, medium, high
  --style <string>             Custom visual style guide for AI images (Mode B)
  --budget <number>            Maximum paid generation budget in USD
  --max-cost-per-image <usd>   Maximum cost permitted per single generated image
  --assignments <path|json>    Manual asset assignments for Mode C

Exit Codes:
  0 - Success
  1 - Invalid Input or Job Not Found
  2 - Provider Failure (API key, TTS, Network)
  3 - Paid Generation Budget Exceeded
  4 - QA Rejection (Review or Fail gate)
  5 - Checkpoint or Export Corruption
`);
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));

  switch (parsed.command) {
    case "create": {
      const job = await handleCreate(parsed.options);
      console.log(JSON.stringify(job, null, 2));
      break;
    }

    case "run": {
      let targetJobId = parsed.jobId;
      if (!targetJobId) {
        if (parsed.options.prompt || parsed.options.topic || parsed.options.title) {
          const job = await handleCreate(parsed.options);
          console.log(`Created job ${job.id} for "${job.config.title}". Starting pipeline execution...`);
          targetJobId = job.id;
        } else {
          throw new Error("Usage: run <job-id> OR run --prompt \"<prompt>\" --mode <stock|ai|manual> --duration <seconds>");
        }
      }
      const result = await handleRun(targetJobId, parsed.options);
      if (parsed.options.json) {
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }


    case "status": {
      if (!parsed.jobId) {
        throw new Error("Usage: status <job-id>");
      }
      const status = await handleStatus(parsed.jobId, parsed.options);
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case "resume": {
      if (!parsed.jobId) {
        throw new Error("Usage: resume <job-id>");
      }
      const result = await handleResume(parsed.jobId, parsed.options);
      if (parsed.options.json) {
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    case "cancel": {
      if (!parsed.jobId) {
        throw new Error("Usage: cancel <job-id>");
      }
      const job = await handleCancel(parsed.jobId, parsed.options);
      console.log(JSON.stringify(job, null, 2));
      break;
    }

    case "export": {
      if (!parsed.jobId) {
        throw new Error("Usage: export <job-id>");
      }
      const result = await handleExport(parsed.jobId, parsed.options);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "help":
    default:
      printUsage();
      break;
  }
}

main().catch((error: unknown) => {
  const { exitCode, message, category } = classifyCliError(error);
  console.error(`\n[CLI ERROR: ${category} (Exit Code ${exitCode})] ${message}`);
  process.exitCode = exitCode;
});
