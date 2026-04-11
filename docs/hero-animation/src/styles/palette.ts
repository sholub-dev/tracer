// OKO colors mirrored from packages/web/src/lib/theme.ts

export const palette = {
  // Backgrounds
  shell: "#fafaf8",
  sidebar: "#f7f6f3",
  white: "#ffffff",
  cardBg: "#f5f4f0",

  // Text
  textPrimary: "#2c2c2c",
  textBody: "#444444",
  textSecondary: "#666666",
  textMuted: "#9c9890",

  // Accent
  accent: "#2b5ea7",
  accentHover: "#234d8a",
  accentLight: "#eaf0f8",

  // Borders
  border: "#d4d2cd",
  borderLight: "#e8e6e1",

  // Status
  success: "#2a7a4a",
  successBg: "#f2f8f5",
  successBorder: "#c8e0d2",
  error: "#b33a2a",
  errorBg: "rgba(179, 58, 42, 0.1)",
  warn: "#a07020",

  // Charts
  chart: ["#6b9fd4", "#6bb88a", "#d4806e", "#d4b06b", "#a488c4", "#6bb8aa"],
} as const;
