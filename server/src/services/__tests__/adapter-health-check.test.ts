/**
 * /api/health adapter probe behavior.
 *
 * v0.5.1: replaced a `which claude` CLI probe (false-negative on launchd
 * PATH) with `return true` (less wrong, but a regression of signal value).
 * v0.5.2: replaced the unconditional true with a real reachability probe
 * to api.anthropic.com, cached for ~30s. Auth is not exercised — verifying
 * the OAuth token requires a real query() call which spends rate-limit
 * budget; the deeper probe is deferred. The reachability check still
 * catches the common failures (network outage, DNS/TLS issues, Anthropic
 * edge down) that the previous behaviors masked.
 */

import { describe, it, expect } from "vitest";
import {
  ClaudeAgentSdkAdapter,
  createAdapter,
} from "../subprocess-adapter.js";

describe("ClaudeAgentSdkAdapter.healthCheck", () => {
  it("reports the correct adapter name", () => {
    expect(createAdapter("anthropic-sdk").name).toBe("claude-agent-sdk");
  });

  it("returns true when api.anthropic.com responds (reachable)", async () => {
    const fetcher = (async () =>
      new Response(null, { status: 405 })) as typeof fetch;
    const adapter = new ClaudeAgentSdkAdapter({ fetcher });
    expect(await adapter.healthCheck()).toBe(true);
  });

  it("treats client-status responses as reachable (2xx/3xx/4xx)", async () => {
    // 401/404/405 still count as reachable — they prove DNS+TCP+TLS+the
    // Anthropic edge is up. We're verifying the network path, not
    // endpoint semantics.
    for (const status of [200, 301, 401, 404, 405]) {
      const fetcher = (async () =>
        new Response(null, { status })) as typeof fetch;
      const adapter = new ClaudeAgentSdkAdapter({ fetcher });
      expect(await adapter.healthCheck()).toBe(true);
    }
  });

  it("treats 5xx responses as unhealthy (Anthropic edge up but broken)", async () => {
    // 5xx means the edge accepted the connection but Anthropic itself
    // is failing (overload, deploy bug, dependency outage). SDK calls
    // would fail too — don't lie to /api/health.
    for (const status of [500, 502, 503, 504]) {
      const fetcher = (async () =>
        new Response(null, { status })) as typeof fetch;
      const adapter = new ClaudeAgentSdkAdapter({ fetcher });
      expect(await adapter.healthCheck()).toBe(false);
    }
  });

  it("returns false when the network call throws (unreachable)", async () => {
    const fetcher = (async () => {
      throw new Error("ENETUNREACH");
    }) as typeof fetch;
    const adapter = new ClaudeAgentSdkAdapter({ fetcher });
    expect(await adapter.healthCheck()).toBe(false);
  });

  it("caches the probe result so back-to-back calls don't re-probe", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(null, { status: 405 });
    }) as typeof fetch;

    const adapter = new ClaudeAgentSdkAdapter({ fetcher });
    expect(await adapter.healthCheck()).toBe(true);
    expect(await adapter.healthCheck()).toBe(true);
    expect(await adapter.healthCheck()).toBe(true);

    // First call probes; subsequent calls hit the cache.
    expect(calls).toBe(1);
  });

  it("caches negative results too (a flap doesn't hammer the network)", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      throw new Error("ENETUNREACH");
    }) as typeof fetch;

    const adapter = new ClaudeAgentSdkAdapter({ fetcher });
    expect(await adapter.healthCheck()).toBe(false);
    expect(await adapter.healthCheck()).toBe(false);
    expect(calls).toBe(1);
  });

  it("re-probes after the cache TTL elapses", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(null, { status: 405 });
    }) as typeof fetch;

    // 0ms cache TTL forces a fresh probe on every call.
    const adapter = new ClaudeAgentSdkAdapter({
      fetcher,
      cacheTtlMs: 0,
    });
    await adapter.healthCheck();
    await adapter.healthCheck();
    expect(calls).toBe(2);
  });

  it("times out a hung request via AbortController (returns false, doesn't hang)", async () => {
    const fetcher = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as typeof fetch;

    const adapter = new ClaudeAgentSdkAdapter({
      fetcher,
      probeTimeoutMs: 50,
    });
    const start = Date.now();
    const result = await adapter.healthCheck();
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    // Must time out near the configured 50ms, well under the default 5s.
    expect(elapsed).toBeLessThan(500);
  });
});
