# Replay benchmark

`npm run bench` replays the 300-prompt test split of `prompts.synthetic.jsonl` through the
gateway's real HTTP app, once per policy, and writes `results.json`. `npm run bench -- --split dev`
runs the 300-prompt dev split and only prints. A test fails if `results.json` drifts from what the
code produces.

## Data: synthetic, generated, no third-party content

`prompts.synthetic.jsonl` is **synthetic**. Every prompt is produced by `generate.ts` from
hand-written templates and word lists with a fixed seed (`npm run bench:generate` recreates the file
byte for byte; a test checks this). It contains no scraped, licensed or user data and is released
under the repository's MIT license. Product names, people and cities in it are fillers.

Each line has:

| Field                   | Meaning                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`, `split`           | `dev-0001` ... / `test-0001` ...; the splits use different seeds                                              |
| `category`              | Template family: classify, extract, rewrite, summarize, qa, code, debug, sql, math, tricky, design, long-easy |
| `difficulty`            | 1-5, assigned by the template, the same for every copy of a prompt                                            |
| `group`                 | Items in one group ask the same question (verbatim repeats and cosmetic near-duplicates)                      |
| `messages`, `maxTokens` | What the gateway receives                                                                                     |

The mix is weighted towards easy requests, as assistant-style traffic usually is. Two families are
there to keep the router honest: `tricky` (short prompts such as time-zone or number puzzles that
are hard but carry no obvious complexity cues) and `long-easy` (a long transcript followed by a
trivial question). About a third of requests repeat an earlier question: 15% by construction
(verbatim, or with cosmetic edits to casing, punctuation or a polite prefix) and the rest because
short templates recombine into identical prompts, the way common requests recur in real traffic.

## What is measured

- **Quality proxy.** The gateway only sees the prompt. Afterwards, the harness reads which model
  answered (the `x-llm-gateway-model` header) and scores the answer as acceptable with probability
  `sigmoid(2 (capability - difficulty) + 1)`, where `capability` is the model's simulated capability
  in `config/default.json` (cheap 2.3, standard 3.4, premium 4.6 and 4.5). The random draw is fixed
  per group, so a stronger model never fails a prompt a weaker one passes. A cache hit counts as
  acceptable only if the reused answer was acceptable **and** belonged to the same group; a hit
  from a different group is a false cache hit and scores zero.
- **Cost per 1k requests.** Sum of the `x-llm-gateway-cost-usd` headers (provider-reported tokens
  times the configured per-token prices), divided by requests, times 1000.
- **p50 / p95 latency.** Gateway-measured end-to-end latency per request, including retries and
  backoff, from the mock provider's latency model on a virtual clock. Requests run sequentially, so
  this is service time, not latency under concurrent load.

## How the default thresholds were chosen

The complexity weights in `src/routing/complexity.ts` were written by hand. The tier thresholds
were then picked on the **dev** split from the sweep in `run.ts`: 0.25 / 0.5 was the cheapest point
within about 7 points of always-premium on dev (91.0% vs 98.3% at $0.42 vs $1.17 per 1k). The
README and docs site report the **test** split, which was not used for tuning. Test results are
worse than dev (86.0% for the same thresholds), mainly because the test split has more `tricky`
prompts, which the heuristic sends to the cheap tier.

## Limitations

- The quality proxy encodes an assumption about how capability relates to difficulty. It shows
  what the routing policy does under that assumption; it is not evidence about any real model.
  Replaying real traffic against real providers with a grader is the next step (see
  docs/PRODUCT.md).
- Prices and latency profiles are illustrative, not vendor quotes.
- The heuristic was designed with these template families in view, so the dev/test split guards
  against threshold overfitting but not against the heuristic itself fitting the generator. Real
  traffic should be expected to score lower.
