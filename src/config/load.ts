import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseConfig, type GatewayConfig } from "./schema.js";

/** The bundled all-mock config, resolved from both src/ (tsx) and dist/ (built). */
export const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL("../../config/default.json", import.meta.url),
);

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): GatewayConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseConfig(raw);
}
