import { describe, expect, it } from "vitest";
import { inputHash } from "./input-hash.js";

describe("inputHash", () => {
  it("produces deterministic hashes", () => {
    const value = { title: "Hello", fps: 30 };

    expect(inputHash(value)).toBe(inputHash(value));
  });

  it("ignores object key ordering", () => {
    expect(inputHash({ a: 1, b: 2 })).toBe(
      inputHash({ b: 2, a: 1 }),
    );
  });

  it("changes when inputs change", () => {
    expect(inputHash({ title: "A" })).not.toBe(
      inputHash({ title: "B" }),
    );
  });

  it("preserves array ordering", () => {
    expect(inputHash([1, 2])).not.toBe(
      inputHash([2, 1]),
    );
  });

  it("produces SHA-256 hashes", () => {
    expect(inputHash({ test: true })).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});
