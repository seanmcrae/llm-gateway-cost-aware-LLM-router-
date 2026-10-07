import { kindForStatus, parseRetryAfter, ProviderError } from "../core/errors.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * POSTs JSON with a per-attempt timeout and turns every failure into a ProviderError. The
 * response body of a failed call is included (truncated) because vendors put the actionable
 * part of the error there.
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (timeout.aborted) throw new ProviderError("timeout", `no response within ${timeoutMs} ms`);
    throw new ProviderError("network", `request to ${url} failed: ${String(error)}`);
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(
      kindForStatus(response.status),
      `upstream returned ${response.status}: ${text}`,
      response.status,
      parseRetryAfter(response.headers.get("retry-after"), Date.now()),
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderError("server", "upstream returned a non-JSON body", response.status);
  }
}

export function requireKey(env: NodeJS.ProcessEnv, name: string): string {
  const key = env[name];
  if (!key) throw new Error(`${name} is not set; it is required by a configured model`);
  return key;
}
