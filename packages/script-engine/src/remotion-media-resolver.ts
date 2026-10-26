import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import type {
  RemotionComposition,
} from "./remotion-composition-contract.js";

function sha256(data: Buffer): string {
  return createHash("sha256")
    .update(data)
    .digest("hex");
}

function extensionFor(data: Buffer): string {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]),
    )
  ) {
    return ".png";
  }

  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return ".jpg";
  }

  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }

  throw new Error("Unsupported source image format");
}

export interface StagedRemotionMedia {
  publicDir: string;
  imageUrls: Record<string, string>;
}

/**
 * Must receive a verified composition from the
 * native artifact loader.
 *
 * The publicDir should be dedicated to a single
 * render job and not publicly writable.
 */
export async function stageRemotionImages(
  composition: RemotionComposition,
  publicDir: string,
): Promise<StagedRemotionMedia> {
  if (!path.isAbsolute(publicDir)) {
    throw new Error(
      "Remotion public directory must be absolute",
    );
  }

  const imageUrls: Record<string, string> =
    Object.create(null) as Record<string, string>;

  const seen = new Map<string, string>();

  await mkdir(
    path.join(publicDir, "media"),
    { recursive: true },
  );

  for (const shot of composition.shots) {
    const source = shot.assetPath;

    if (!path.isAbsolute(source)) {
      throw new Error(
        `Invalid image path: ${shot.shotId}`,
      );
    }

    const sourceStat = await stat(source);

    if (!sourceStat.isFile()) {
      throw new Error(
        `Source is not a file: ${shot.shotId}`,
      );
    }

    const sourceBytes = await readFile(source);

    if (
      sha256(sourceBytes) !== shot.assetSha256
    ) {
      throw new Error(
        `Image hash mismatch: ${shot.shotId}`,
      );
    }

    const extension =
      extensionFor(sourceBytes);

    const filename =
      `${shot.assetSha256}${extension}`;

    const destination = path.join(
      publicDir,
      "media",
      filename,
    );

    if (!seen.has(filename)) {
      // Exclusive creation prevents accidental
      // replacement of an existing staged asset.
      let created = false;

      try {
        const handle = await open(
          destination,
          "wx",
        );

        created = true;

        try {
          await handle.writeFile(sourceBytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !==
          "EEXIST"
        ) {
          if (created) {
            await rm(destination, {
              force: true,
            });
          }

          throw error;
        }
      }

      // Verify the final staged bytes, whether
      // created here or already present.
      const staged = await readFile(destination);

      if (sha256(staged) !== shot.assetSha256) {
        throw new Error(
          `Staged image corruption: ${shot.shotId}`,
        );
      }

      seen.set(filename, destination);
    }

    imageUrls[shot.shotId] =
      `/media/${filename}`;
  }

  return {
    publicDir,
    imageUrls,
  };
}
