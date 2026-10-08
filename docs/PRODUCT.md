# llm-gateway: product brief

## Problem

Teams that ship LLM features usually pick one model per feature and send it every request. The
choice is made once, for the hardest case the team can think of, so a premium model ends up
classifying sentiment and extracting order numbers at an order of magnitude more per token than a
model that would do those jobs as well. Three other problems arrive with that setup:

- **Cost is invisible per request.** Provider invoices are per account, not per feature or
  customer, so nobody can say which tenant or endpoint is spending the money until the bill arrives.
- **One provider is a single point of failure.** 429s, 529 "overloaded" responses and timeouts are
  routine. Without retries, backoff and a second provider, each one becomes a user-facing error.
- **Budgets are enforced after the fact.** A runaway loop or a heavy customer can spend a month's
  budget in an afternoon, because nothing checks spend before calling the model.

A gateway in front of the providers can fix all four in one place, but only if switching to it
costs a client nothing (same API) and its routing decisions are explainable enough to trust.

## Users and jobs to be done

| User                                               | Job                                                                                 | What they need from the gateway                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Application engineer adding an LLM feature         | "Call a model without deciding which one, and without writing retry code."          | Drop-in OpenAI-compatible endpoint, `model: "auto"`, sane failure behaviour                                |
| Platform or infra engineer                         | "Give every team LLM access with limits, and keep it up when a provider is down."   | Per-tenant keys, rate limits, budgets, breakers, fallbacks, Prometheus metrics                             |
| Engineering or product lead who owns the AI budget | "Know what each feature costs and cut it without a quality regression I can't see." | Per-request cost telemetry, a benchmark that shows the quality/cost trade-off before a policy change ships |
| Finance or ops partner                             | "No surprise invoices."                                                             | Hard monthly budgets with reservations, downgrade before the limit, usage endpoint                         |

## Scope

**In (v0.1):**

- `POST /v1/chat/completions` compatible with OpenAI clients, including buffered streaming.
- Routing policies: complexity-routed, fixed tier, pinned model; per-request cost cap and latency
  SLO; budget-aware downgrade.
- Fallback chain, retries with jittered backoff, per-attempt timeouts, per-model circuit breakers.
- Exact and semantic response caching for deterministic requests, scoped per tenant.
- Per-tenant API keys, requests-per-minute and tokens-per-minute limits, monthly budgets.
- JSONL request events and Prometheus metrics.
- OpenAI-compatible and Anthropic adapters; deterministic mock provider as the default.
- Offline replay benchmark with a synthetic prompt set, and a static docs site.

**Out (for now):**

- Tool calling, function calling, `n > 1`, images, audio and the embeddings endpoint.
- Token-by-token streaming passthrough (streaming is buffered).
- Shared state across instances (Redis or a database), an admin UI, SSO.
- Prompt or response content filtering, PII redaction.
- Billing and invoicing; the gateway reports cost, it does not charge for it.

## Requirements

Functional:

1. An unmodified OpenAI SDK pointed at the gateway's base URL works for chat completions.
2. Every response states the model, tier, policy, cache result, cost and route reason in headers,
   and every request (success or failure) produces exactly one telemetry event.
3. A request never starts if its worst-case cost exceeds the tenant's remaining budget.
4. Transient upstream errors (429, 5xx, 529, timeouts, network) are retried with backoff and then
   fall back to another model; client errors (400) are not retried; auth errors skip the model.
5. A model whose breaker is open is skipped without spending an attempt.
6. Cached answers are never shared across tenants and are only used for temperature-0 requests
   unless the client opts in.
7. Invalid configs fail at startup with every problem listed.

Non-functional:

- Routing overhead is regexes and counts, no extra model call on the hot path.
- Runs with no API keys and no network by default; tests and CI never touch the network.
- Deterministic under test: time, sleep and randomness are injected.

## Success metrics and evals

The gateway measures itself with a replay benchmark (`npm run bench`, method in
[bench/README.md](../bench/README.md)) on the bundled synthetic prompt set. Thresholds are tuned
on the dev split and reported on the test split. Current numbers (test split, 300 prompts,
simulated providers):

