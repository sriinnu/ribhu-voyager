# Native Shell, Deep Links, and Approval Notifications

Status: **native projects generated; iOS simulator + Release simulator and Android debug/release
builds verified on this machine.** `apps/mobile/ios/` and `apps/mobile/android/` are real Capacitor
8.6.2 projects kept in sync with the web build. The Android release APK/AAB are signed with a local
development keystore (gitignored, not a Play/store credential). iOS device/TestFlight/App Store
signing is still blocked: there is no Xcode Apple ID account, no iOS App Development provisioning
profile for `dev.ribhu.voyager`, and no Apple Distribution certificate. Native APNs/FCM plumbing is in
place but has no push credentials. There is no OAuth token exchange endpoint. This document states
exactly what the code, native projects, and signing setup do today and what is still missing.

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
- PWA Web Push/VAPID exists for browsers (`src/push.ts` + Session). Native APNs/FCM registration
  plumbing exists (see below) but has no credentials yet; quiet hours and notification actions do not
  exist. Nothing arrives while the app is closed.

### Native push (APNs/FCM) plumbing

`@capacitor/push-notifications@8.1.3` is installed and synced into both native projects:
`ios/App/CapApp-SPM/Package.swift` depends on the plugin's Swift package, and Android includes
`:capacitor-push-notifications` in `capacitor.settings.gradle` with the plugin registered in
`capacitor.plugins.json`.

`apps/mobile/src/native-push.ts` is the registration seam (separate from the browser Web Push module
`push.ts`):

- `registerNativePushToken()` requests notification permission, registers with APNs/FCM, and resolves
  `{ token, platform }` — or `null` when running on web, permission is not granted, or the platform
  never delivers a token (simulator/no credentials).
- `requestNativePushPermission()`, `nativePushSupported()`, `nativePushPlatform()` and
  `cachedNativePushToken()` support callers.
- The token is **not sent to the gateway**: no protocol/server changes, no device registry. A future
  task can add a message type/endpoint to upload it.

Platform config added:

- iOS: `ios/App/App/App.entitlements` with `aps-environment = development`, wired through
  `CODE_SIGN_ENTITLEMENTS`; `UIBackgroundModes = [remote-notification]` in `Info.plist`;
  `DEVELOPMENT_TEAM = RSH5FK4MB6` with `CODE_SIGN_STYLE = Automatic`.
- Android: the plugin's manifest merge adds `POST_NOTIFICATIONS`, `com.google.android.c2dm.permission.RECEIVE`
  and `WAKE_LOCK` (verified in the release APK). The Firebase `google-services` plugin is applied only
  when `android/app/google-services.json` exists (Capacitor template logic), so the build succeeds
  without Firebase credentials.

Still missing for push to work end-to-end: an APNs auth key/certificate plus an iOS provisioning
profile with push enabled plus an APNs provider in the backend; and a Firebase project with
`google-services.json` plus server-side FCM credentials. Both credential files are gitignored. There
is no production (`aps-environment: production`) setup, no notification actions, and no background
token refresh.

### Native projects: generated vs store-ready

`apps/mobile/ios/` and `apps/mobile/android/` are generated (Capacitor 8.6.2 plus
`@capacitor/push-notifications` 8.1.3) and belong in version control.
`apps/mobile/capacitor.config.ts` holds the ids:

| Item | Status |
| --- | --- |
| iOS Xcode project (`ios/App/App.xcodeproj`, SPM, deployment target iOS 15) | generated |
| Android Gradle project (`android/`, minSdk 24, compile/targetSdk 36) | generated |
| Web build + `npx cap sync` (web assets + push plugin) | verified |
| iOS **simulator** Debug build, signing disabled | verified |
| iOS **simulator Release** build, signing disabled | verified (arm64 + x86_64) |
| Android **debug** APK, with and without `keystore.properties` | verified |
| Android **release** APK + AAB signed with local dev keystore | verified locally (not uploaded) |
| iOS **device/archive signing** | **blocked**: no Xcode account, no iOS profile for `dev.ribhu.voyager`, no Apple Distribution cert. Unsigned arm64 device archive compiles but is not installable |
| Android Play Console / signed AAB upload / Play App Signing | **not done** |
| `@capacitor/app` plugin so `appUrlOpen` deep links fire | **not installed/wired** |
| Custom URL scheme registration (`CFBundleURLTypes`, Android intent-filter) | **not configured** |
| APNs/FCM plumbing (plugin, entitlements, background mode, manifest perms, registration seam) | **configured** |
| APNs/FCM credentials + end-to-end delivery | **missing** (no APNs key/profile, no `google-services.json`, no backend provider) |

