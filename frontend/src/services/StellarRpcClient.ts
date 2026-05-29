/**
 * StellarRpcClient – resilient Soroban RPC access with automatic failover.
 *
 * Maintains an ordered list of RPC endpoints and tracks per-endpoint health.
 * On every call it tries the preferred (healthiest) endpoint first; if that
 * endpoint returns an error, times out, or rate-limits (429 / 5xx) it marks
 * it as unhealthy and retries the call on the next endpoint in the list.
 * Endpoints recover automatically after RECOVERY_MS milliseconds.
 */
import { rpc as Soroban } from '@stellar/stellar-sdk';

const RECOVERY_MS = 60_000; // unhealthy endpoints re-enter rotation after 1 min
const REQUEST_TIMEOUT_MS = 10_000;

/** HTTP status codes that trigger failover to the next endpoint. */
const FAILOVER_STATUSES = new Set([429, 500, 502, 503, 504]);

interface EndpointHealth {
  url: string;
  failingSince: number | null; // timestamp when it first failed, null = healthy
}

function isFailoverError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('network') || msg.includes('failed to fetch')) {
      return true;
    }
  }
  // Axios-style or fetch-style status
  const status: number | undefined =
    (err as any)?.response?.status ?? (err as any)?.status;
  if (status !== undefined) return FAILOVER_STATUSES.has(status);
  return false;
}

export class StellarRpcClient {
  private health: EndpointHealth[];

  constructor(private readonly endpoints: readonly string[]) {
    if (endpoints.length === 0) throw new Error('StellarRpcClient: at least one endpoint required');
    this.health = endpoints.map((url) => ({ url, failingSince: null }));
  }

  /** Returns endpoints ordered: healthy first (preserving original priority), unhealthy last. */
  private orderedEndpoints(): EndpointHealth[] {
    const now = Date.now();
    return [...this.health].sort((a, b) => {
      const aHealthy = a.failingSince === null || now - a.failingSince >= RECOVERY_MS;
      const bHealthy = b.failingSince === null || now - b.failingSince >= RECOVERY_MS;
      if (aHealthy === bHealthy) return this.health.indexOf(a) - this.health.indexOf(b);
      return aHealthy ? -1 : 1;
    });
  }

  private markUnhealthy(url: string): void {
    const entry = this.health.find((h) => h.url === url);
    if (entry && entry.failingSince === null) entry.failingSince = Date.now();
  }

  private markHealthy(url: string): void {
    const entry = this.health.find((h) => h.url === url);
    if (entry) entry.failingSince = null;
  }

  /** Exposed for testing. */
  getHealth(): ReadonlyArray<{ url: string; healthy: boolean }> {
    const now = Date.now();
    return this.health.map((h) => ({
      url: h.url,
      healthy: h.failingSince === null || now - h.failingSince >= RECOVERY_MS,
    }));
  }

  /**
   * Execute `fn` against the best available endpoint.
   * `fn` receives a `Soroban.Server` instance and should return a promise.
   * On failover-eligible errors the next endpoint is tried automatically.
   */
  async call<T>(fn: (server: Soroban.Server) => Promise<T>): Promise<T> {
    const ordered = this.orderedEndpoints();
    let lastError: unknown;

    for (const endpoint of ordered) {
      const server = new Soroban.Server(endpoint.url);
      try {
        const result = await Promise.race<T>([
          fn(server),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`RPC timeout after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS),
          ),
        ]);
        this.markHealthy(endpoint.url);
        return result;
      } catch (err) {
        lastError = err;
        if (isFailoverError(err)) {
          this.markUnhealthy(endpoint.url);
          continue;
        }
        // Non-failover error (e.g. bad request) — surface immediately
        throw err;
      }
    }

    throw lastError;
  }
}