| Metric               | Target for a policy change                           | Current (routed vs always-premium)                        |
| -------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Cost per 1k requests | Lower, with the change explained                     | $0.44 vs $1.26 (65% lower)                                |
| Quality proxy        | No more than the agreed drop vs the premium baseline | 86.0% vs 98.3%                                            |
| p50 / p95 latency    | No p95 regression beyond the tenant's SLO            | 684 / 3472 ms vs 1910 / 4099 ms                           |
| False cache hits     | Zero for any cache mode that is on by default        | Exact: 0 of 84 hits. Semantic: 35 of 129 (off by default) |
| Quality per category | No category collapses silently                       | `tricky` prompts: 8% routed vs 100% premium               |

The last row is why the benchmark reports per-category quality: the routed policy's aggregate
looks acceptable while one category fails almost completely. In a real deployment the same
metrics would come from the telemetry log (`costUsd`, `premiumCostUsd` for savings, `latencyMs`,
`fallbacks`, `retries`, cache hit rate) plus a sampled offline grader for quality.

Operational metrics on `/metrics`: request count by status and cache result, spend by tenant and
model, upstream attempts by outcome, latency histogram, breaker state per model.

## Minimum viable quality

Thresholds for shipping a routing policy or config change, read off the replay benchmark's test
split. They are stated against the fixed-tier baselines in the same run, so they still mean
something when prices or capabilities change. All quality figures are the simulated proxy.

| Metric                                  | Do not ship                                                                         | Ship                     | Delight                            | Current default (routed 0.25/0.5, exact cache)    |
| --------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------ | ---------------------------------- | ------------------------------------------------- |
| Quality proxy                           | Below always-standard (80.0%): a fixed mid tier would beat routing                  | At least 85%             | At least 92%                       | 86.0%: ship                                       |
| Cost per 1k vs always-premium ($1.26)   | More than 50% of it                                                                 | At most 50%              | At most 30%                        | $0.34, 27%: delight                               |
| p95 latency                             | Above always-premium (4,099 ms)                                                     | At most always-premium   | At most always-standard (2,042 ms) | 3,351 ms: ship                                    |
| False cache hits, default-on cache mode | Any                                                                                 | Zero                     | Zero                               | 0 of 84: ship                                     |
| Worst category                          | Below always-cheap in that category (routing made it worse than the cheapest model) | At or above always-cheap | Every category at 50% or more      | `tricky` 8% vs 4% always-cheap: ship, not delight |