Build commands verified on this machine (2026-11-16, Xcode 27.2 / iOS 27.2 SDK, Android SDK 36):

```bash
# web build + copy into both native projects
npm run build -w @ribhu-voyager/mobile
cd apps/mobile && npx cap sync

# iOS simulator Release (no signing) -> BUILD SUCCEEDED, App.app is arm64+x86_64
cd apps/mobile/ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build

# iOS device automatic-signing attempt -> BUILD FAILED (no account/profile; see blockers)
xcodebuild -project App.xcodeproj -scheme App -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=RSH5FK4MB6 CODE_SIGN_STYLE=Automatic build

# unsigned device archive (proves arm64 compile; not installable) -> ARCHIVE SUCCEEDED
xcodebuild -project App.xcodeproj -scheme App -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -archivePath /tmp/RibhuVoyager-unsigned.xcarchive \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" archive

# Android debug APK (works with or without keystore.properties) -> BUILD SUCCESSFUL
cd apps/mobile/android
./gradlew assembleDebug --no-daemon

# Android signed release APK + AAB (needs keystore.properties) -> BUILD SUCCESSFUL
./gradlew bundleRelease assembleRelease --no-daemon
```

### Signing artifacts and verification (local only)

The Android release keystore exists only on this machine, under the repo-root `.secrets/` directory
(gitignored, mode `600`):

| Item | Value |
| --- | --- |
| Keystore | `.secrets/ribhu-release.keystore` (PKCS12, mode 600) |
| Key alias | `ribhu-release` (4096-bit RSA, `SHA384withRSA`, self-signed, valid until 2054-04-03) |
| Certificate SHA-256 | `E6:78:83:E8:84:90:8A:86:17:4F:99:31:C3:36:30:D2:F0:E3:C9:2C:8B:20:4C:B2:2E:FB:E6:B5:0C:0A:D4:19` |
| Passwords | only in gitignored `apps/mobile/android/keystore.properties` (mode 600); generated randomly, never printed/committed |
| Signed APK | `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` — 4,555,004 bytes, SHA-256 `9e8cd954c09c10c4b389e94c9c4fb357d315643f0cf882374ea54d098f0f14e3` |
| Signed AAB | `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab` — 4,274,735 bytes, SHA-256 `b96993ddbe775d20e60c3935c04b81c0f52c9bc5d02ff6fa50f37c4ca3efe1be` |
| APK signature | `apksigner verify --print-certs`: verifies, **v2 scheme true** (v1/v3 false), signer DN `CN=Ribhu Voyager Release, OU=Mobile, O=Ribhu Voyager, L=Local, ST=Local, C=US` |
| AAB signature | `jarsigner -verify -certs app-release.aab`: `jar verified.` (exit 0) |

That keystore is a **local development signing identity**, not a Play/App Store credential. Losing it
means future updates cannot be signed with the same identity; back it up securely (the Play App
Signing upload-key flow is not configured). Regenerate with `keytool -genkeypair` using the settings
above if needed.

iOS signing artifacts: no signed/exported IPA exists. `xcodebuild` was attempted with
`DEVELOPMENT_TEAM=RSH5FK4MB6 CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates` and failed with
exit 65:

```text
error: No Accounts: Add a new account in Accounts settings. (in target 'App' from project 'App')
error: No profiles for 'dev.ribhu.voyager' were found: Xcode couldn't find any iOS App Development
provisioning profiles matching 'dev.ribhu.voyager'. (in target 'App' from project 'App')
** BUILD FAILED **
```

Available Apple identities (`security find-identity -v -p codesigning`): `Apple Development:
hello@srinivas.dev (4QRB4WHY83)` (team `RSH5FK4MB6`) and `Developer ID Application: Srinivas Pendela
(RSH5FK4MB6)` (macOS distribution). The only provisioning profiles installed are **Mac Team**
profiles for team `RSH5FK4MB6`; there is no iOS provisioning profile and no Apple Distribution
certificate. So device installs, TestFlight, and App Store/App Store Connect are blocked on Apple
account setup, not on code. The unsigned arm64 archive at `/tmp/RibhuVoyager-unsigned.xcarchive`
(`** ARCHIVE SUCCEEDED **`, arm64) proves the device build compiles.

Generated build directories (`App/build`, `DerivedData`, `android/.gradle`, `android/**/build`,
copied web assets, `local.properties`, config JSONs) are gitignored by the generated project
`.gitignore` files plus the root `.gitignore`. `android/local.properties` points at the local SDK and
must never be committed. The first Gradle build downloads the Gradle distribution and dependencies.

