# Security policy

## Supported versions

Only the latest release on `main` receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/seanmcrae/llm-gateway-cost-aware-LLM-router-/security/advisories/new)
rather than a public issue. Include steps to reproduce and the version or commit you tested. You
should get a first response within a week.

## Scope notes

- The server binds to `127.0.0.1` unless you pass `--host` (the Docker image binds to
  `0.0.0.0` inside the container). Request bodies over 1 MB are rejected.
- Tenant API keys are read from the config file, compared by SHA-256 hash and never written to
  telemetry. The keys in `config/default.json` are public demo values: replace them, and load real
  keys from a secret store, before exposing the gateway to a network.
- `GET /metrics` and `GET /healthz` are unauthenticated and expose tenant ids and model names.
  Restrict them at the network layer if that matters in your environment.
- Provider API keys are read from environment variables only and are never logged.
- With real providers configured, prompts and completions are sent to those vendors. The response
  cache holds completions in process memory for `cache.ttlMs`; set `cache.mode` to `off` if
  that is not acceptable.
