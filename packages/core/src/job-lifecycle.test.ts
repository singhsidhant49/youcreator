import { describe, it, expect } from "vitest";

import {
  assertJobTransition,
  InvalidJobTransitionError,
} from "./job-lifecycle.js";

describe("Job lifecycle", () => {
  it("allows queued to running", () => {
    expect(() =>
      assertJobTransition("queued", "running")
    ).not.toThrow();
  });

  it("allows running to completed", () => {
    expect(() =>
      assertJobTransition("running", "completed")
    ).not.toThrow();
  });

  it("allows running to failed", () => {
    expect(() =>
      assertJobTransition("running", "failed")
    ).not.toThrow();
  });

  it("allows queued to cancelled", () => {
    expect(() =>
      assertJobTransition("queued", "cancelled")
    ).not.toThrow();
  });

  it("rejects queued to completed", () => {
    expect(() =>
      assertJobTransition("queued", "completed")
    ).toThrow(InvalidJobTransitionError);
  });

  it("rejects completed to running", () => {
    expect(() =>
      assertJobTransition("completed", "running")
    ).toThrow(InvalidJobTransitionError);
  });

  it("rejects cancelled to completed", () => {
    expect(() =>
      assertJobTransition("cancelled", "completed")
    ).toThrow(InvalidJobTransitionError);
  });

  it("allows failed to queued for explicit retry", () => {
    expect(() =>
      assertJobTransition("failed", "queued")
    ).not.toThrow();
  });

  it("rejects completed to queued", () => {
    expect(() =>
      assertJobTransition("completed", "queued")
    ).toThrow(InvalidJobTransitionError);
  });
});
