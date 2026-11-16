/**
 * Capacitor configuration for the native shell.
 *
 * ## Generated projects (versioned)
 *
 * `ios/` and `android/` are real Capacitor 8.6.2 projects generated with
 * `npx cap add ios|android` and refreshed with `npx cap sync` after each web
 * build. The values below define them:
 *
 * - `appId` → iOS bundle id / Android `applicationId` (`dev.ribhu.voyager`).
 * - `appName` → display name (`Ribhu Voyager`).
 * - `webDir` → the Vite build copied into the native projects by `cap sync`
 *   (`dist`).
 * - `server.androidScheme: "https"` → https webview origin on Android, required
 *   by WebCrypto and service workers.
 * - `ios.scheme: "ribhu"` → the internal WKWebView scheme (origin
 *   `ribhu://localhost`). This is NOT an external URL type; `ribhu://oauth/...`
 *   deep links still need a CFBundleURLTypes entry in the Xcode project
 *   (iOS) and an intent-filter in AndroidManifest.xml, plus the `@capacitor/app`
 *   plugin so `appUrlOpen` fires. None of that is wired yet.
 *
 * ## Signing and push status
 *
 * - Android: release `assembleRelease`/`bundleRelease` build a signed APK/AAB
 *   when the gitignored `apps/mobile/android/keystore.properties` (and its
 *   repo-root `.secrets/` keystore) exist; without them they build an unsigned
 *   artifact. That keystore is a local development key, not a Play credential,
 *   and is never committed.
 * - iOS: Release simulator builds are verified with signing disabled. Device /
 *   archive / TestFlight / App Store signing is blocked because this machine
 *   has no Xcode Apple ID account, no iOS App Development provisioning profile
 *   for `dev.ribhu.voyager`, and no Apple Distribution certificate. The App
 *   target is wired for team `RSH5FK4MB6` with automatic signing and
 *   `App/App.entitlements`.
 * - Push: `@capacitor/push-notifications` is installed/synced. iOS carries an
 *   `aps-environment` (development) entitlement plus the
 *   `remote-notification` background mode; Android gets the plugin manifest
 *   permissions and applies `google-services` only when
 *   `android/app/google-services.json` exists. No APNs/FCM credentials are
 *   committed, so native push cannot deliver end-to-end yet.
 * - No `server.url` override: the gateway is a persisted runtime setting
 *   (Session → Gateway), not baked into the native config.
 * - No OAuth token exchange endpoint; no APNs/FCM provider on the backend.
 *
 * See docs/NATIVE-SHELL.md for the generated-vs-store-ready matrix and the
 * exact build/signing commands, hashes, and blockers.
 */
const config = {
  appId: "dev.ribhu.voyager",
  appName: "Ribhu Voyager",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  ios: {
    contentInset: "always",
    // Internal WKWebView scheme (ribhu://localhost), not a registered URL type.
    scheme: "ribhu",
  },
};

export default config;
