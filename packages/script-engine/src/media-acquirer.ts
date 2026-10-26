import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  MediaAssetSchema,
  type MediaAsset,
} from "@youcreator/contracts";

import {
  MediaCandidateSchema,
  type MediaCandidate,
} from "./media-resolver.js";

import {
  inspectImageBytes,
} from "./media-image-probe.js";

const OptionsSchema = z.object({
  maxBytes: z.number()
    .int()
    .positive()
    .default(15 * 1024 * 1024),

  maxPixels: z.number()
    .int()
    .positive()
    .default(50_000_000),

  timeoutMs: z.number()
    .int()
    .positive()
    .default(15_000),

  allowedRemoteHosts: z.array(
    z.string().min(1),
  ).default([
    "images.pexels.com",
  ]),
}).strict();

export interface MediaAcquirerOptions {
  storageRoot: string;
  allowedLocalRoots?: string[];
  maxBytes?: number;
  maxPixels?: number;
  timeoutMs?: number;
  allowedRemoteHosts?: string[];
  httpClient?: typeof fetch;
}

function isWithin(
  root: string,
  filename: string,
): boolean {
  const relative = path.relative(
    root,
    filename,
  );

  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}

async function readBoundedLocalFile(
  filename: string,
  roots: readonly string[],
  maxBytes: number,
): Promise<Buffer> {
  const resolved = await realpath(filename);

  const allowed = await Promise.all(
    roots.map(async (root) => realpath(root)),
  );

  if (
    !allowed.some((root) =>
      isWithin(root, resolved),
    )
  ) {
    throw new Error(
      "Local media path is outside approved roots",
    );
  }

  const details = await stat(resolved);

  if (!details.isFile()) {
    throw new Error(
      "Local media source is not a file",
    );
  }

  if (
    details.size < 1 ||
    details.size > maxBytes
  ) {
    throw new Error(
      "Local media exceeds permitted size",
    );
  }

  // Recheck the byte count after reading.
  // An independent production hardening step will
  // use fd-based no-follow opens to reduce path races.
  const bytes = await readFile(resolved);

  if (
    bytes.length < 1 ||
    bytes.length > maxBytes
  ) {
    throw new Error(
      "Local media exceeds permitted size",
    );
  }

  return bytes;
}

