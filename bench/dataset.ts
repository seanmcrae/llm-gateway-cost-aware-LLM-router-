import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * One prompt in the synthetic replay set. `difficulty` and `group` are labels for the
 * benchmark only; the gateway sees nothing but `messages` and `maxTokens`.
 */
export const BenchItemSchema = z.object({
  id: z.string(),
  split: z.enum(["dev", "test"]),
  category: z.string(),
  /** 1 (trivial) to 5 (hard), assigned by the generator template. */
  difficulty: z.number().int().min(1).max(5),
  /** Items in the same group ask the same thing, so one answer is correct for all of them. */
  group: z.string(),
  messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() })).min(1),
  maxTokens: z.number().int().positive(),
});

export type BenchItem = z.infer<typeof BenchItemSchema>;

export const DATASET_PATH = new URL("./prompts.synthetic.jsonl", import.meta.url).pathname;

export function loadItems(path = DATASET_PATH): BenchItem[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => BenchItemSchema.parse(JSON.parse(line)));
}
