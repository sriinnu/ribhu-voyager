import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type {
  Credential,
  CredentialInfo,
  CredentialOptions,
} from "./credentials.js";

const run = promisify(execFile);
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TTL_MS = 60_000;

type ClaudeOauth = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
  scopes?: string[];
  rateLimitTier?: string;
};

type ClaudeFile = {
  claudeAiOauth?: ClaudeOauth;
} & ClaudeOauth;

export type ClaudeCodeAuthOptions = {
  /** macOS Keychain service name. */
  service?: string;
  account?: string;
  /** Legacy/new Claude Code credentials file. */
  file?: string;
  /** Where refreshed tokens are cached for this app. */
  cacheFile?: string;
  /** Disable Keychain reads (tests, Linux). */
  readKeychain?: boolean;
  /** Opt in to writing refreshed tokens back to the Keychain. */
  writeKeychain?: boolean;
};

function isOauth(credential: Credential | undefined): credential is Extract<
  Credential,
  { type: "oauth" }
> {
  return credential?.type === "oauth";
}

function toOauth(raw: ClaudeFile | undefined): Credential | undefined {
  if (!raw) return undefined;
  const oauth = raw.claudeAiOauth ?? raw;
  const access = oauth.accessToken;
  const refresh = oauth.refreshToken;
  if (!access || !refresh) return undefined;
  return {
    type: "oauth",
    access,
    refresh,
    expires: typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0,
    ...(oauth.subscriptionType
      ? { subscriptionType: oauth.subscriptionType }
      : {}),
    ...(oauth.scopes ? { scopes: oauth.scopes } : {}),
  };
}

/**
 * Reuses the Claude Code (or `claude` CLI) OAuth login.
 *
 * macOS keeps it in the Keychain as `Claude Code-credentials`; older installs
 * also use `~/.claude/.credentials.json`. Refreshed tokens are cached in
 * `~/.ribhu/agent/claude-code.json` (the Keychain is only written when
 * `RIBBHU_KEYCHAIN_WRITE=1`).
 */
export class ClaudeCodeAuthStore {
  private readonly service: string;
  private readonly account: string;
  private readonly file: string;
  private readonly cacheFile: string;
  private readonly readKeychain: boolean;
  private readonly writeKeychain: boolean;
  private keychainCache:
    | { at: number; value: ClaudeFile | undefined }
    | undefined;
  private keychainError: string | undefined;

  constructor(options: ClaudeCodeAuthOptions = {}) {
    this.service = options.service ?? KEYCHAIN_SERVICE;
    this.account = options.account ?? userInfo().username;
    this.file =
      options.file ?? join(homedir(), ".claude", ".credentials.json");
    this.cacheFile =
      options.cacheFile ?? join(homedir(), ".ribhu", "agent", "claude-code.json");
    this.readKeychain = options.readKeychain ?? true;
    this.writeKeychain =
      options.writeKeychain ?? process.env.RIBBHU_KEYCHAIN_WRITE === "1";
  }

  async available(): Promise<boolean> {
    try {
      return isOauth(await this.read("anthropic"));
    } catch {
      return false;
    }
  }

  subscriptionType(credential: Credential | undefined): string | undefined {
    return isOauth(credential) &&
      typeof credential.subscriptionType === "string"
      ? credential.subscriptionType
      : undefined;
  }

  async read(
    providerId: string,
    options?: CredentialOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== "anthropic") return undefined;
    options?.signal?.throwIfAborted();

    const [fromKeychain, fromCache] = await Promise.all([
      this.readKeychainFile(),
      this.readCache(),
    ]);

    const candidates = [fromKeychain, fromCache].filter(
      (entry): entry is Credential => isOauth(entry),
    );
    if (candidates.length === 0) return undefined;

