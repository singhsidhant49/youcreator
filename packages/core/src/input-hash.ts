import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, normalize(val)]),
    );
  }

  return value;
}

export function inputHash(value: unknown): string {
  const serialized = JSON.stringify(normalize(value));

  if (serialized === undefined) {
    throw new Error("Cannot hash undefined input");
  }

  return createHash("sha256")
    .update(serialized)
    .digest("hex");
}
