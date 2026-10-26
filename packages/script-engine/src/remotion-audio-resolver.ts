import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  RemotionCompositionSchema,
  type RemotionComposition,
} from "./remotion-composition-contract.js";

type ExpectedAudio = RemotionComposition["audio"];

function sha256(data: Buffer): string {
  return createHash("sha256")
    .update(data)
    .digest("hex");
}

import { parsePcmWav } from "./narration-audio-contract.js";

/**
 * Minimal PCM16 WAV header verification.
 *
 * Rejects unsupported chunks/layouts rather
 * than treating arbitrary audio as a valid WAV.
 *
 * The authoritative narration loader should
 * also run the existing M6 WAV verifier.
 */
export function verifyRemotionWavBytes(
  bytes: Buffer,
  expected: ExpectedAudio,
): void {
  let parsed;
  try {
    parsed = parsePcmWav(bytes);
  } catch (err: any) {
    const msg = err?.message ?? "";
    if (
      msg.includes("mono") ||
      msg.includes("PCM") ||
      msg.includes("format") ||
      msg.includes("rate") ||
      msg.includes("metadata")
    ) {
      throw new Error(
        "M7 narration WAV PCM structure invalid",
      );
    }
    throw new Error(
      "M7 narration WAV header invalid",
    );
  }

  if (
    parsed.sampleRate !== expected.sampleRate ||
    parsed.sampleFrames !== expected.sampleFrames
  ) {
    throw new Error(
      "M7 narration WAV sample metadata mismatch",
    );
  }

  if (sha256(bytes) !== expected.sha256) {
    throw new Error(
      "M7 narration WAV SHA-256 mismatch",
    );
  }
}

export interface StagedRemotionAudio {
  publicDir: string;
  audioUrl: string;
  sha256: string;
  sampleRate: number;
  sampleFrames: number;
}

/**
 * Never stage source WAV bytes under a filename
 * controlled by a caller.
 *
 * Reuse is allowed only for identical content.
 */
export async function stageRemotionAudio(
  manifestInput: RemotionComposition,
  publicDir: string,
): Promise<StagedRemotionAudio> {
  const manifest =
    RemotionCompositionSchema.parse(
      manifestInput,
    );

  if (
    !path.isAbsolute(publicDir) ||
    !path.isAbsolute(manifest.audio.path)
  ) {
    throw new Error(
      "M7 audio staging requires absolute paths",
    );
  }

  const sourceBytes = await readFile(
    manifest.audio.path,
  );

  verifyRemotionWavBytes(
    sourceBytes,
    manifest.audio,
  );

  const mediaDir = path.join(
    publicDir,
    "media",
  );

  await mkdir(mediaDir, {
    recursive: true,
  });

  const name = `${manifest.audio.sha256}.wav`;
  const destination = path.join(mediaDir, name);

  const temp = path.join(
    mediaDir,
    `.narration-${randomUUID()}.tmp`,
  );

  try {
    await writeFile(
      temp,
      sourceBytes,
      { flag: "wx" },
    );

    try {
      await link(temp, destination);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !==
        "EEXIST"
      ) {
        throw error;
      }
    }
  } finally {
    await rm(temp, { force: true });
  }

  // Verify whichever file won publication.
  const stagedBytes = await readFile(
    destination,
  );

  verifyRemotionWavBytes(
    stagedBytes,
    manifest.audio,
  );

  return {
    publicDir,
    audioUrl: `/media/${name}`,
    sha256: manifest.audio.sha256,
    sampleRate: manifest.audio.sampleRate,
    sampleFrames: manifest.audio.sampleFrames,
  };
}

export interface StagedRemotionMusic {
  publicDir: string;
  musicUrl: string;
  sha256: string;
}

export async function stageRemotionMusic(
  musicPath: string,
  expectedSha256: string,
  publicDir: string,
): Promise<StagedRemotionMusic> {
  if (!path.isAbsolute(musicPath) || !path.isAbsolute(publicDir)) {
    throw new Error("M10.4 music staging requires absolute paths");
  }

  const sourceBytes = await readFile(musicPath);
  const actualSha256 = sha256(sourceBytes);

  if (actualSha256 !== expectedSha256) {
    throw new Error("M10.4 music SHA-256 mismatch");
  }

  const mediaDir = path.join(publicDir, "media");
  await mkdir(mediaDir, { recursive: true });

  const rawExt = path.extname(musicPath).toLowerCase();
  const validExts = [".wav", ".mp3", ".aac", ".m4a", ".ogg"];
  const ext = validExts.includes(rawExt) ? rawExt : ".wav";
  const name = `${expectedSha256}${ext}`;
  const destination = path.join(mediaDir, name);

  const temp = path.join(mediaDir, `.music-${randomUUID()}.tmp`);

  try {
    await writeFile(temp, sourceBytes, { flag: "wx" });
    try {
      await link(temp, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  } finally {
    await rm(temp, { force: true });
  }

  return {
    publicDir,
    musicUrl: `/media/${name}`,
    sha256: expectedSha256,
  };
}
