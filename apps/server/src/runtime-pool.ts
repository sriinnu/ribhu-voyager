import { timingSafeEqual } from "node:crypto";

import type { ServerInfo } from "@ribhu-voyager/protocol";

import { createApiRuntime, type ApiRuntime } from "./api-runtime.js";
import type { Config } from "./config.js";

/**
 * Maps a raw bearer/query token to its tenant id. In production this is
 * Postgres `resolveApiToken`; tests inject a fake map. `undefined` means the
 * token is unknown or revoked.
 */
export type TenantTokenResolver = (token: string) => Promise<string | undefined>;

/**
 * Creates the runtime for one tenant. Injectable so tests can build isolated
 * SQLite runtimes (separate data dirs) without touching Postgres.
 */
export type ApiRuntimeFactory = (
  config: Config,
  tenantId: string,
) => Promise<ApiRuntime>;

export type ResolvedRuntime = {
  tenantId: string;
  runtime: ApiRuntime;
  /** Wire identity sent in `welcome` for this runtime. */
  info: ServerInfo;
};

/** Internal pool bookkeeping: not exposed to callers. */
type PoolEntry = ResolvedRuntime & {
  /** WebSocket clients currently attached to this runtime. */
  activeClients: number;
  /** Last acquire/resolve/release time, used for idle eviction. */
  lastUsedAt: number;
};

/** R6 capacity refusal: a *new* tenant would exceed the per-process cap. */
export type RuntimeCapacityExceeded = {
  error: "capacity_exceeded";
  message: string;
  tenantId: string;
  /** Runtimes already cached (does not include in-flight creations). */
  activeTenants: number;
  /** Configured cap; 0 means unlimited and never produces this error. */
  limit: number;
};

export type RuntimeResolveResult =
  | ResolvedRuntime
  | RuntimeCapacityExceeded
  | undefined;

export type PoolStats = {
  activeTenants: number;
  pendingTenants: number;
  /** Sum of WebSocket clients across all cached runtimes. */
  activeClients: number;
  /** Cached runtimes with no connected clients. */
  idle: number;
  /** Idle runtimes past the TTL (candidates for eviction right now). */
  evictable: number;
  /** Configured cap; 0 means unlimited. */
  maxTenants: number;
  unlimited: boolean;
  /** Idle TTL; 0 means eviction is disabled. */
  ttlMs: number;
  tenants: string[];
};

export function isCapacityExceeded(
  value: RuntimeResolveResult,
): value is RuntimeCapacityExceeded {
  return (
    value !== undefined &&
    "error" in value &&
    value.error === "capacity_exceeded"
  );
}

/**
 * Adapter for the WS upgrade path: a rejected token stays `undefined` (401),
 * while an exhausted pool throws so the upgrade handler answers 503 instead of
 * silently creating an unbounded runtime.
 */
export function runtimeForGateway(
  result: RuntimeResolveResult,
): ApiRuntime | undefined {
  if (result === undefined) return undefined;
  if (isCapacityExceeded(result)) throw new Error(result.message);
  return result.runtime;
}

export type RuntimePool = {
  /**
   * Resolve a client token to its tenant's runtime, creating and caching the
   * runtime on first use. `undefined` means the token is not allowed.
   *
   * `resolve` is for inspection/health: it refreshes `lastUsedAt` but does not
   * count a client. Use `acquire` for a WebSocket connection.
   *
   * With no tenant resolver (SQLite/local) every allowed token maps to the
   * default runtime; the shared `RIBBHU_TOKEN` is enforced for that path only.
   *
   * A new tenant past `RIBBHU_MAX_TENANT_RUNTIMES` resolves to a typed
   * `RuntimeCapacityExceeded`; already-resolved tenants keep working.
   */
  resolve(token?: string): Promise<RuntimeResolveResult>;
  /** Resolve and count one active WebSocket client for the tenant runtime. */
  acquire(token?: string): Promise<RuntimeResolveResult>;
  /** Drop one active client; refreshes `lastUsedAt` for idle eviction. */
  release(runtime: ApiRuntime): void;
  /**
   * Evict idle runtimes whose TTL has expired. Safe to call from the periodic
   * sweep or manually (tests); returns the evicted tenant ids.
   */
  evictIdle(now?: number): Promise<string[]>;
  /** Active/pending tenant runtimes, clients, eviction state (health/debug). */
  stats(): PoolStats;
  /** ServerInfo for a runtime created by this pool (falls back to its fields). */
  infoFor(runtime: ApiRuntime): ServerInfo;
  /** Stop the eviction timer and close every cached runtime. */
  close(): Promise<void>;
};

