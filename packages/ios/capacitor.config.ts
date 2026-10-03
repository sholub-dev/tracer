import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "sh.tracer.app",
  appName: "Tracer",
  webDir: "../web/dist-ios",
  plugins: {
    // Global fetch goes native, which skips CORS for data-source APIs; LLM calls keep the streaming WebView fetch.
    CapacitorHttp: { enabled: true },
    Keyboard: { resize: "native", resizeOnFullScreen: true },
    CapacitorSQLite: {
      iosDatabaseLocation: "Library/CapacitorDatabase",
      iosIsEncryption: true,
      iosKeychainPrefix: "tracer",
      iosBiometric: { biometricAuth: false, biometricTitle: "Unlock Tracer" },
    },
  },
};

export default config;
