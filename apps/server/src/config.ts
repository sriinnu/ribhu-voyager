import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ApprovalsMode } from "@ribhu-voyager/engine";

export type Config = {
  host: string;
  port: number;
  dataDir: string;
  workspaceDir: string;
  /** "demo" runs the built-in scripted provider; anything else uses a native streaming client. */
  provider: string;
  model: string;
  demo: boolean;
  demoTokensPerSecond: number;
  maxWindowEntries: number;
  token: string;
  /** How Anthropic requests authenticate. */
  authMode: "auto" | "subscription" | "api-key";
  /** Which Claude OAuth login to prefer. */
  authSource: "auto" | "pi" | "claude-code";
  /** Anthropic API key used in api-key mode. */
  anthropicApiKey?: string;
  sandbox?: "local" | "docker";
  sandboxImage?: string;
  storage?: "sqlite" | "postgres";
  postgresUrl?: string;
  tenantId?: string;
  /** Hard tool gate, or `ask` for durable per-call approval. */
  approvals?: ApprovalsMode;
  /** Web Push VAPID keys; both are required to enable server push. */
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
};

// Resolve against the repository, not the caller's cwd: npm workspace scripts run
// inside apps/server, and storage must not move when you start the app differently.
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

const REAL_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "deepseek",
  "openrouter",
  "xai",
  "groq",
  "mistral",
  "ollama",
]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = env.RIBBHU_PROVIDER?.trim() || "demo";
  const model = env.RIBBHU_MODEL?.trim() || "";
  const demo = provider === "demo" || env.RIBBHU_DEMO === "1";

  if (!demo && !REAL_PROVIDERS.has(provider)) {
    throw new Error(
      `Unknown RIBBHU_PROVIDER "${provider}". Use one of: demo, ${[...REAL_PROVIDERS].join(", ")}.`,
    );
  }
  if (!demo && model === "") {
    throw new Error(`RIBBHU_MODEL is required when RIBBHU_PROVIDER=${provider}.`);
  }

  const requestedMode = (env.RIBBHU_ANTHROPIC_AUTH?.trim().toLowerCase() || "auto");
  const authMode =
    requestedMode === "credits" || requestedMode === "api_key"
      ? "api-key"
      : requestedMode;
  if (authMode !== "auto" && authMode !== "subscription" && authMode !== "api-key") {
    throw new Error(
      `Unknown RIBBHU_ANTHROPIC_AUTH "${requestedMode}". Use auto, subscription, or api-key.`,
    );
  }

  const requestedSource = (env.RIBBHU_AUTH_SOURCE?.trim().toLowerCase() || "auto");
  const authSource =
    requestedSource === "claude" ? "claude-code" : requestedSource;
  if (authSource !== "auto" && authSource !== "pi" && authSource !== "claude-code") {
    throw new Error(
      `Unknown RIBBHU_AUTH_SOURCE "${requestedSource}". Use auto, pi, or claude-code.`,
    );
  }

  const anthropicApiKey =
    env.RIBBHU_ANTHROPIC_API_KEY?.trim() ||
    env.ANTHROPIC_API_KEY?.trim() ||
    undefined;

  const storageRaw = env.RIBBHU_STORAGE?.trim().toLowerCase() || "sqlite";
  if (storageRaw !== "sqlite" && storageRaw !== "postgres") {
    throw new Error(`Unknown RIBBHU_STORAGE "${storageRaw}". Use sqlite or postgres.`);
  }
  if (storageRaw === "postgres" && !env.RIBBHU_POSTGRES_URL?.trim()) {
    throw new Error("RIBBHU_POSTGRES_URL is required when RIBBHU_STORAGE=postgres.");
  }

  const tenantId = env.RIBBHU_TENANT?.trim() || "default";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
    throw new Error("RIBBHU_TENANT must be 1-64 alphanumeric, dash, or underscore.");
  }

  const approvalsRaw = env.RIBBHU_APPROVALS?.trim().toLowerCase() || "allow";
  if (
    approvalsRaw !== "allow" &&
    approvalsRaw !== "deny-bash" &&
    approvalsRaw !== "read-only" &&
    approvalsRaw !== "ask"
  ) {
    throw new Error(
      `Unknown RIBBHU_APPROVALS "${approvalsRaw}". Use allow, ask, deny-bash, or read-only.`,
    );
  }

  const vapidPublicKey = env.RIBBHU_VAPID_PUBLIC_KEY?.trim() || undefined;
  const vapidPrivateKey = env.RIBBHU_VAPID_PRIVATE_KEY?.trim() || undefined;
  if (Boolean(vapidPublicKey) !== Boolean(vapidPrivateKey)) {
    throw new Error(
      "RIBBHU_VAPID_PUBLIC_KEY and RIBBHU_VAPID_PRIVATE_KEY must be set together.",
    );
  }

  const sandboxRaw = env.RIBBHU_SANDBOX?.trim().toLowerCase() || "local";
  if (sandboxRaw !== "local" && sandboxRaw !== "docker") {
    throw new Error(
      `Unknown RIBBHU_SANDBOX "${sandboxRaw}". Use local or docker.`,
    );
  }

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: Number.parseInt(env.PORT ?? "8787", 10),
    dataDir: resolve(env.RIBBHU_DATA_DIR?.trim() || join(projectRoot, ".ribhu-data")),
    workspaceDir: resolve(env.RIBBHU_WORKSPACE?.trim() || join(projectRoot, ".ribhu-workspace")),
    provider,
    model: demo ? "ribhu-demo" : model,
    demo,
    demoTokensPerSecond: Number.parseFloat(env.RIBBHU_DEMO_TPS ?? "38"),
    maxWindowEntries: Number.parseInt(env.RIBBHU_WINDOW_ENTRIES ?? "100", 10),
    token: env.RIBBHU_TOKEN?.trim() || "",
    authMode,
    authSource,
    storage: storageRaw,
    tenantId,
    ...(env.RIBBHU_POSTGRES_URL?.trim()
      ? { postgresUrl: env.RIBBHU_POSTGRES_URL.trim() }
      : {}),
    approvals: approvalsRaw,
    sandbox: sandboxRaw,
    ...(vapidPublicKey
      ? {
          vapidPublicKey,
          vapidPrivateKey: vapidPrivateKey!,
          vapidSubject:
            env.RIBBHU_VAPID_SUBJECT?.trim() || "mailto:hello@srinivas.dev",
        }
      : {}),
    sandboxImage: env.RIBBHU_SANDBOX_IMAGE?.trim() || "node:24-bookworm",
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
  };
}

export function describeConfig(config: Config): string {
  const lines = [
    `  storage   ${join(config.dataDir, "ribhu.sqlite")}`,
    `  workspace ${config.workspaceDir}`,
    `  model     ${config.provider}/${config.model}${config.demo ? "  (scripted demo — set RIBBHU_PROVIDER + RIBBHU_MODEL for a real model)" : ""}`,
    `  storage   ${config.storage === "postgres" ? `Postgres (tenant ${config.tenantId ?? "default"})` : join(config.dataDir, "ribhu.sqlite")}`,
    `  approvals ${config.approvals ?? "allow"}`,
    `  sandbox   ${config.sandbox ?? "local"}${config.sandbox === "docker" ? ` (${config.sandboxImage ?? "node:24-bookworm"})` : ""}`,
    `  push      ${config.vapidPublicKey ? "Web Push enabled" : "disabled (set RIBBHU_VAPID_*)"}`,
  ];
  return lines.join("\n");
}
