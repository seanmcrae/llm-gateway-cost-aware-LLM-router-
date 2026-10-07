import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import {
  ChatCompletionRequestSchema,
  normalizeRequest,
  type ChatCompletion,
} from "../api/schema.js";
import type { TenantConfig } from "../config/schema.js";
import { GatewayError } from "../core/errors.js";
import type { Gateway, RequestOptions } from "../gateway/gateway.js";
import type { RequestEvent } from "../telemetry/events.js";

type Env = { Variables: { tenant: TenantConfig } };

const MAX_BODY_BYTES = 1024 * 1024;

function errorResponse(c: Context, error: GatewayError): Response {
  if (error.retryAfterMs !== undefined) {
    c.header("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
  }
  return c.json(error.toBody(), error.status as 400);
}

const headerSafe = (value: string) => value.replace(/[^\x20-\x7e]/g, "?").slice(0, 512);

/** Routing and cost metadata on every response, so clients can audit what the gateway did. */
function setGatewayHeaders(c: Context, event: RequestEvent): void {
  c.header("x-request-id", event.requestId);
  c.header("x-llm-gateway-model", event.model ?? "");
  c.header("x-llm-gateway-tier", event.tier ?? "");
  c.header("x-llm-gateway-policy", event.policy);
  c.header("x-llm-gateway-cache", event.cache);
  c.header("x-llm-gateway-cost-usd", event.costUsd.toFixed(8));
  c.header("x-llm-gateway-latency-ms", String(event.latencyMs));
  c.header("x-llm-gateway-attempts", String(event.attempts.length));
  c.header("x-llm-gateway-route", headerSafe(event.routeReason));
}

function numberHeader(c: Context, name: string): number | undefined {
  const raw = c.req.header(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new GatewayError(
      400,
      "invalid_request_error",
      "invalid_header",
      `${name} must be a positive number`,
    );
  }
  return value;
}

function requestOptions(c: Context<Env>): RequestOptions {
  const cache = c.req.header("x-llm-gateway-cache");
  if (cache !== undefined && cache !== "on" && cache !== "off") {
    throw new GatewayError(
      400,
      "invalid_request_error",
      "invalid_header",
      "x-llm-gateway-cache must be on or off",
    );
  }
  const maxCostUsd = numberHeader(c, "x-llm-gateway-max-cost-usd");
  const latencySloMs = numberHeader(c, "x-llm-gateway-latency-slo-ms");
  return {
    tenant: c.get("tenant"),
    ...(cache !== undefined && { cache }),
    ...(maxCostUsd !== undefined && { maxCostUsd }),
    ...(latencySloMs !== undefined && { latencySloMs }),
  };
}

/**
 * Streaming is buffered: the full completion is produced first (so retries and fallbacks stay
 * invisible to the client) and then sent as OpenAI-style chunks. Clients that require
 * `stream: true` work unchanged; time-to-first-token is not improved.
 */
function streamCompletion(c: Context, completion: ChatCompletion): Response {
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  const choice = completion.choices[0];
  const pieces = choice.message.content.match(/\S+\s*/g) ?? [];
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      data: JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }),
    });
    for (let i = 0; i < pieces.length; i += 8) {
      const content = pieces.slice(i, i + 8).join("");
      await stream.writeSSE({
        data: JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        }),
      });
    }
    await stream.writeSSE({
      data: JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
        usage: completion.usage,
      }),
    });
    await stream.writeSSE({ data: "[DONE]" });
  });
}

export function createApp(gateway: Gateway): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((error, c) => {
    if (error instanceof GatewayError) return errorResponse(c, error);
    return errorResponse(
      c,
      new GatewayError(500, "server_error", "internal_error", "Internal gateway error."),
    );
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/metrics", (c) =>
    c.text(gateway.metrics.render(), 200, { "content-type": "text/plain; version=0.0.4" }),
  );

  app.use("/v1/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const key = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
    const tenant = key ? gateway.authenticate(key) : undefined;
    if (!tenant) {
      throw new GatewayError(
        401,
        "authentication_error",
        "invalid_api_key",
        "Missing or unknown API key.",
      );
    }
    c.set("tenant", tenant);
    await next();
  });

  app.get("/v1/models", (c) => {
    const { routing, models } = gateway.config;
    const ids = ["auto", ...routing.tiers, ...models.map((m) => m.id)];
    return c.json({
      object: "list",
      data: ids.map((id) => ({ id, object: "model", owned_by: "llm-gateway" })),
    });
  });

  app.get("/v1/usage", (c) =>
    c.json({ tenant: c.get("tenant").id, ...gateway.usage(c.get("tenant")) }),
  );

  app.post(
    "/v1/chat/completions",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new GatewayError(
          413,
          "invalid_request_error",
          "request_too_large",
          "Request body exceeds 1 MB.",
        );
      },
    }),
    async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new GatewayError(
          400,
          "invalid_request_error",
          "invalid_json",
          "Request body is not valid JSON.",
        );
      }
      const parsed = ChatCompletionRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
        throw new GatewayError(
          400,
          "invalid_request_error",
          "invalid_request",
          `${where}${issue?.message ?? "invalid request"}`,
        );
      }
      const request = normalizeRequest(parsed.data);
      const { completion, event } = await gateway.handle(request, requestOptions(c));
      setGatewayHeaders(c, event);
      return request.stream ? streamCompletion(c, completion) : c.json(completion);
    },
  );

  return app;
}
