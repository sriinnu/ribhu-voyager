/**
 * Storage seam for the gateway bearer token.
 *
 * ## What ships today
 *
 * `localStorageTokenStore` is the only implementation: the token lives in the
 * page's `localStorage`, readable by any script running in this origin and by
 * anyone with device / devtools access. It is **not** secure native storage.
 *
 * ## Native upgrade path (not implemented)
 *
 * The interface is deliberately async so a Capacitor Keychain/Keystore adapter
 * can replace `tokenStore` without touching `Session`:
 *
 * ```ts
 * // after `npx cap add ios|android` and installing a keychain plugin:
 * class SecureTokenStore implements TokenStore {
 *   readonly kind = "keychain" as const; // or "keystore"
 *   readonly secure = true;
 *   async get() { return (await Keychain.get({ key: TOKEN_KEY })).value ?? ""; }
 *   async set(token: string) { await Keychain.set({ key: TOKEN_KEY, value: token }); }
 *   async clear() { await Keychain.remove({ key: TOKEN_KEY }); }
 * }
 * export const tokenStore: TokenStore = new SecureTokenStore();
 * ```
 *
 * Until then `secure` is `false` everywhere, and the Settings UI says so. Do
 * not describe localStorage as encrypted or as Keychain/Keystore.
 */

export type TokenStoreKind = "localStorage" | "keychain" | "keystore";

export const TOKEN_KEY = "ribhu.token";

export interface TokenStore {
  readonly kind: TokenStoreKind;
  /** `true` only for a real Keychain/Keystore-backed implementation. */
  readonly secure: boolean;
  get(): Promise<string>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

class LocalStorageTokenStore implements TokenStore {
  readonly kind = "localStorage" as const;
  readonly secure = false;

  async get(): Promise<string> {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
      /* private mode / storage disabled: start unauthenticated */
      return "";
    }
  }

  async set(token: string): Promise<void> {
    try {
      if (token === "") localStorage.removeItem(TOKEN_KEY);
      else localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* quota or private mode; the in-memory session still works */
    }
  }

  async clear(): Promise<void> {
    await this.set("");
  }
}

/** Swap this binding for a Keychain/Keystore store when the native shell lands. */
export const tokenStore: TokenStore = new LocalStorageTokenStore();

/** Human-readable description shown in Settings; keep it honest. */
export function tokenStorageLabel(): string {
  return tokenStore.secure
    ? "Keychain / Keystore"
    : "localStorage — not encrypted or secure";
}
