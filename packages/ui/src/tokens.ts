/**
 * Design tokens — single source of truth for colors, spacing, typography.
 * Importable by both @supa/ui components and the web app.
 */
export const tokens = {
  colors: {
    // semantic
    surface: "#ffffff",
    surfaceMuted: "#f5f5f5",
    border: "#e5e5e5",
    text: "#0a0a0a",
    textMuted: "#525252",
    accent: "#3b82f6",
    accentHover: "#2563eb",
    danger: "#dc2626",
    success: "#16a34a",
    warning: "#ca8a04",
  },
  spacing: {
    xs: "0.25rem",
    sm: "0.5rem",
    md: "1rem",
    lg: "1.5rem",
    xl: "2rem",
    "2xl": "3rem",
  },
  radius: {
    sm: "0.25rem",
    md: "0.5rem",
    lg: "1rem",
    full: "9999px",
  },
  fontSize: {
    xs: "0.75rem",
    sm: "0.875rem",
    md: "1rem",
    lg: "1.125rem",
    xl: "1.25rem",
    "2xl": "1.5rem",
    "3xl": "1.875rem",
  },
  fontFamily: {
    sans: "Inter, system-ui, sans-serif",
    mono: "JetBrains Mono, ui-monospace, monospace",
  },
} as const;

export type Tokens = typeof tokens;
