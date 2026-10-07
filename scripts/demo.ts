/**
 * Walks through the gateway's behaviour on the bundled all-mock config: `npm run demo`.
 * Requests go through the real HTTP app in-process, with a virtual clock so simulated
 * latencies and backoff waits cost no wall time and the output is identical on every run.
 */
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config/load.js";
import type { GatewayConfig } from "../src/config/schema.js";
import { ManualClock, VirtualSleeper } from "../src/core/clock.js";
import { seededRandom } from "../src/core/random.js";
import { Gateway } from "../src/gateway/gateway.js";
import { buildProviders } from "../src/providers/factory.js";
import { createApp } from "../src/server/app.js";

function start(edit: (config: GatewayConfig) => void = () => undefined) {
  const config = loadConfig();
  edit(config);
  const clock = new ManualClock(Date.UTC(2026, 9, 7, 9));
  const sleeper = new VirtualSleeper(clock);
  let id = 0;
  const gateway = new Gateway({
    config,
    providers: buildProviders(config, { env: {}, sleeper }),
    clock,
    sleeper,
    random: seededRandom(42),
    newId: () => `req-${String(++id).padStart(3, "0")}`,
  });
  return createApp(gateway);
}

type App = ReturnType<typeof start>;
const lines: string[] = [];
const out = (line = "") => lines.push(line);

async function send(
  app: App,
  label: string,
  content: string,
  options: { model?: string; key?: string; headers?: Record<string, string> } = {},
) {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.key ?? "sk-local-acme-demo"}`,
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify({
      model: options.model ?? "auto",
      temperature: 0,
      max_tokens: 400,
      messages: [{ role: "user", content }],
    }),
  });
  const h = (name: string) => res.headers.get(`x-llm-gateway-${name}`) ?? "";
  out(`> ${label}`);
  if (res.status !== 200) {
    const body = (await res.json()) as { error: { code: string; message: string } };
    out(`  ${res.status} ${body.error.code}: ${body.error.message}`);
  } else {
    out(
      `  ${res.status} ${h("model")} (${h("tier")})  cost $${Number(h("cost-usd")).toFixed(6)}  ` +
        `latency ${h("latency-ms")} ms  attempts ${h("attempts")}  cache ${h("cache")}`,
    );
    out(`  route: ${h("route")}`);
  }
  out();
}

const EASY =
  'Classify the sentiment of this review as positive, negative or neutral: "Setup took two minutes and it just works."';
const HARD = [
  "Design a migration plan for moving a billing service from one Postgres instance to a sharded cluster.",
  "Analyze the trade-offs of dual writes versus change data capture and explain why your plan is safe.",
  "Constraints: there must be no downtime, invoices must stay strongly consistent, and rollback must take at most 10 minutes.",
  "Which step is riskiest? How would you test it before the cutover?",
].join(" ");
const MEDIUM =
  "Write a TypeScript function that groups an array of orders by customer id and returns the total per customer.";

/** Runs every scenario and returns the transcript shown in the README. */
export async function runDemo(): Promise<string> {
  lines.length = 0;
  out("Routing by complexity (tenant acme, model=auto)");
  out();
  const app = start();
  await send(app, "Easy: sentiment classification", EASY);
  await send(app, "Medium: small coding task", MEDIUM);
  await send(app, "Hard: multi-constraint design question", HARD);
  await send(app, "Same easy request again (temperature 0)", EASY);

  out("Per-request controls");
  out();
  await send(app, "Hard question with x-llm-gateway-max-cost-usd: 0.004", HARD, {
    headers: { "x-llm-gateway-max-cost-usd": "0.004", "x-llm-gateway-cache": "off" },
  });
  await send(app, "Hard question for tenant globex (latency SLO 5000 ms)", HARD, {
    key: "sk-local-globex-demo",
  });
  await send(app, "Pinned model, bypassing the router", EASY, {
    model: "mock-large-alt",
    headers: { "x-llm-gateway-cache": "off" },
  });

  out("Failure handling: mock-large forced to fail every call");
  out();
  const failing = start((config) => {
    const large = config.models.find((m) => m.id === "mock-large");
    if (large?.mock) large.mock.failureRate = 1;
  });
  for (let i = 1; i <= 3; i++) {
    await send(failing, `Hard question #${i}`, `${HARD} (variant ${i})`);
  }

  const usage = await app.request("/v1/usage", {
    headers: { authorization: "Bearer sk-local-acme-demo" },
  });
  out("GET /v1/usage (acme)");
  out(`  ${JSON.stringify(await usage.json())}`);
  out();
  const metrics = await (await failing.request("/metrics")).text();
  out("GET /metrics (excerpt, failing gateway)");
  for (const line of metrics.split("\n")) {
    if (
      line.startsWith("llm_gateway_upstream_attempts_total") ||
      line.startsWith("llm_gateway_breaker_state")
    ) {
      out(`  ${line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(await runDemo());
}
