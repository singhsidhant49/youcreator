import {
  describe,
  expect,
  it,
} from "vitest";

import {
  validateNativeM3Timings,
} from "./native-m3-visual-source.js";

const shotIds = [
  "shot-001",
  "shot-002",
  "shot-003",
];

function timings() {
  return [
    {
      shotId: "shot-001",
      startSeconds: 0,
      endSeconds: 2,
    },
    {
      shotId: "shot-002",
      startSeconds: 2,
      endSeconds: 4.5,
    },
    {
      shotId: "shot-003",
      startSeconds: 4.5,
      endSeconds: 7,
    },
  ];
}

describe("Native M3 timeline validation", () => {
  it("accepts complete contiguous timings", () => {
    expect(
      validateNativeM3Timings(
        shotIds,
        timings(),
      ),
    ).toEqual(timings());
  });

  it("rejects reordered shot timings", () => {
    const input = timings();

    input.reverse();

    expect(() =>
      validateNativeM3Timings(
        shotIds,
        input,
      ),
    ).toThrow(
      "Native M3 shot order mismatch",
    );
  });

  it("rejects timeline gaps and overlaps", () => {
    const gap = timings();

    gap[1]!.startSeconds = 2.25;

    expect(() =>
      validateNativeM3Timings(
        shotIds,
        gap,
      ),
    ).toThrow(
      "Native M3 timeline discontinuity",
    );

    const overlap = timings();

    overlap[1]!.startSeconds = 1.75;

    expect(() =>
      validateNativeM3Timings(
        shotIds,
        overlap,
      ),
    ).toThrow(
      "Native M3 timeline discontinuity",
    );
  });

  it("rejects incomplete timing coverage", () => {
    const input = timings();

    input.pop();

    expect(() =>
      validateNativeM3Timings(
        shotIds,
        input,
      ),
    ).toThrow(
      "Native M3 timing coverage mismatch",
    );
  });

  it("rejects invalid and zero durations", () => {
    const input = timings();

    input[1]!.endSeconds =
      input[1]!.startSeconds;

    expect(() =>
      validateNativeM3Timings(
        shotIds,
        input,
      ),
    ).toThrow(
      "Native M3 invalid duration",
    );
  });

  it("rejects duplicated authoritative shot IDs", () => {
    expect(() =>
      validateNativeM3Timings(
        [
          "shot-001",
          "shot-001",
          "shot-003",
        ],
        timings(),
      ),
    ).toThrow(
      "Native M3 shot IDs are empty or duplicated",
    );
  });
});
