import { PiAuthStore } from "./auth-store.js";
import { ClaudeCodeAuthStore } from "./claude-code-auth.js";
import { isOauth, type Credential, type OAuthCredential } from "./credentials.js";

export type AuthMode = "subscription" | "api-key";
export type AuthSource = "pi" | "claude-code";

export type AuthInfo = {
  mode: AuthMode;
  source?: AuthSource;
  label: string;
  subscriptionAvailable: boolean;
  apiKeyAvailable: boolean;
  detail?: string;
};

export type AnthropicAuthToken = {
  token: string;
  mode: AuthMode;
  source?: AuthSource;
};

export type AuthManagerOptions = {
  pi: PiAuthStore;
  claudeCode: ClaudeCodeAuthStore;
  apiKey?: string;
  requestedMode?: AuthMode | "auto";
  requestedSource?: AuthSource | "auto";
  log?: (message: string) => void;
};

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d16f2e5";
const REFRESH_AHEAD_MS = 5 * 60_000;

/**
 * Chooses how Anthropic requests authenticate:
 * - `subscription`: Claude OAuth (Claude Code Keychain or Pi's auth file).
 * - `api-key`: an Anthropic API key, drawing on API credits.
 */
export class AuthManager {
  private mode: AuthMode = "subscription";
  private source: AuthSource | undefined;
  private subscriptionAvailable = false;
  private apiKeyAvailable: boolean;
  private readonly apiKey: string | undefined;
  private piCredential: OAuthCredential | undefined;
  private claudeCredential: OAuthCredential | undefined;

  constructor(private readonly options: AuthManagerOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.apiKeyAvailable = this.apiKey !== undefined;
    this.source = this.pickSource();
  }

  async init(): Promise<void> {
    await this.refreshCredentials();
    const requested = this.options.requestedMode ?? "auto";
    const requestedSource = this.options.requestedSource ?? "auto";

    if (requestedSource === "pi" && this.piCredential) {
      this.source = "pi";
    } else if (requestedSource === "claude-code" && this.claudeCredential) {
      this.source = "claude-code";
    } else {
      this.source = this.pickSource();
    }

    if (requested === "api-key" && this.apiKeyAvailable) {
      this.mode = "api-key";
    } else if (requested === "subscription" && this.subscriptionAvailable) {
      this.mode = "subscription";
    } else if (requested === "auto") {
      this.mode = this.subscriptionAvailable
        ? "subscription"
        : this.apiKeyAvailable
          ? "api-key"
          : "subscription";
    } else if (requested === "subscription") {
      this.mode = this.apiKeyAvailable ? "api-key" : "subscription";
      this.options.log?.(
        "Requested the Claude subscription, but no Claude login was found; falling back to an API key.",
      );
    } else {
      this.mode = this.subscriptionAvailable ? "subscription" : "api-key";
      this.options.log?.(
        "Requested API-key auth, but no Anthropic API key was found; falling back to the subscription.",
      );
    }

    this.options.log?.(
      `anthropic auth: ${this.info().label}${this.source ? ` [${this.source}]` : ""}`,
    );
  }

  info(): AuthInfo {
    const sourceLabel =
      this.source === "claude-code"
        ? this.claudeLabel()
        : this.source === "pi"
          ? "Pi login"
          : undefined;

    if (this.mode === "api-key") {
      return {
        mode: "api-key",
        ...(this.source ? { source: this.source } : {}),
        label: this.apiKeyAvailable ? "API key (credits)" : "API key missing",
        subscriptionAvailable: this.subscriptionAvailable,
        apiKeyAvailable: this.apiKeyAvailable,
        detail: this.apiKeyAvailable
          ? "Uses Anthropic API credits/promotional balance."
          : "Set ANTHROPIC_API_KEY or RIBBHU_ANTHROPIC_API_KEY.",
      };
    }

    return {
      mode: "subscription",
      ...(this.source ? { source: this.source } : {}),
      label: sourceLabel ?? "Claude subscription (not found)",
      subscriptionAvailable: this.subscriptionAvailable,
      apiKeyAvailable: this.apiKeyAvailable,
      detail: this.source
        ? "Uses your Claude plan through an OAuth login."
        : "Run `pi` and /login, or log in with Claude Code.",
    };
  }