    // The most recently expiring token wins: a refresh inside this app writes
    // to the cache, while Claude Code itself writes to the Keychain.
    candidates.sort((a, b) => {
      const left = isOauth(a) ? a.expires : 0;
      const right = isOauth(b) ? b.expires : 0;
      return right - left;
    });
    return candidates[0];
  }

  async list(options?: CredentialOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return (await this.available()) ? [{ providerId: "anthropic", type: "oauth" }] : [];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: CredentialOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== "anthropic") return undefined;
    options?.signal?.throwIfAborted();

    const current = await this.read("anthropic", options);
    const next = await fn(current);
    if (next === undefined) return current;
    if (!isOauth(next)) return next;

    await this.writeCache(next).catch(() => undefined);
    if (this.writeKeychain) {
      await this.writeKeychainFile(next).catch(() => undefined);
    }
    this.keychainCache = undefined;
    return next;
  }

  async delete(
    providerId: string,
    options?: CredentialOptions,
  ): Promise<void> {
    if (providerId !== "anthropic") return;
    options?.signal?.throwIfAborted();
    await writeFile(this.cacheFile, "{}\n", { mode: 0o600 }).catch(() => undefined);
    this.keychainCache = undefined;
  }

  private async readKeychainFile(): Promise<Credential | undefined> {
    if (!this.readKeychain) return this.readLegacyFile();
    const now = Date.now();
    if (this.keychainCache && now - this.keychainCache.at < KEYCHAIN_TTL_MS) {
      return toOauth(this.keychainCache.value);
    }

    const secret = await this.readKeychainSecret();
    if (secret === undefined) {
      this.keychainCache = { at: now, value: undefined };
      return this.readLegacyFile();
    }
    try {
      const parsed = JSON.parse(secret) as ClaudeFile;
      this.keychainCache = { at: now, value: parsed };
      return toOauth(parsed);
    } catch {
      this.keychainCache = { at: now, value: undefined };
      return this.readLegacyFile();
    }
  }

  private async readKeychainSecret(): Promise<string | undefined> {
    if (process.platform !== "darwin") return undefined;
    const attempts = [
      ["find-generic-password", "-s", this.service, "-a", this.account, "-w"],
      ["find-generic-password", "-s", this.service, "-w"],
    ];
    for (const args of attempts) {
      try {
        const { stdout } = await run("security", args, {
          timeout: 15_000,
          maxBuffer: 1 << 20,
        });
        const value = stdout.trim();
        if (value !== "") return value;
      } catch (error) {
        this.keychainError = error instanceof Error ? error.message : String(error);
      }
    }
    return undefined;
  }

  private async readLegacyFile(): Promise<Credential | undefined> {
    try {
      const raw = await readFile(this.file, "utf8");
      return toOauth(JSON.parse(raw) as ClaudeFile);
    } catch {
      return undefined;
    }
  }

  private async readCache(): Promise<Credential | undefined> {
    try {
      const raw = await readFile(this.cacheFile, "utf8");
      const parsed = JSON.parse(raw) as Credential;
      return isOauth(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(credential: Extract<Credential, { type: "oauth" }>): Promise<void> {
    await mkdir(dirname(this.cacheFile), { recursive: true });
    const temp = `${this.cacheFile}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify(
      {
        type: "oauth",
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
        ...(credential.subscriptionType
          ? { subscriptionType: credential.subscriptionType }
          : {}),
        ...(credential.scopes ? { scopes: credential.scopes } : {}),
      },
      null,
      2,
    )}\n`;
    await writeFile(temp, body, { mode: 0o600 });
    await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, this.cacheFile);
  }

  private async writeKeychainFile(
    credential: Extract<Credential, { type: "oauth" }>,
  ): Promise<void> {
    if (process.platform !== "darwin") return;
    const secret = await this.readKeychainSecret();
    if (!secret) return;
    let parsed: ClaudeFile;
    try {
      parsed = JSON.parse(secret) as ClaudeFile;
    } catch {
      return;
    }
    const current = parsed.claudeAiOauth ?? {};
    const merged: ClaudeFile = {
      ...parsed,
      claudeAiOauth: {
        ...current,
        accessToken: credential.access,
        refreshToken: credential.refresh,
        expiresAt: credential.expires,
      },
    };
    await run(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        this.service,
        "-a",
        this.account,
        "-w",
        JSON.stringify(merged),
      ],
      { timeout: 15_000, maxBuffer: 1 << 20 },
    );
    this.keychainCache = { at: Date.now(), value: merged };
  }

  /** For a startup diagnostic or the menu. */
  describeError(): string | undefined {
    return this.keychainError;
  }
}