const DEFAULT_TENANT = "default";
const DEFAULT_TTL_MS = 600_000;
const DEFAULT_EVICT_INTERVAL_MS = 60_000;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** ServerInfo for a tenant runtime (serverId/model/provider/startedAt). */
export function runtimeInfo(runtime: ApiRuntime): ServerInfo {
  return {
    serverId: runtime.serverId,
    demo: runtime.demo,
    model: runtime.model.modelId,
    provider: runtime.model.provider,
    startedAt: runtime.startedAt,
    ...(runtime.pushPublicKey ? { pushPublicKey: runtime.pushPublicKey } : {}),
  };
}

class RuntimePoolImpl implements RuntimePool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly pending = new Map<string, Promise<PoolEntry>>();
  private readonly infos = new WeakMap<object, ServerInfo>();
  private readonly runtimeTenants = new WeakMap<object, string>();
  private readonly evicting = new Set<string>();
  private readonly evictTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: Config,
    private readonly resolveTenant?: TenantTokenResolver,
    private readonly createRuntime: ApiRuntimeFactory = (config, tenantId) =>
      createApiRuntime(config, tenantId),
  ) {
    // R6: background sweep only when eviction is enabled and an interval exists.
    const interval = this.evictInterval();
    if (this.ttl() > 0 && interval > 0) {
      this.evictTimer = setInterval(() => {
        void this.evictIdle().catch((error) => {
          console.error("tenant runtime eviction failed", error);
        });
      }, interval);
      this.evictTimer.unref?.();
    }
  }

  /** Resolved cap; `0` means unlimited. */
  private capacity(): number {
    return this.config.maxTenantRuntimes ?? 20;
  }

  /** Idle TTL; `0` disables eviction. */
  private ttl(): number {
    return this.config.tenantRuntimeTtlMs ?? DEFAULT_TTL_MS;
  }

  /** Background sweep interval; `0` means no periodic timer. */
  private evictInterval(): number {
    return this.config.tenantEvictIntervalMs ?? DEFAULT_EVICT_INTERVAL_MS;
  }

  private hasCapacity(): boolean {
    const limit = this.capacity();
    return limit === 0 || this.entries.size + this.pending.size < limit;
  }

  private capacityExceeded(tenantId: string): RuntimeCapacityExceeded {
    const limit = this.capacity();
    return {
      error: "capacity_exceeded",
      tenantId,
      activeTenants: this.entries.size,
      limit,
      message:
        `Tenant runtime capacity reached (${this.entries.size + this.pending.size}/${limit}). ` +
        "Try again later or raise RIBBHU_MAX_TENANT_RUNTIMES (0 = unlimited).",
    };
  }

  /** A runtime may be evicted only when idle, past TTL, and not in flight. */
  private isEvictable(entry: PoolEntry, now = Date.now()): boolean {
    const ttl = this.ttl();
    return (
      ttl > 0 &&
      entry.activeClients === 0 &&
      now - entry.lastUsedAt > ttl &&
      !this.evicting.has(entry.tenantId) &&
      !this.pending.has(entry.tenantId)
    );
  }

  /** Least-recently-used evictable tenant, if any. */
  private idleLru(now = Date.now()): PoolEntry | undefined {
    let best: PoolEntry | undefined;
    for (const entry of this.entries.values()) {
      if (!this.isEvictable(entry, now)) continue;
      if (
        best === undefined ||
        entry.lastUsedAt < best.lastUsedAt ||
        (entry.lastUsedAt === best.lastUsedAt &&
          entry.tenantId.localeCompare(best.tenantId) < 0)
      ) {
        best = entry;
      }
    }
    return best;
  }

  private async evict(entry: PoolEntry): Promise<void> {
    this.evicting.add(entry.tenantId);
    try {
      if (this.entries.get(entry.tenantId) !== entry) return;
      this.entries.delete(entry.tenantId);
      this.runtimeTenants.delete(entry.runtime);
      this.infos.delete(entry.runtime);
      try {
        await entry.runtime.close();
      } catch {
        /* best-effort close; the entry is already unindexed */
      }
    } finally {
      this.evicting.delete(entry.tenantId);
    }
  }

  async evictIdle(now = Date.now()): Promise<string[]> {
    const victims = [...this.entries.values()].filter((entry) =>
      this.isEvictable(entry, now),
    );
    const evicted: string[] = [];
    for (const victim of victims) {
      if (!this.isEvictable(victim, now)) continue;
      await this.evict(victim);
      evicted.push(victim.tenantId);
    }
    return evicted;
  }

  private async evictOneIdleLru(now: number): Promise<boolean> {
    const victim = this.idleLru(now);
    if (victim === undefined) return false;
    await this.evict(victim);
    return true;
  }

  async resolve(token?: string): Promise<RuntimeResolveResult> {
    return this.resolveInternal(token, false);
  }

  async acquire(token?: string): Promise<RuntimeResolveResult> {
    return this.resolveInternal(token, true);
  }

  private async resolveInternal(
    token: string | undefined,
    countClient: boolean,
  ): Promise<RuntimeResolveResult> {
    let tenantId: string;
    if (this.resolveTenant) {
      if (!token) return undefined;
      const tenant = await this.resolveTenant(token);
      if (!tenant) return undefined;
      tenantId = tenant;
    } else {
      // No token checker: one default runtime, guarded by the shared token.
      if (this.config.token !== "") {
        if (!token || !safeEqual(token, this.config.token)) return undefined;
      }
      tenantId = this.config.tenantId ?? DEFAULT_TENANT;
    }

    const touch = (entry: PoolEntry): PoolEntry => {
      entry.lastUsedAt = Date.now();
      if (countClient) entry.activeClients += 1;
      return entry;
    };

    // Existing (and in-flight) tenants always resolve; the cap only gates new
    // tenants. The check + pending.set below are synchronous, so concurrent
    // resolutions cannot overshoot the cap.
    const existing = this.entries.get(tenantId);
    if (existing) return touch(existing);

    const inflight = this.pending.get(tenantId);
    if (inflight) return touch(await inflight);

    if (!this.hasCapacity()) {
      // R6 capacity pressure: reclaim the least-recently-used expired idle
      // runtime first; only then refuse the new tenant.
      const evicted = await this.evictOneIdleLru(Date.now());
      if (!evicted || !this.hasCapacity()) {
        return this.capacityExceeded(tenantId);
      }
    }

    const created = this.create(tenantId);
    this.pending.set(tenantId, created);
    try {
      return touch(await created);
    } finally {
      this.pending.delete(tenantId);
    }
  }

  release(runtime: ApiRuntime): void {
    const tenantId = this.runtimeTenants.get(runtime);
    if (tenantId === undefined) return;
    const entry = this.entries.get(tenantId);
    if (!entry) return;
    entry.activeClients = Math.max(0, entry.activeClients - 1);
    entry.lastUsedAt = Date.now();
  }

  stats(): PoolStats {
    const now = Date.now();
    const entries = [...this.entries.values()];
    const maxTenants = this.capacity();
    return {
      activeTenants: entries.length,
      pendingTenants: this.pending.size,
      activeClients: entries.reduce((sum, entry) => sum + entry.activeClients, 0),
      idle: entries.filter((entry) => entry.activeClients === 0).length,
      evictable: entries.filter((entry) => this.isEvictable(entry, now)).length,
      maxTenants,
      unlimited: maxTenants === 0,
      ttlMs: this.ttl(),
      tenants: entries.map((entry) => entry.tenantId).sort(),
    };
  }

  infoFor(runtime: ApiRuntime): ServerInfo {
    return this.infos.get(runtime) ?? runtimeInfo(runtime);
  }

  async close(): Promise<void> {
    if (this.evictTimer) clearInterval(this.evictTimer);
    await Promise.allSettled([...this.pending.values()]);
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.evicting.clear();
    await Promise.allSettled(entries.map((entry) => entry.runtime.close()));
  }

  private async create(tenantId: string): Promise<PoolEntry> {
    const config =
      this.config.tenantId === tenantId
        ? this.config
        : { ...this.config, tenantId };
    const runtime = await this.createRuntime(config, tenantId);
    const entry: PoolEntry = {
      tenantId,
      runtime,
      info: runtimeInfo(runtime),
      activeClients: 0,
      lastUsedAt: Date.now(),
    };
    this.entries.set(tenantId, entry);
    this.infos.set(runtime, entry.info);
    this.runtimeTenants.set(runtime, tenantId);
    return entry;
  }
}

/** Build the token → runtime pool for the API process. */
export function createRuntimePool(
  config: Config,
  resolveTenant?: TenantTokenResolver,
  createRuntime?: ApiRuntimeFactory,
): RuntimePool {
  return new RuntimePoolImpl(config, resolveTenant, createRuntime);
}
