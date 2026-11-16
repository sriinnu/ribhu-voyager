# Native Shell, Deep Links, and Approval Notifications

Status: **native projects generated; iOS simulator and Android debug builds verified on this
machine.** `apps/mobile/ios/` and `apps/mobile/android/` are real Capacitor 8.6.2 projects kept in
sync with the web build. Nothing is signed, archived, or store-ready, no OAuth token exchange
endpoint exists, and native APNs/FCM push is not configured. This document states exactly what the code and native
projects do today and what is still missing.

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
- **Not wired to the native projects yet.** `ios.scheme: "ribhu"` in
  `capacitor.config.ts` sets the internal WKWebView origin (`ribhu://localhost`); it does not
  register an external URL type. The generated `ios/App/App/Info.plist` has no `CFBundleURLTypes`
  entry and the generated `AndroidManifest.xml` has no custom-scheme intent-filter. The
  `@capacitor/app` plugin is also not installed, so `globalThis.Capacitor.Plugins.App` is absent and
  `appUrlOpen` never fires in the current native builds. To wire it: install
  `@capacitor/app`, listen with `App.addListener("appUrlOpen", ...)` (the current dynamic lookup then
  finds it), add the iOS URL type + Android intent-filter, and `npx cap sync`.

### Approval notifications (local only)

`apps/mobile/src/notifications.ts` + the Session sheet:

- "Enable notifications" calls `Notification.requestPermission()` from a user gesture and shows the
  resulting state (unsupported / blocked / enabled).
- If a pending `pi.approval` is observed while the page is hidden — or the app is backgrounded while
  an approval is still pending — and permission is already granted, one local notification is shown
  per tool call (`tag: ribhu-approval-<callId>`). Clicking focuses the app; the approval card in the
  timeline is still the only place to decide. Notifications are never re-sent and never promise an
  approval result.
- PWA Web Push/VAPID exists for browsers; native APNs/FCM, quiet hours, and notification actions do not.
  Nothing arrives while the app is closed.

### Native projects: generated vs store-ready

`apps/mobile/ios/` and `apps/mobile/android/` are generated (Capacitor 8.6.2, no extra plugins) and
belong in version control. `apps/mobile/capacitor.config.ts` holds the ids:

| Item | Status |
| --- | --- |
| iOS Xcode project (`ios/App/App.xcodeproj`, SPM, deployment target iOS 15) | generated |
| Android Gradle project (`android/`, minSdk 24, compile/targetSdk 36) | generated |
| Web build + `npx cap sync` (web assets copied to both projects) | verified |
| iOS **simulator** Debug build, signing disabled | verified |
| Android **debug** APK build (SDK 36, build-tools 35, JDK 17, Gradle 8.14.3 wrapper) | verified |
| iOS device / archive / TestFlight / App Store | **not done** (needs Development Team + provisioning) |
| Android release keystore / signed AAB / Play Console | **not done** |
| `@capacitor/app` plugin so `appUrlOpen` deep links fire | **not installed/wired** |
| Custom URL scheme registration (`CFBundleURLTypes`, Android intent-filter) | **not configured** |
| APNs/FCM push, background modes, entitlements | **not configured** |

Build commands verified on this machine (2026-11-16, Xcode 27.2 / iOS Simulator 27.2 SDK):

```bash
# web build + copy into both native projects
npm run build -w @ribhu-voyager/mobile
cd apps/mobile && npx cap sync

# iOS simulator (no signing) -> BUILD SUCCEEDED, App.app is arm64+x86_64
cd apps/mobile/ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build

# Android debug APK -> BUILD SUCCESSFUL, app-debug.apk (~4 MB)
cd apps/mobile/android
./gradlew assembleDebug --no-daemon
```

Generated build directories (`App/build`, `DerivedData`, `android/.gradle`, `android/**/build`,
copied web assets, `local.properties`, config JSONs) are gitignored by the generated project
`.gitignore` files plus the root `.gitignore`. `android/local.properties` points at the local SDK and
must never be committed. The first Gradle build downloads the Gradle distribution and dependencies.

