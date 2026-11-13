/**
 * Capacitor configuration for the native shell (foundation only).
 *
 * ## What this file does today
 *
 * - Sets the app id, name, and web build directory used by `npx cap sync`.
 * - Forces the Android webview to https, which WebCrypto/ServiceWorker need.
 * - Declares the `ribhu` URL scheme for the iOS shell once it exists. The web
 *   app itself parses `ribhu://oauth/callback?...` deep links in
 *   `src/deep-link.ts` (via Capacitor's `appUrlOpen` when injected).
 *
 * ## What is NOT implemented here
 *
 * - No `ios/` or `android/` project is generated in this repository. Create
 *   them with `npx cap add ios|android` after installing Capacitor yourself.
 * - No `server.url` override: the gateway is a persisted runtime setting
 *   (Session → Gateway), not baked into the native config.
 * - No custom-scheme / universal-link registration for Android (that needs an
 *   intent-filter in the generated AndroidManifest.xml) and no associated
 *   domains entitlement for iOS. Deep-link parsing only works once registered.
 * - No OAuth token exchange: a callback `code` is shown in the app, never
 *   exchanged (the backend endpoint does not exist).
 * - No APNs/FCM configuration, background modes, or push entitlements.
 *
 * See docs/NATIVE-SHELL.md for the exact implemented/not-implemented list.
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
    // Declared for ribhu:// deep links; only used once an iOS project is generated.
    scheme: "ribhu",
  },
};

export default config;
