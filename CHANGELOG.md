# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [0.1.0] - 2026-10-07

### Added

- OpenAI-compatible `/v1/chat/completions` endpoint (with buffered SSE streaming), `/v1/models`,
  `/v1/usage`, `/metrics` and `/healthz`, with per-tenant bearer keys.
- Complexity-based routing across configurable model tiers, fixed-tier and pinned-model policies,
  per-request cost caps, latency-SLO ordering and budget-aware downgrade.
- Fallback chain with full-jitter exponential backoff, `Retry-After` support, per-attempt
  timeouts and per-model circuit breakers.
- Exact and semantic response caches scoped per tenant.
- Per-tenant requests-per-minute and tokens-per-minute limits and monthly budgets with
  reservations.
- JSONL request events and Prometheus metrics.
- OpenAI-compatible and Anthropic adapters, and a deterministic mock provider used by default.
- Synthetic replay benchmark comparing always-cheap, always-standard, always-premium and routed
  policies, with and without caching, plus a quality-vs-cost frontier chart.
- Static docs site (`npm run site`) deployed to GitHub Pages.

[0.1.0]: https://github.com/seanmcrae/llm-gateway-cost-aware-LLM-router-/releases/tag/v0.1.0
