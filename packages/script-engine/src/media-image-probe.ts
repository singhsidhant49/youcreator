export type SupportedImageMime =
  | "image/png"
  | "image/jpeg";

export interface ImageProbeResult {
  mimeType: SupportedImageMime;
  width: number;
  height: number;
  extension: "png" | "jpg";
}

function inspectPng(
  bytes: Buffer,
): ImageProbeResult {
  const signature = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);

  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Invalid PNG header");
  }

  return {
    mimeType: "image/png",
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    extension: "png",
  };
}

function inspectJpeg(
  bytes: Buffer,
): ImageProbeResult {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  ) {
    throw new Error("Invalid JPEG header");
  }

  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new Error("Invalid JPEG marker");
    }

    while (
      offset < bytes.length &&
      bytes[offset] === 0xff
    ) {
      offset++;
    }

    if (offset >= bytes.length) {
      break;
    }

    const marker = bytes[offset++]!;

    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    if (
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }

    if (offset + 2 > bytes.length) {
      break;
    }

    const length = bytes.readUInt16BE(offset);

    if (
      length < 2 ||
      offset + length > bytes.length
    ) {
      throw new Error("Invalid JPEG segment");
    }

    const isStartOfFrame = [
      0xc0, 0xc1, 0xc2, 0xc3,
      0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb,
      0xcd, 0xce, 0xcf,
    ].includes(marker);

    if (isStartOfFrame) {
      if (length < 7) {
        throw new Error(
          "Invalid JPEG frame header",
        );
      }

      return {
        mimeType: "image/jpeg",
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
        extension: "jpg",
      };
    }

    offset += length;
  }

  throw new Error(
    "JPEG dimensions not found",
  );
}

export function inspectImageBytes(
  bytes: Buffer,
  maxPixels = 50_000_000,
): ImageProbeResult {
  if (
    !Number.isSafeInteger(maxPixels) ||
    maxPixels < 1
  ) {
    throw new Error("Invalid maximum pixel count");
  }

  let inspected: ImageProbeResult;

  if (
    bytes.length >= 8 &&
    bytes[0] === 137 &&
    bytes[1] === 80
  ) {
    inspected = inspectPng(bytes);
  } else if (
    bytes.length >= 2 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8
  ) {
    inspected = inspectJpeg(bytes);
  } else {
    throw new Error(
      "Unsupported image format",
    );
  }

  if (
    inspected.width < 1 ||
    inspected.height < 1 ||
    inspected.width * inspected.height > maxPixels
  ) {
    throw new Error(
      "Invalid or oversized image dimensions",
    );
  }

  return inspected;
}
