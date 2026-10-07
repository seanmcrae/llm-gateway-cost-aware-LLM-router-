import { describe, expect, it } from "vitest";
import { ManualClock, VirtualSleeper } from "../src/core/clock.js";
import { ProviderError } from "../src/core/errors.js";
import { MockProvider, type MockProfile } from "../src/providers/mock.js";

const steady: MockProfile = {
  ttftMs: 200,
  msPerOutputToken: 10,
  jitter: 0,
  slowRate: 0,
  slowMultiplier: 1,
  failureRate: 0,
};

function setup(profiles: Record<string, MockProfile>) {
  const clock = new ManualClock();
  return { clock, provider: new MockProvider(profiles, new VirtualSleeper(clock)) };
}

const request = (model: string, content = "Summarise the incident report in two lines.") => ({
  model,
  messages: [{ role: "user" as const, content }],
  maxTokens: 512,
});

describe("MockProvider", () => {
  it("is deterministic and charges virtual time for the simulated latency", async () => {
    const a = setup({ m: steady });
    const b = setup({ m: steady });
    const ra = await a.provider.complete(request("m"), { timeoutMs: 60_000 });
    const rb = await b.provider.complete(request("m"), { timeoutMs: 60_000 });
    expect(ra).toEqual(rb);
    expect(a.clock.now()).toBe(200 + 10 * ra.usage.completionTokens);
    expect(ra.finishReason).toBe("stop");
  });

  it("returns the same output length from every model, so tiers compare fairly", async () => {
    const { provider } = setup({ cheap: steady, premium: { ...steady, ttftMs: 900 } });
    const cheap = await provider.complete(request("cheap"), { timeoutMs: 60_000 });
    const premium = await provider.complete(request("premium"), { timeoutMs: 60_000 });
    expect(cheap.usage).toEqual(premium.usage);
  });

  it("truncates at maxTokens and reports finish_reason length", async () => {
    const { provider } = setup({ m: steady });
    const result = await provider.complete(
      { ...request("m"), maxTokens: 5 },
      { timeoutMs: 60_000 },
    );
    expect(result.usage.completionTokens).toBe(5);
    expect(result.finishReason).toBe("length");
  });

  it("fails with a retryable timeout once the deadline passes", async () => {
    const { clock, provider } = setup({ m: { ...steady, ttftMs: 5_000 } });
    const call = provider.complete(request("m"), { timeoutMs: 1_000 });
    await expect(call).rejects.toMatchObject({ kind: "timeout", retryable: true });
    expect(clock.now()).toBe(1_000);
  });

  it("injects transient failures at roughly the configured rate", async () => {
    const { provider } = setup({ m: { ...steady, failureRate: 0.2 } });
    let failures = 0;
    for (let i = 0; i < 500; i++) {
      try {
        await provider.complete(request("m", `prompt ${i}`), { timeoutMs: 60_000 });
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).retryable).toBe(true);
        failures++;
      }
    }
    expect(failures / 500).toBeGreaterThan(0.15);
    expect(failures / 500).toBeLessThan(0.25);
  });

  it("rejects unknown models as a non-retryable error", async () => {
    const { provider } = setup({ m: steady });
    await expect(provider.complete(request("other"), { timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: "bad_request",
      retryable: false,
    });
  });
});
