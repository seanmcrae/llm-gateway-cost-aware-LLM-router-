import { describe, expect, it } from "vitest";
import { ManualClock, monthKey } from "../src/core/clock.js";
import { estimatePromptTokens, estimateTextTokens } from "../src/core/tokens.js";

describe("clock", () => {
  it("advances deterministically", () => {
    const clock = new ManualClock(1_000);
    clock.advance(250);
    expect(clock.now()).toBe(1_250);
  });

  it("derives UTC month keys across a year boundary", () => {
    expect(monthKey(Date.UTC(2026, 11, 31, 23, 59))).toBe("2026-12");
    expect(monthKey(Date.UTC(2027, 0, 1, 0, 0))).toBe("2027-01");
  });
});

describe("token estimates", () => {
  it("rounds partial tokens up and treats empty text as zero", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abc")).toBe(1);
    expect(estimateTextTokens("abcdefghi")).toBe(3);
  });

  it("adds framing overhead per message", () => {
    const one = estimatePromptTokens([{ content: "hello world!" }]);
    const two = estimatePromptTokens([{ content: "hello world!" }, { content: "" }]);
    expect(one).toBe(2 + 4 + 3);
    expect(two - one).toBe(4);
  });
});
