# Native Shell, Deep Links, and Approval Notifications

Status: **foundation only**. The PWA is the working client. No iOS/Android project has been
generated, no OAuth token exchange endpoint exists, and there is no push. This document states
exactly what the code does today and what is still missing.

## Implemented in the web build

### Configurable gateway

- `apps/mobile/src/session.ts` persists the gateway base URL under `ribhu.gateway`
  (`localStorage`) and defaults to `window.location.origin`. In a native webview that origin is
  `capacitor://localhost` (iOS) or `https://localhost` (Android), so set the real gateway in
  Session → Gateway on first launch. Older cached replicas are not tied to it.
- Every WebSocket URL derives from that setting: `http:` → `ws:`, `https:` → `wss:`, path prefix
  preserved, `/ws` appended, token as `?token=`. The PWA makes no other HTTP calls yet, so there is
  no separate HTTP base URL to keep in sync.
- Session → Gateway validates `http(s)` only, trims whitespace, assumes `https://` for a bare host,
  strips trailing slashes, and rejects `ws(s)://`, `ftp://`, and embedded credentials. "Save &
  reconnect" persists URL + token, clears the cached transcript replica when the server changed, and
  reconnects immediately.

### Token storage seam (not secure yet)

`apps/mobile/src/storage.ts` defines an async `TokenStore` interface and exports `tokenStore`. The
only implementation is `localStorageTokenStore`:

> The token is stored in `localStorage`. It is readable by any script in this origin and by anyone
> with device/devtools access. It is **not** Keychain, Keystore, or encrypted storage.

The interface exists so a Capacitor Keychain/Keystore adapter can replace the binding later without
touching `Session` (see the comment block in `storage.ts`). `Session.start()` already awaits the
seam, so an async native store will drop in. The Settings panel displays the honest label from
`tokenStorageLabel()`.

### Native deep-link seam

`apps/mobile/src/deep-link.ts`:

- `parseDeepLink(url)` returns a typed result:
  - `{kind: "oauth-callback", code, state, redirectUri, raw}` for
    `ribhu://oauth/callback?code=...&state=...` and
    `https://<host>/oauth/callback?code=...&state=...`
  - `{kind: "oauth-error", error, description?, state?, raw}` for provider error redirects
  - `{kind: "ignored", reason}` for anything else (including plain `http://` callbacks, which are
    deliberately not accepted)
- `listenForAppUrls(handler)` subscribes to Capacitor's `appUrlOpen` event **only when the native
  runtime is present**. Capacitor is looked up dynamically at
  `globalThis.Capacitor.Plugins.App`, so the web build has no Capacitor dependency and normal
  browsers return `null`.
- `Session.start()` also parses the current page URL once, which covers https universal-link
  callbacks in a plain browser. An in-app banner reports "authorization code received" and can be
  dismissed. **The code is not exchanged anywhere.**
- iOS `scheme: "ribhu"` is declared in `apps/mobile/capacitor.config.ts`, but a native project must
  exist for the custom scheme to be registered (Android needs an intent-filter in the generated
  `AndroidManifest.xml`; iOS needs the URL type / associated domains entitlement).

### Approval notifications (local only)

`apps/mobile/src/notifications.ts` + the Session sheet:

- "Enable notifications" calls `Notification.requestPermission()` from a user gesture and shows the
  resulting state (unsupported / blocked / enabled).
- If a pending `pi.approval` is observed while the page is hidden — or the app is backgrounded while
  an approval is still pending — and permission is already granted, one local notification is shown
  per tool call (`tag: ribhu-approval-<callId>`). Clicking focuses the app; the approval card in the
  timeline is still the only place to decide. Notifications are never re-sent and never promise an
  approval result.
- No push, VAPID, service-worker push, APNs, FCM, quiet hours, or notification actions exist.
  Nothing arrives while the app is closed.

### Native config

`apps/mobile/capacitor.config.ts` keeps the foundation config (app id/name, `webDir`, Android https
webview, iOS content inset + `ribhu` scheme) and documents that no native project or push config is
included.

## Shell setup (unchanged)

Use Capacitor around the existing React PWA:

```bash
npm install -w @ribhu-voyager/mobile @capacitor/core @capacitor/cli
npx cap add ios
npx cap add android
npm run build
npx cap sync
```

Keep the PWA as the web build; Capacitor only provides the native container. After generating the
projects, register the `ribhu://` scheme (iOS URL type, Android intent-filter) and verify that
`appUrlOpen` fires.

## OAuth 2.1 + PKCE: the future exchange step

The protocol package exports `createCodeVerifier()`, `codeChallenge(verifier)`, and
`buildAuthorizeUrl({...})`. Recommended flow:

1. Native app creates verifier + state and stores both (state in memory, verifier in the future
   Keychain/Keystore store).
2. Opens the system browser (not an embedded webview) at the authorize URL.
3. Redirect URI is `ribhu://oauth/callback` (or an https universal link registered as
   `/oauth/callback`).
4. The callback is parsed by `parseDeepLink` (today it only raises the banner). The **future**
   exchange step is: verify `state` matches the stored value, then POST `code` + `code_verifier` to
   **your backend**, never directly from the app.
5. Backend verifies the ID token, maps the user to a tenant, and returns a short-lived
   `RIBBHU_TOKEN` scoped to that tenant.
6. App stores the returned refresh token in Keychain/Keystore and keeps the access token in memory.

Until step 4 exists, treat every deep link as untrusted input: it can populate a UI notice, nothing
more. When the exchange lands, add redirect-URI allow-listing and state verification before sending
any code to the backend.

The backend exchange endpoint is **not implemented**. The gateway still uses a single shared
`RIBBHU_TOKEN`; run one tenant per deployment until tenant-scoped token issuing lands.

## Not implemented

- iOS/Android projects, native builds, app-store packaging.
- Keychain/Keystore token storage; the token is in `localStorage`.
- OAuth code exchange, state verification, redirect allow-listing, token refresh.
- Push notifications of any kind (APNs/FCM/VAPID/service worker); notification approve/deny actions.
- Background execution or background reconnect; the app only reconnects on resume.
- Universal-link / custom-scheme registration and associated domains.
- Server-side routing of a token to a tenant runtime.

## Security and limitations to keep in mind

- The gateway setting can point the app at any http(s) server; a malicious server receives the
  configured token. Only change it on a trusted device.
- An `https:` page cannot open a `ws://` socket to an `http:` gateway (mixed content); configure an
  https gateway for hosted use.
- Local notifications require the PWA to be open (foreground service worker is not enough); on iOS
  they only work from an installed home-screen app in supported versions.
- None of the native seams are a security boundary yet. Do not describe the current build as having
  secure token storage or verified deep links.

## Release checklist

- [ ] Identity provider + backend code exchange
- [ ] State + redirect-URI verification for deep links
- [ ] Tenant-scoped token issuing
- [ ] Keychain/Keystore token storage (replace `tokenStore`)
- [ ] Universal link / custom scheme verification on device
- [ ] Push certificates, deep links, and notification actions
- [ ] Background reconnect / push-triggered sync
- [ ] App Store / Play Store privacy + data safety
- [ ] E2E on real devices against an HTTPS gateway
