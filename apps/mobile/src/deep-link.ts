/**
 * Native deep-link seam for the OAuth 2.1 + PKCE flow.
 *
 * ## What is implemented
 *
 * - `parseDeepLink()` turns a URL into a typed result:
 *   - `ribhu://oauth/callback?code=...&state=...`
 *   - `https://<host>/oauth/callback?code=...&state=...`
 *   - `...?error=...&error_description=...` (provider-side failure)
 *   - anything else is `ignored`
 * - `listenForAppUrls()` listens for Capacitor's `appUrlOpen` event when the
 *   native runtime is present. It is looked up dynamically on
 *   `globalThis.Capacitor.Plugins.App` so the web build needs no Capacitor
 *   dependency; without a native shell it simply returns `null`.
 *
 * ## What is NOT implemented
 *
 * - No token exchange: a received `code` is surfaced to the app (and nothing
 *   else). The real flow exchanges `code` + PKCE verifier at your backend and
 *   returns a short-lived gateway token. See docs/NATIVE-SHELL.md.
 * - No state verification, no redirect-URI allow-list. Until the exchange is
 *   wired, an attacker-supplied deep link can at most populate a UI notice —
 *   it cannot authenticate anything. Treat callbacks as untrusted input when
 *   the exchange lands: compare `state` against the value stored before the
 *   browser round-trip and only accept callbacks from the configured gateway /
 *   identity provider.
 * - No iOS/Android project or custom-scheme registration exists yet.
 */

export type OAuthCallback = {
  kind: "oauth-callback";
  /** Authorization code to exchange at your backend (not exchanged here). */
  code: string;
  /** CSRF state that must match the stored verifier/state pair. */
  state: string;
  /** Where the provider redirected: `ribhu://oauth/callback` or the https URL. */
  redirectUri: string;
  raw: string;
};

export type OAuthErrorLink = {
  kind: "oauth-error";
  error: string;
  description?: string;
  state?: string;
  raw: string;
};

export type IgnoredDeepLink = {
  kind: "ignored";
  raw: string;
  reason: string;
};

export type DeepLink = OAuthCallback | OAuthErrorLink | IgnoredDeepLink;

function ignored(raw: string, reason: string): IgnoredDeepLink {
  return { kind: "ignored", raw, reason };
}

/** True for the links worth surfacing to the user / future exchange code. */
export function isOAuthLink(
  link: DeepLink,
): link is OAuthCallback | OAuthErrorLink {
  return link.kind === "oauth-callback" || link.kind === "oauth-error";
}

/**
 * Parse a URL from a deep link, an appUrlOpen event, or `window.location`.
 * Never throws; unknown URLs come back as `{kind: "ignored"}`.
 */
export function parseDeepLink(raw: string): DeepLink {
  const text = raw.trim();
  if (text === "") return ignored(raw, "empty URL");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return ignored(raw, "not a URL");
  }

  const path = url.pathname.replace(/\/+$/, "");

  // Capacitor registers the custom scheme as `ribhu://`; `new URL` parses
  // `ribhu://oauth/callback` as host "oauth", path "/callback".
  const customCallback =
    url.protocol === "ribhu:" &&
    ((url.host === "oauth" && (path === "/callback" || path === "")) ||
      path === "/oauth/callback");

  // Universal links / https redirect targets, e.g.
  // https://app.example.com/oauth/callback?code=...&state=...
  const httpsCallback =
    url.protocol === "https:" && path.endsWith("/oauth/callback");

  if (!customCallback && !httpsCallback) {
    return ignored(raw, "not an OAuth callback URL");
  }

  const error = url.searchParams.get("error");
  if (error) {
    return {
      kind: "oauth-error",
      error,
      description: url.searchParams.get("error_description") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      raw: text,
    };
  }

  const code = url.searchParams.get("code");
  if (!code) return ignored(raw, "OAuth callback without ?code=");

  return {
    kind: "oauth-callback",
    code,
    state: url.searchParams.get("state") ?? "",
    redirectUri: customCallback
      ? "ribhu://oauth/callback"
      : `${url.protocol}//${url.host}${url.pathname}`,
    raw: text,
  };
}

type ListenerHandle = {
  remove?: () => Promise<void> | void;
};

type CapacitorAppPlugin = {
  addListener?: (
    event: "appUrlOpen",
    callback: (data: { url?: string }) => void,
  ) => Promise<ListenerHandle> | ListenerHandle;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  Plugins?: {
    App?: CapacitorAppPlugin;
  };
};

export type AppUrlListener = {
  readonly native: boolean;
  stop(): void;
};

/**
 * Listen for `appUrlOpen` if Capacitor is injected into the webview.
 *
 * @capacitor/core injects a global `Capacitor` object and registers plugin
 * bridges under `Capacitor.Plugins`. Calling it this way keeps Capacitor out
 * of package.json (no dependency, no native project required) while still
 * being the same event the real `@capacitor/app` listener receives.
 */
export async function listenForAppUrls(
  handler: (link: DeepLink) => void,
): Promise<AppUrlListener | null> {
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  const plugin = capacitor?.Plugins?.App;
  if (!plugin?.addListener) return null;

  try {
    const handle = await plugin.addListener("appUrlOpen", (data) => {
      const url = typeof data?.url === "string" ? data.url : "";
      if (url !== "") handler(parseDeepLink(url));
    });
    return {
      native: true,
      stop: () => {
        void Promise.resolve(handle?.remove?.()).catch(() => undefined);
      },
    };
  } catch {
    /* plugin bridge failed to initialise: the web path still works */
    return null;
  }
}