async function readBoundedRemoteFile(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.ok || !response.body) {
    throw new Error(
      `Media download failed: HTTP ${response.status}`,
    );
  }

  const contentLength = response.headers.get(
    "content-length",
  );

  if (contentLength !== null) {
    const declared = Number(contentLength);

    if (
      !Number.isSafeInteger(declared) ||
      declared < 1 ||
      declared > maxBytes
    ) {
      throw new Error(
        "Remote media exceeds permitted size",
      );
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;

  const reader = response.body.getReader();

  try {
    while (true) {
      const next = await reader.read();

      if (next.done) {
        break;
      }

      const chunk = Buffer.from(next.value);

      total += chunk.length;

      if (total > maxBytes) {
        throw new Error(
          "Remote media exceeds permitted size",
        );
      }

      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    throw new Error("Empty media download");
  }

  return Buffer.concat(chunks, total);
}

export class MediaAcquirer {
  private readonly options: z.infer<
    typeof OptionsSchema
  >;

  private readonly storageRoot: string;
  private readonly localRoots: string[];
  private readonly httpClient: typeof fetch;

  constructor(options: MediaAcquirerOptions) {
    this.options = OptionsSchema.parse({
      maxBytes: options.maxBytes,
      maxPixels: options.maxPixels,
      timeoutMs: options.timeoutMs,
      allowedRemoteHosts:
        options.allowedRemoteHosts,
    });

    this.storageRoot = path.resolve(
      options.storageRoot,
    );

    this.localRoots = (
      options.allowedLocalRoots ?? []
    ).map((root) => path.resolve(root));

    this.httpClient =
      options.httpClient ?? fetch;
  }

  private validateRemoteUrl(
    value: string,
  ): URL {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !this.options.allowedRemoteHosts.includes(
        url.hostname,
      )
    ) {
      throw new Error(
        "Remote media URL is not permitted",
      );
    }

    return url;
  }

  private async fetchRemote(
    url: string,
  ): Promise<Buffer> {
    const checkedUrl = this.validateRemoteUrl(
      url,
    );

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs,
    );

    try {
      const response = await this.httpClient(
        checkedUrl.toString(),
        {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "image/png, image/jpeg",
          },
        },
      );

      // Explicitly reject redirects. Never follow a
      // provider-controlled Location automatically.
      if (
        response.status >= 300 &&
        response.status < 400
      ) {
        throw new Error(
          "Media redirects are not permitted",
        );
      }

      const contentType = (
        response.headers.get("content-type") ?? ""
      ).split(";")[0]!.trim().toLowerCase();

      if (
        contentType !== "image/png" &&
        contentType !== "image/jpeg"
      ) {
        throw new Error(
          "Unsupported remote content type",
        );
      }

      return await readBoundedRemoteFile(
        response,
        this.options.maxBytes,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          "Media download timed out",
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async acquire(
    input: MediaCandidate,
  ): Promise<MediaAsset> {
    const candidate = MediaCandidateSchema.parse(
      input,
    );

    if (candidate.kind !== "image") {
      throw new Error(
        "MediaAcquirer currently supports images only",
      );
    }

    let bytes: Buffer;

    if (candidate.provider === "local_library") {
      if (!candidate.localPath) {
        throw new Error(
          "Local candidate has no localPath",
        );
      }

      bytes = await readBoundedLocalFile(
        candidate.localPath,
        this.localRoots,
        this.options.maxBytes,
      );
    } else if (candidate.provider === "pexels") {
      if (!candidate.sourceUrl) {
        throw new Error(
          "Pexels candidate has no sourceUrl",
        );
      }

      bytes = await this.fetchRemote(
        candidate.sourceUrl,
      );
    } else {
      throw new Error(
        `Unsupported acquisition source: ${candidate.provider}`,
      );
    }

    const image = inspectImageBytes(
      bytes,
      this.options.maxPixels,
    );

    const digest = sha256(bytes);

    const directory = path.join(
      this.storageRoot,
      "objects",
      digest.slice(0, 2),
    );

    const filename = path.join(
      directory,
      `${digest}.${image.extension}`,
    );

    await mkdir(directory, {
      recursive: true,
    });

    const temporary = path.join(
      directory,
      `.${digest}.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(
        temporary,
        bytes,
        { flag: "wx" },
      );

      try {
        // Create-only atomic publication.
        await link(temporary, filename);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        ) {
          throw error;
        }

        // A file with the same content-addressed name
        // should have exactly the expected bytes.
        const existing = await readFile(filename);

        if (
          existing.length !== bytes.length ||
          sha256(existing) !== digest
        ) {
          throw new Error(
            "Existing media object failed integrity verification",
          );
        }
      }
    } finally {
      await unlink(temporary).catch(
        (error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          ) {
            throw error;
          }
        },
      );
    }

    const createdAt = new Date().toISOString();

    // Byte integrity is verified here; license approval
    // deliberately remains unknown.
    const asset = {
      version: 1 as const,
      id: `asset-${digest.slice(0, 32)}`,
      kind: "image" as const,

      localPath: filename,
      sha256: digest,
      bytes: bytes.length,
      mimeType: image.mimeType,

      width: image.width,
      height: image.height,

      provenance: {
        source: candidate.provider,

        ...(candidate.providerAssetId
          ? {
              providerAssetId:
                candidate.providerAssetId,
            }
          : {}),

        ...(candidate.sourceUrl
          ? {
              originalUrl:
                candidate.sourceUrl,
            }
          : {}),

        retrievedAt: createdAt,

        license: {
          status: "unknown" as const,

          ...(candidate.licenseName
            ? {
                licenseName:
                  candidate.licenseName,
              }
            : {}),

          ...(candidate.licenseUrl
            ? {
                licenseUrl:
                  candidate.licenseUrl,
              }
            : {}),

          ...(candidate.attributionText
            ? {
                attributionText:
                  candidate.attributionText,
              }
            : {}),
        },
      },

      createdAt,
    };

    return MediaAssetSchema.parse(asset);
  }
}