What these builds mean: the native containers compile and package the PWA. They are **unsigned
development artifacts**; they do not prove device installs, App Store/Play compliance, push, or
deep-link handling.

Capacitor 8 uses Swift Package Manager on iOS (the generated project depends on
`capacitor-swift-pm` 8.6.2); there is no Podfile and `pod install` is not part of the iOS build. The
generated `ios/` and `android/` projects are ordinary Capacitor templates apart from the config above
— icons/splash are the defaults and should be replaced before release.

## Working with the generated projects

Capacitor is already installed in `apps/mobile` (`@capacitor/core`, `@capacitor/ios`,
`@capacitor/android` as dependencies; `@capacitor/cli` as a dev dependency, all pinned to 8.6.2). The
native projects are generated; do not run `cap add` again unless you delete them. The day-to-day
loop:

```bash
npm run build -w @ribhu-voyager/mobile   # Vite build into apps/mobile/dist
cd apps/mobile && npx cap sync           # copy dist + update native plugin/config files
npx cap open ios                         # Xcode (SPM, no CocoaPods pods to install)
npx cap open android                     # Android Studio / Gradle
```

To regenerate from scratch: `rm -rf ios android && npx cap add ios && npx cap add android` (the
capacitor.config.ts ids stay the same). Keep the PWA as the web build; Capacitor only provides the
native container and the copied web assets.

Android needs a local SDK (`ANDROID_HOME` / `android/local.properties`), JDK 17+, and network access
on the first Gradle run. iOS needs Xcode with an iOS SDK; this repository builds for the simulator
with signing disabled. A device/TestFlight build additionally needs a Development Team,
provisioning profile, and (for App Store) `ExportOptions`/archive settings.

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

- Signed/archive native builds: no iOS Development Team/provisioning, no TestFlight/App Store
  submission, no Android release keystore, signed AAB, or Play Console listing.
- Release hardening: no app icons/splash review beyond Capacitor defaults, no privacy manifests,
  data-safety forms, or store metadata.
- Keychain/Keystore token storage; the token is in `localStorage`.
- OAuth code exchange, state verification, redirect allow-listing, token refresh.
- `@capacitor/app` plugin wiring, so `appUrlOpen` deep links do not reach the app yet.
- Push notifications of any kind (APNs/FCM/VAPID/service worker); notification approve/deny actions.
- Background execution or background reconnect; the app only reconnects on resume.
- Universal-link / custom-scheme registration and associated domains.
- Server-side routing of a token to a tenant runtime.

## Security and limitations to keep in mind

- The gateway setting can point the app at any http(s) server; a malicious server receives the
  configured token. Only change it on a trusted device.
- An `https:` page cannot open a `ws://` socket to an `http:` gateway (mixed content); configure an
  https gateway for hosted use.
- Native networking blocks plain HTTP by default: iOS App Transport Security rejects `http://`
  connections and Android clears cleartext traffic on API 28+. Use an `https://` gateway (with
  `wss://`) or add a debug-only ATS exception / `usesCleartextTraffic` flag; none is configured.
- Local notifications require the PWA to be open (foreground service worker is not enough); on iOS
  they only work from an installed home-screen app in supported versions.
- None of the native seams are a security boundary yet. Do not describe the current build as having
  secure token storage or verified deep links.

## Release checklist

- [x] Capacitor iOS/Android projects generated and kept in sync with the web build
- [x] iOS simulator build (signing disabled) and Android debug APK build verified locally
- [ ] Identity provider + backend code exchange
- [ ] State + redirect-URI verification for deep links
- [ ] `@capacitor/app` plugin + URL type / intent-filter wiring, verified on device
- [ ] Tenant-scoped token issuing
- [ ] Keychain/Keystore token storage (replace `tokenStore`)
- [ ] iOS Development Team, provisioning, archive, TestFlight
- [ ] Android release keystore, signed AAB, Play Console
- [ ] Push certificates, deep links, and notification actions
- [ ] Background reconnect / push-triggered sync
- [ ] App Store / Play Store privacy + data safety
- [ ] E2E on real devices against an HTTPS gateway