The default clears the ship bar and misses delight on quality and on the worst category, both for
the same reason (`tricky` prompts, issue #6). In the threshold sweep, 0.1/0.3 reaches delight on
quality (92.7%) and on the category floor (lowest is `tricky` at 52%) while staying at ship on cost
(44% of premium). That was observed on the test split, so it cannot be adopted without re-tuning on
dev first.

## Cost at 1x and 10x usage

Estimates only: measured cost per 1k requests from `bench/results.json` multiplied by a volume.
The per-token prices in `config/default.json` are illustrative tier shapes (cheap $0.15 / $0.60,
standard $0.80 / $3.20, premium $3 / $15 per million input / output tokens), not vendor quotes, and
nothing here comes from a real deployment. **1x is a round 1M requests per month**, chosen for
illustration; the prompt mix is assumed to match the synthetic test split.

| Policy                         | $ per 1k requests | 1x: 1M requests / month | 10x: 10M requests / month |
| ------------------------------ | ----------------: | ----------------------: | ------------------------: |
| always-premium (baseline)      |             1.259 |            about $1,260 |             about $12,600 |
| always-standard                |             0.290 |              about $290 |              about $2,900 |
| routed, no cache               |             0.442 |              about $440 |              about $4,420 |
| routed + exact cache (default) |             0.345 |              about $345 |              about $3,450 |

Against always-premium, the default saves about $910 a month at 1x and about $9,100 at 10x. For
scale, the demo tenant's $50 monthly budget in `config/default.json` covers about 145k requests at
the default's cost per 1k.

What does not scale linearly:

- **Cache savings depend on repetition, not volume.** The test split repeats about a third of its
  questions; real traffic with fewer exact repeats gets closer to the no-cache line.
- **State is per process.** At 10x a single instance is unlikely to be enough, and budgets, rate
  limits and breakers then need a shared store (Redis on the roadmap). That infrastructure, and the
  gateway's own compute, are not in these figures.
- **Routing quality, not price, is the larger risk at volume.** At 10x the 25 `tricky` prompts in
  300 become roughly 830k cheap-tier answers a month at 8% proxy quality, if the mix holds.

## Trade-offs and alternatives considered

- **Heuristic router vs learned router vs LLM-as-router.** A classifier trained on graded traffic
  would beat regexes, and asking a small model to rate difficulty would catch the "short but hard"
  prompts the heuristic misses. Both need labelled data or add a model call to every request. The
  heuristic ships first because it is free, explainable in a response header, and gives the
  benchmark a baseline any learned router has to beat.
- **Cascade (try cheap, escalate on low confidence) vs route up front.** A cascade can be more
  accurate but pays for two calls and two latencies on every escalation, and needs a confidence
  signal the providers do not expose consistently. Route-up-front plus fallback keeps one call per
  request in the common case.
- **Semantic cache on vs off by default.** It served about 50% more hits than exact matching on the
  benchmark, and on the same run 27% of its hits answered a different question. For templated
  prompts that differ in one detail, embedding similarity is the wrong signal. Exact caching is the
  default; semantic caching is opt-in per deployment.
- **Buffered vs passthrough streaming.** Passthrough improves time to first token but makes
  fallback after the first byte impossible to hide. v0.1 buffers, so failures stay invisible.
- **In-memory vs shared state.** In-memory state keeps the gateway a single binary with no
  dependencies; it means budgets and rate limits are per instance. Acceptable for one instance or
  a sidecar, not for a horizontally scaled deployment.
- **Build vs adopt.** Hosted routers and open-source proxies exist. Building this one is about
  owning the policy layer (budget reservations, SLO-aware ordering, explainable routing) and a
  benchmark that makes policy changes reviewable, not about the proxying.

## Risks

| Risk                                                                    | Likelihood                         | Impact | Mitigation                                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| Router sends hard prompts to the cheap tier and quality drops unnoticed | High (measured: `tricky` category) | High   | Per-category quality in the benchmark; pin or fix the tier for sensitive endpoints; learned router on the roadmap |
| Benchmark does not reflect real traffic                                 | High                               | Medium | Replay real (consented, scrubbed) traffic with a real grader before trusting absolute numbers                     |
| Semantic cache returns a wrong answer                                   | Measured on the synthetic set      | High   | Off by default; exact cache only for temperature 0; threshold and false-hit rate reported                         |
| Budget overshoot across instances                                       | Medium when scaled out             | Medium | Single instance per budget today; shared ledger on the roadmap                                                    |
| Provider price changes make cost numbers wrong                          | Medium                             | Low    | Prices are config, not code; telemetry records the price used at the time                                         |
| Gateway becomes a new single point of failure                           | Medium                             | High   | Stateless apart from caches and counters; run more than one behind a load balancer once state is shared           |

## Roadmap

**Now (v0.1, this repository):** OpenAI-compatible endpoint, heuristic routing with budget, cost
cap and SLO constraints, fallback chain with retries and breakers, exact and semantic caching,
per-tenant limits and budgets, JSONL and Prometheus telemetry, OpenAI-compatible and Anthropic
adapters, synthetic replay benchmark and docs site.

**Next:**

- Replay mode against real providers with an LLM or rubric grader, so the quality proxy can be
  replaced by measured quality on a team's own prompts.
- Learned router (logistic regression on the existing features plus embedding features), compared
  against the heuristic on the same replay.
- Shared state in Redis for budgets, rate limits and breakers.
- Token-by-token streaming passthrough for the primary attempt, with buffered fallback.
- Per-tenant routing overrides by endpoint or prompt tag.

**Later:**

- Cascade policy (cheap first, escalate on a self-check) as a third policy in the benchmark.
- Tool calling passthrough.
- Cost anomaly alerts from the telemetry stream.
- Admin UI for tenants, keys and budgets.
