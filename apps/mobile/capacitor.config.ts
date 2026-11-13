/**
 * Native-shell foundation. After installing @capacitor/core and @capacitor/cli:
 *   npx cap add ios
 *   npx cap add android
 *   npm run build && npx cap sync
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
  },
};

export default config;
