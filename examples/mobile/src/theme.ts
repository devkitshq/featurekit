/** The browser demo's palette, as a StyleSheet-friendly object. */
export const theme = {
  bg: "#090b10",
  surface1: "#11141c",
  surface2: "#181d27",
  surface3: "#222938",
  line: "#293142",
  lineHighlight: "#3b465c",

  ink: "#f0f4fc",
  inkMuted: "#9aa5bc",
  inkDim: "#657088",

  accent: "#3b82f6",
  accentSoft: "rgba(59, 130, 246, 0.16)",
  success: "#10b981",
  successSoft: "rgba(16, 185, 129, 0.14)",
  warning: "#f59e0b",
  warningSoft: "rgba(245, 158, 11, 0.14)",
  danger: "#ef4444",
  dangerSoft: "rgba(239, 68, 68, 0.14)",
  purple: "#a855f7",
  purpleSoft: "rgba(168, 85, 247, 0.14)",
} as const;

export const mono = { fontFamily: "monospace" } as const;