What these builds mean: the native containers compile and package the PWA. The iOS simulator and
device-archive artifacts are unsigned; the Android release APK/AAB are signed with the local
development keystore. None of them prove device installs, App Store/Play compliance, push delivery, or
deep-link handling.

Capacitor 8 uses Swift Package Manager on iOS (the generated project depends on
`capacitor-swift-pm` 8.6.2); there is no Podfile and `pod install` is not part of the iOS build. The
generated `ios/` and `android/` projects are ordinary Capacitor templates apart from the config above
— icons/splash are the defaults and should be replaced before release.

## Working with the generated projects

Capacitor is already installed in `apps/mobile` (`@capacitor/core`, `@capacitor/ios`,
`@capacitor/android`, `@capacitor/push-notifications` as dependencies; `@capacitor/cli` as a dev
dependency). The native projects are generated; do not run `cap add` again unless you delete them.
The day-to-day loop:

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

Signing (local): Android release signing is optional and driven by gitignored
`apps/mobile/android/keystore.properties` plus `.secrets/ribhu-release.keystore`. Without those files
`bundleRelease`/`assembleRelease` still build an unsigned artifact, and `assembleDebug` is unaffected.
Never commit the keystore or the properties file. iOS signing uses team `RSH5FK4MB6`, automatic
signing, and `ios/App/App/App.entitlements`; a device build needs the Apple ID account and a matching
iOS provisioning profile (neither exists on this machine yet).

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

- iOS device/TestFlight/App Store builds: no Xcode Apple ID account, no iOS App Development
  provisioning profile for `dev.ribhu.voyager`, no Apple Distribution certificate, no App Store
  Connect setup. The unsigned arm64 device archive is not installable.
- Google Play distribution: the local release APK/AAB are signed with a development keystore only
  (not committed, not a Play credential); no Play Console listing, Play App Signing, or upload-key
  management.
- Release hardening: no app icons/splash review beyond Capacitor defaults, no privacy manifests,
  data-safety forms, or store metadata, no CI secret injection for signing.
- Push delivery end-to-end: native registration plumbing exists, but APNs credentials/provisioning and
  FCM `google-services.json` + server credentials are missing, and the token is not uploaded to the
  gateway (no device registry/endpoint). Notification actions and quiet hours do not exist.
- Keychain/Keystore token storage; the token is in `localStorage`.
- OAuth code exchange, state verification, redirect allow-listing, token refresh.
- `@capacitor/app` plugin wiring, so `appUrlOpen` deep links do not reach the app yet.
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
- Never commit signing material. `.secrets/`, `apps/mobile/android/keystore.properties`,
  `google-services.json`, `GoogleService-Info.plist`, provisioning profiles, and certificate files are
  gitignored. Losing the Android keystore means updates can no longer be signed with the same
  identity; treat it as a secret and back it up outside the repo.
- The Android release key is a local development identity (self-signed); it is not enrolled in Play
  App Signing. The iOS entitlement is `aps-environment: development`; store distribution requires
  `production` plus an Apple Distribution certificate and profile.
- Native APNs/FCM credentials are absent, so push registration will not produce usable tokens
  end-to-end on this machine; the registration seam is tested for API shape, not delivery.
- None of the native seams are a security boundary yet. Do not describe the current build as having
  secure token storage or verified deep links.

## Release checklist

- [x] Capacitor iOS/Android projects generated and kept in sync with the web build
- [x] iOS simulator build (signing disabled) and Android debug APK build verified locally
- [x] iOS Release simulator build and unsigned arm64 device archive verified locally
- [x] Android release APK/AAB signed and signature-verified locally (development keystore, gitignored)
- [x] APNs/FCM plumbing: plugin synced, entitlements/background mode, manifest permissions, registration seam
- [ ] Identity provider + backend code exchange
- [ ] State + redirect-URI verification for deep links
- [ ] `@capacitor/app` plugin + URL type / intent-filter wiring, verified on device
- [ ] Tenant-scoped token issuing
- [ ] Keychain/Keystore token storage (replace `tokenStore`)
- [ ] Xcode Apple ID account + iOS provisioning profile + Apple Distribution certificate, then device/TestFlight/App Store
- [ ] Play Console setup + Play App Signing (local dev keystore is not a store credential)
- [ ] APNs key/cert + FCM `google-services.json` + backend push provider + token upload endpoint
- [ ] Secure keystore backup and CI signing-secret injection
- [ ] Push notification actions, quiet hours, and background token refresh
- [ ] Background reconnect / push-triggered sync
- [ ] App Store / Play Store privacy + data safety
- [ ] E2E on real devices against an HTTPS gateway
