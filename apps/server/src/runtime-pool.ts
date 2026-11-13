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

export type RuntimePool = {
  /**
   * Resolve a client token to its tenant's runtime, creating and caching the
   * runtime on first use. `undefined` means the token is not allowed.
   *
   * With no tenant resolver (SQLite/local) every allowed token maps to the
   * default runtime; the shared `RIBBHU_TOKEN` is enforced for that path only.
   */
  resolve(token?: string): Promise<ResolvedRuntime | undefined>;
  /** ServerInfo for a runtime created by this pool (falls back to its fields). */
  infoFor(runtime: ApiRuntime): ServerInfo;
  /** Close every cached runtime. */
  close(): Promise<void>;
};

const DEFAULT_TENANT = "default";

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
  };
}

class RuntimePoolImpl implements RuntimePool {
  private readonly entries = new Map<string, ResolvedRuntime>();
  private readonly pending = new Map<string, Promise<ResolvedRuntime>>();
  private readonly infos = new WeakMap<object, ServerInfo>();

  constructor(
    private readonly config: Config,
    private readonly resolveTenant?: TenantTokenResolver,
    private readonly createRuntime: ApiRuntimeFactory = (config, tenantId) =>
      createApiRuntime(config, tenantId),
  ) {}

  async resolve(token?: string): Promise<ResolvedRuntime | undefined> {
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

    const existing = this.entries.get(tenantId);
    if (existing) return existing;
    const inflight = this.pending.get(tenantId);
    if (inflight) return inflight;

    const created = this.create(tenantId);
    this.pending.set(tenantId, created);
    try {
      return await created;
    } finally {
      this.pending.delete(tenantId);
    }
  }

  infoFor(runtime: ApiRuntime): ServerInfo {
    return this.infos.get(runtime) ?? runtimeInfo(runtime);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.runtime.close()));
  }

  private async create(tenantId: string): Promise<ResolvedRuntime> {
    const config =
      this.config.tenantId === tenantId
        ? this.config
        : { ...this.config, tenantId };
    const runtime = await this.createRuntime(config, tenantId);
    const entry: ResolvedRuntime = {
      tenantId,
      runtime,
      info: runtimeInfo(runtime),
    };
    this.entries.set(tenantId, entry);
    this.infos.set(runtime, entry.info);
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
