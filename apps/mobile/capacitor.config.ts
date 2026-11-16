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
 * ## Generated but NOT signed or store-ready
 *
 * - iOS builds only for the simulator so far. The `App` target has no
 *   DEVELOPMENT_TEAM, provisioning profile, or App Store Connect setup; a
 *   device/archive build and TestFlight are still to do.
 * - Android builds a debug APK. There is no release keystore, no signed AAB,
 *   and no Play Console listing. `android/local.properties` (SDK path) is
 *   machine-local and gitignored.
 * - No `server.url` override: the gateway is a persisted runtime setting
 *   (Session → Gateway), not baked into the native config.
 * - No OAuth token exchange endpoint; no APNs/FCM push configuration or
 *   entitlements.
 *
 * See docs/NATIVE-SHELL.md for the generated-vs-store-ready matrix and the
 * exact build commands/results.
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
