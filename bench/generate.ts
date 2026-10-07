/**
 * Generates the synthetic replay set: `npm run bench:generate`. Seeded, so the committed
 * bench/prompts.synthetic.jsonl is reproducible byte for byte (a test checks this).
 *
 * The mix imitates an assistant-style workload where most traffic is easy (classification,
 * extraction, rewriting, short answers) and a minority needs a capable model (debugging,
 * multi-constraint design, multi-step arithmetic). Two families exist to keep the router
 * honest: short prompts that are hard but carry no obvious complexity cues, and long prompts
 * that are easy. 15% of items deliberately repeat an earlier request, verbatim or with
 * cosmetic edits, which is what the cache benchmark exercises.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { seededRandom, type Random } from "../src/core/random.js";
import { DATASET_PATH, type BenchItem } from "./dataset.js";

export const SEED = 20261007;
export const ITEMS_PER_SPLIT = 300;

const pick = <T>(rng: Random, values: readonly T[]): T => {
  const value = values[Math.floor(rng() * values.length)];
  if (value === undefined) throw new Error("pick from empty list");
  return value;
};
const int = (rng: Random, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

const PRODUCTS = [
  "standing desk",
  "noise-cancelling headphones",
  "espresso machine",
  "trail running shoes",
  "mesh router",
  "robot vacuum",
  "e-reader",
  "air purifier",
  "mechanical keyboard",
  "camping stove",
];
const PRAISE = [
  "works exactly as described",
  "setup took two minutes",
  "battery lasts all week",
  "support answered within an hour",
  "build quality feels premium",
  "quieter than I expected",
];
const COMPLAINTS = [
  "stopped working after a week",
  "arrived with a cracked panel",
  "the app keeps logging me out",
  "refund took a month",
  "instructions were missing",
  "louder than advertised",
];
const NAMES = [
  "Priya Natarajan",
  "Tomás Ortega",
  "Mei Chen",
  "Oluwaseun Adeyemi",
  "Hannah Becker",
  "Arjun Mehta",
  "Sofia Rossi",
  "Liam O'Connor",
  "Yuki Tanaka",
  "Amara Okafor",
];
const CITIES = [
  "Toronto",
  "Lisbon",
  "Nairobi",
  "Osaka",
  "Denver",
  "Lyon",
  "Melbourne",
  "Pune",
  "Bogotá",
  "Krakow",
];
const LANGS = ["French", "Spanish", "German", "Portuguese", "Japanese", "Hindi"];
const PHRASES = [
  "Your order has shipped and should arrive on Thursday.",
  "Please confirm your email address to finish signing up.",
  "The meeting has been moved to 3 pm tomorrow.",
  "We could not process your payment; please update your card.",
  "Thanks for your feedback, we have passed it to the team.",
  "Your subscription renews on the first of next month.",
];
const TOPICS = [
  "a billing service",
  "an order pipeline",
  "a search index",
  "a notification system",
  "a feature flag service",
  "a document store",
  "an analytics ingestion job",
  "a payments ledger",
];
const STORES = ["Postgres", "MySQL", "DynamoDB", "Cassandra", "MongoDB", "Redis"];
const CONCEPTS = [
  ["a process", "a thread"],
  ["TCP", "UDP"],
  ["a list", "a tuple in Python"],
  ["an index", "a primary key"],
  ["authentication", "authorization"],
  ["latency", "throughput"],
  ["a mutex", "a semaphore"],
  ["REST", "GraphQL"],
] as const;
const FILLER = [
  "The quarterly review covered hiring, budget and roadmap progress across the three product teams.",
  "Customer interviews highlighted onboarding friction and requests for better export options.",
  "Infrastructure costs rose slightly because of increased storage and a new staging environment.",
  "The support backlog fell after the new triage rotation started in the second month.",
  "Two experiments on the pricing page were inconclusive and will be rerun with more traffic.",
  "Security completed the annual access review and rotated all long-lived credentials.",
  "Marketing shifted spend from paid search to partner webinars, with similar lead volume.",
  "The mobile release slipped by one week to fix a crash affecting older Android devices.",
];

interface Draft {
  category: string;
  difficulty: number;
  user: string;
  system?: string;
  maxTokens: number;
}

type Template = (rng: Random) => Draft;

const paragraph = (rng: Random, sentences: number) =>
  Array.from({ length: sentences }, () => pick(rng, FILLER)).join(" ");

const TEMPLATES: { weight: number; make: Template }[] = [
  {
    weight: 12,
    make: (rng) => {
      const good = rng() < 0.5;
      return {
        category: "classify",
        difficulty: 1,
        user: `Classify the sentiment of this review as positive, negative or neutral. Reply with one word.\n\nReview: "The ${pick(rng, PRODUCTS)} ${pick(rng, good ? PRAISE : COMPLAINTS)}."`,
        maxTokens: 16,
      };
    },
  },
  {
    weight: 10,
    make: (rng) => ({
      category: "extract",
      difficulty: rng() < 0.7 ? 1 : 2,
      user: `Extract the customer name, city and order number from this message as JSON with keys name, city, order.\n\n"Hi, this is ${pick(rng, NAMES)} from ${pick(rng, CITIES)}. My order ${int(rng, 10000, 99999)} still shows as processing."`,
      maxTokens: 80,
    }),
  },
  {
    weight: 10,
    make: (rng) =>
      rng() < 0.5
        ? {
            category: "rewrite",
            difficulty: 1,
            user: `Translate to ${pick(rng, LANGS)}: "${pick(rng, PHRASES)}"`,
            maxTokens: 60,
          }
        : {
            category: "rewrite",
            difficulty: 2,
            user: `Rewrite this message so it sounds warmer but stays under 40 words: "${pick(rng, PHRASES)} ${pick(rng, PHRASES)}"`,
            maxTokens: 80,
          },
  },
  {
    weight: 8,
    make: (rng) => ({
      category: "summarize",
      difficulty: 2,
      user: `Summarize the following update in two sentences for an executive audience.\n\n${paragraph(rng, int(rng, 6, 14))}`,
      maxTokens: 120,
    }),
  },
  {
    weight: 10,
    make: (rng) => {
      const [a, b] = pick(rng, CONCEPTS);
      return {
        category: "qa",
        difficulty: rng() < 0.6 ? 1 : 2,
        user: `What is the difference between ${a} and ${b}? Keep it short.`,
        maxTokens: 150,
      };
    },
  },
  {
    weight: 9,
    make: (rng) => {
      const tasks = [
        "groups an array of orders by customer id and returns the total amount per customer",
        "returns the n most frequent words in a string, ignoring case and punctuation",
        "validates an email address and returns a typed result instead of throwing",
        "chunks an array into arrays of a given size",
        "debounces a callback by a given number of milliseconds",
        "parses an ISO 8601 duration such as PT1H30M into seconds",
      ];
      return {
        category: "code",
        difficulty: rng() < 0.6 ? 2 : 3,
        user: `Write a ${pick(rng, ["TypeScript", "Python", "Go"])} function that ${pick(rng, tasks)}. Include one usage example.`,
        maxTokens: 350,
      };
    },
  },
  {
    weight: 8,
    make: (rng) => {
      const bugs = [
        "function last(xs) {\n  return xs[xs.length];\n}",
        "def mean(xs):\n    return sum(xs) / len(xs) if xs else sum(xs) / 1",
        "for (let i = 0; i <= items.length; i++) {\n  total += items[i].price;\n}",
        "async function load(ids) {\n  const out = [];\n  ids.forEach(async (id) => out.push(await fetchItem(id)));\n  return out;\n}",
        "if user.role == 'admin' or 'owner':\n    grant_access(user)",
        "const cache = {};\nfunction get(key) {\n  if (cache[key]) return cache[key];\n  return (cache[key] = compute(key));\n}",
      ];
      return {
        category: "debug",
        difficulty: rng() < 0.5 ? 3 : 4,
        user: `This code has a bug that only shows up in production. Find the root cause, explain why it happens and fix it.\n\n\`\`\`\n${pick(rng, bugs)}\n\`\`\``,
        maxTokens: 400,
      };
    },
  },
  {
    weight: 5,
    make: (rng) => ({
      category: "sql",
      difficulty: 3,
      user: `Write a SQL query for ${pick(rng, ["Postgres", "MySQL", "SQLite"])} that returns, for each month of ${int(rng, 2023, 2025)}, the number of customers whose first order was in that month and who ordered again within ${int(rng, 2, 6)} weeks. Tables: orders(id, customer_id, created_at, total).`,
      maxTokens: 300,
    }),
  },
  {
    weight: 7,
    make: (rng) => {
      const a = int(rng, 3, 9);
      const b = int(rng, 12, 40);
      const c = int(rng, 2, 5);
      return {
        category: "math",
        difficulty: rng() < 0.5 ? 3 : 4,
        user: `A warehouse ships ${a} pallets per hour for the first ${c} hours, then ${b}% more per hour for the rest of an 8 hour shift. Each pallet holds ${int(rng, 20, 60)} boxes and ${int(rng, 2, 6)}% of boxes are returned. Step by step, how many boxes are kept per shift?`,
        maxTokens: 300,
      };
    },
  },
  {
    weight: 5,
    make: (rng) => {
      const puzzles = [
        `A meeting starts at 23:${int(rng, 10, 50)} UTC on a Sunday and lasts ${int(rng, 70, 150)} minutes. What day and time is it in Tokyo when it ends?`,
        `I have ${int(rng, 3, 7)} red socks and ${int(rng, 3, 7)} blue socks in a drawer. In the dark, how many must I take to be sure of a matching pair, and of a red pair?`,
        `Is ${pick(rng, ["1,000,003", "999,983", "1,000,009", "999,997"])} prime? Show the smallest factor if not.`,
        `A bat and a ball cost $${int(rng, 2, 5)}.10 together. The bat costs $${int(rng, 1, 2)} more than the ball. How much is the ball?`,
        `Which is larger: 2 to the power ${int(rng, 30, 40)} or 10 to the power ${int(rng, 9, 12)}?`,
      ];
      return { category: "tricky", difficulty: 4, user: pick(rng, puzzles), maxTokens: 200 };
    },
  },
  {
    weight: 9,
    make: (rng) => {
      const topic = pick(rng, TOPICS);
      const from = pick(rng, STORES);
      const to = pick(
        rng,
        STORES.filter((s) => s !== from),
      );
      const hard = rng() < 0.5;
      const constraints = [
        "There must be no downtime.",
        "Writes must stay strongly consistent.",
        "Rollback must take at most 15 minutes.",
        `Peak load is ${int(rng, 2, 20)}k requests per second.`,
        "The team has two engineers for one quarter.",
      ].slice(0, hard ? 5 : 3);
      return {
        category: "design",
        difficulty: hard ? 5 : 4,
        system: "You are a staff engineer reviewing designs.",
        user: `Design a plan to migrate ${topic} from ${from} to ${to}. Analyze the trade-offs of the main options and explain why your recommendation is safe.\n\nConstraints:\n${constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nWhat is the riskiest step, and how would you test it?`,
        maxTokens: 700,
      };
    },
  },
  {
    weight: 7,
    make: (rng) => ({
      category: "long-easy",
      difficulty: 1,
      user: `Here is a meeting transcript.\n\n${paragraph(rng, int(rng, 25, 45))}\n\nWhat was the first topic mentioned? Answer in a few words.`,
      maxTokens: 30,
    }),
  },
];

/** Cosmetic edits that keep the request's meaning: casing, punctuation and a polite prefix. */
function nearDuplicate(rng: Random, text: string): string {
  const edits = [
    (t: string) => `Please help: ${t}`,
    (t: string) => t.toLowerCase(),
    (t: string) => t.replace(/[.?!]("?)\s*$/, "$1"),
    (t: string) => `${t} Thanks!`,
  ];
  return pick(rng, edits)(text);
}

function generateSplit(split: "dev" | "test", seed: number, count: number): BenchItem[] {
  const rng = seededRandom(seed);
  const totalWeight = TEMPLATES.reduce((sum, t) => sum + t.weight, 0);
  const items: BenchItem[] = [];
  // Template combinations can recreate an earlier prompt exactly. It is the same question, so
  // it keeps the first occurrence's group and difficulty.
  const seen = new Map<string, { group: string; difficulty: number }>();
  while (items.length < count) {
    const id = `${split}-${String(items.length + 1).padStart(4, "0")}`;
    const roll = rng();
    if (items.length > 20 && roll < 0.1) {
      const source = pick(rng, items);
      items.push({ ...source, id });
      continue;
    }
    if (items.length > 20 && roll < 0.15) {
      const source = pick(rng, items);
      const messages = source.messages.map((m, i) =>
        i === source.messages.length - 1 ? { ...m, content: nearDuplicate(rng, m.content) } : m,
      );
      items.push({ ...source, id, messages });
      continue;
    }
    let r = rng() * totalWeight;
    const template = TEMPLATES.find((t) => (r -= t.weight) < 0) ?? TEMPLATES[0];
    if (!template) throw new Error("no templates");
    const draft = template.make(rng);
    const messages = [
      ...(draft.system ? [{ role: "system" as const, content: draft.system }] : []),
      { role: "user" as const, content: draft.user },
    ];
    const text = JSON.stringify(messages);
    const first = seen.get(text) ?? { group: id, difficulty: draft.difficulty };
    seen.set(text, first);
    items.push({
      id,
      split,
      category: draft.category,
      difficulty: first.difficulty,
      group: first.group,
      messages,
      maxTokens: draft.maxTokens,
    });
  }
  return items;
}

export function generateItems(): BenchItem[] {
  return [
    ...generateSplit("dev", SEED, ITEMS_PER_SPLIT),
    ...generateSplit("test", SEED + 1, ITEMS_PER_SPLIT),
  ];
}

export function serialize(items: BenchItem[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const items = generateItems();
  writeFileSync(DATASET_PATH, serialize(items));
  process.stdout.write(`Wrote ${items.length} items to bench/prompts.synthetic.jsonl\n`);
}
