import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "sh.tracer.app",
  appName: "Tracer",
  webDir: "../web/dist-ios",
  // The app scrolls inside its own panels. A scrolling outer page lets iOS push the screen up when the keyboard opens.
  ios: { scrollEnabled: false },
  plugins: {
    // Global fetch goes native, which skips CORS for data-source APIs; LLM calls keep the streaming WebView fetch.
    CapacitorHttp: { enabled: true },
    // The WebView shrinks above the keyboard; the window behind it takes the page color, not black.
    Keyboard: { resize: "native", resizeOnFullScreen: true, autoBackdropColor: "dom" },
    CapacitorSQLite: {
      iosDatabaseLocation: "Library/CapacitorDatabase",
      iosIsEncryption: true,
      iosKeychainPrefix: "tracer",
      iosBiometric: { biometricAuth: false, biometricTitle: "Unlock Tracer" },
    },
  },
};

export default config;