  async setMode(mode: AuthMode): Promise<AuthInfo> {
    await this.refreshCredentials();
    if (mode === "api-key" && !this.apiKeyAvailable) {
      throw new Error(
        "No Anthropic API key. Set ANTHROPIC_API_KEY or RIBBHU_ANTHROPIC_API_KEY, then restart.",
      );
    }
    if (mode === "subscription") {
      if (!this.subscriptionAvailable) {
        throw new Error(
          "No Claude subscription login found. Run `pi` and /login, or log in with Claude Code.",
        );
      }
      if (!this.source) this.source = this.pickSource();
    }
    this.mode = mode;
    this.options.log?.(`anthropic auth switched to ${this.info().label}`);
    return this.info();
  }

  /** Called by the Anthropic provider for every request. */
  async token(): Promise<AnthropicAuthToken> {
    if (this.mode === "api-key") {
      if (!this.apiKey) {
        throw new Error(
          "No Anthropic API key. Set ANTHROPIC_API_KEY or RIBBHU_ANTHROPIC_API_KEY.",
        );
      }
      return { token: this.apiKey, mode: "api-key", source: this.source };
    }

    await this.refreshCredentials();
    if (!this.source) this.source = this.pickSource();
    if (!this.source) {
      throw new Error(
        "No Claude subscription login found. Run `pi` and /login, or log in with Claude Code.",
      );
    }

    const current = this.currentCredential();
    if (!current) {
      throw new Error("No Claude subscription credential is available.");
    }
    const fresh = await this.ensureFresh(current, this.source);
    return { token: fresh.access, mode: "subscription", source: this.source };
  }

  private currentCredential(): OAuthCredential | undefined {
    return this.source === "claude-code"
      ? this.claudeCredential
      : this.source === "pi"
        ? this.piCredential
        : undefined;
  }

  private async ensureFresh(
    credential: OAuthCredential,
    source: AuthSource,
  ): Promise<OAuthCredential> {
    if (
      credential.access !== "" &&
      credential.expires - Date.now() > REFRESH_AHEAD_MS
    ) {
      return credential;
    }
    if (credential.refresh === "") {
      throw new Error("Claude login has no refresh token; sign in again.");
    }

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: credential.refresh,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(
        `Claude OAuth refresh request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Claude OAuth refresh failed (${response.status}): ${body.slice(0, 400)}`,
      );
    }
    let data: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    try {
      data = JSON.parse(body) as typeof data;
    } catch {
      throw new Error("Claude OAuth refresh returned invalid JSON.");
    }
    if (!data.access_token) {
      throw new Error("Claude OAuth refresh returned no access token.");
    }

    const next: OAuthCredential = {
      type: "oauth",
      access: data.access_token,
      refresh: data.refresh_token ?? credential.refresh,
      expires:
        Date.now() + (data.expires_in ?? 3600) * 1000 - REFRESH_AHEAD_MS,
      ...(credential.subscriptionType
        ? { subscriptionType: credential.subscriptionType }
        : {}),
      ...(credential.scopes ? { scopes: credential.scopes } : {}),
    };

    if (source === "claude-code") {
      await this.options.claudeCode.modify("anthropic", async () => next);
      this.claudeCredential = next;
    } else {
      await this.options.pi.modify("anthropic", async () => next);
      this.piCredential = next;
    }
    this.options.log?.(`refreshed Claude OAuth token (${source})`);
    return next;
  }

  private async refreshCredentials(): Promise<void> {
    const [pi, claude] = await Promise.all([
      this.options.pi.read("anthropic").catch(() => undefined),
      this.options.claudeCode.read("anthropic").catch(() => undefined),
    ]);
    this.piCredential = isOauth(pi) ? pi : undefined;
    this.claudeCredential = isOauth(claude) ? claude : undefined;
    this.subscriptionAvailable = Boolean(
      this.piCredential || this.claudeCredential,
    );
    this.apiKeyAvailable = this.apiKey !== undefined;
    if (this.source === "pi" && !this.piCredential) this.source = undefined;
    if (this.source === "claude-code" && !this.claudeCredential) {
      this.source = undefined;
    }
  }

  private pickSource(): AuthSource | undefined {
    const pi = this.piCredential;
    const claude = this.claudeCredential;
    if (!pi) return claude ? "claude-code" : undefined;
    if (!claude) return "pi";
    return claude.expires > pi.expires ? "claude-code" : "pi";
  }

  private claudeLabel(): string {
    const type = this.claudeCredential?.subscriptionType;
    return type ? `Claude Code (${String(type)})` : "Claude Code";
  }
}

export type { Credential };
