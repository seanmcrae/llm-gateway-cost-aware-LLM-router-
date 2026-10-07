#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.js";
import { realSleeper } from "../core/clock.js";
import { Gateway } from "../gateway/gateway.js";
import { buildProviders } from "../providers/factory.js";
import { createApp } from "../server/app.js";
import { JsonlSink, type EventSink } from "../telemetry/events.js";

const USAGE = `Usage: llm-gateway [--config path] [--port 8787] [--host 127.0.0.1] [--log events.jsonl]

Starts the OpenAI-compatible gateway. Without --config it uses the bundled all-mock config,
which needs no API keys. Point any OpenAI client at http://<host>:<port>/v1.`;

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    port: { type: "string", default: process.env.PORT ?? "8787" },
    host: { type: "string", default: "127.0.0.1" },
    log: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const config = loadConfig(values.config);
const logPath = values.log ?? config.telemetry.jsonlPath;
const sinks: EventSink[] = logPath ? [new JsonlSink(logPath)] : [];
const providers = buildProviders(config, { env: process.env, sleeper: realSleeper });
const gateway = new Gateway({ config, providers, sinks });
const port = Number(values.port);

serve({ fetch: createApp(gateway).fetch, port, hostname: values.host }, (info) => {
  const models = config.models.map((m) => `${m.id} (${m.tier})`).join(", ");
  process.stdout.write(
    `llm-gateway listening on http://${values.host}:${info.port}/v1\n` +
      `models: ${models}\n` +
      `tenants: ${config.tenants.map((t) => t.id).join(", ")}` +
      (logPath ? `\ntelemetry: ${logPath}` : "") +
      "\n",
  );
});
