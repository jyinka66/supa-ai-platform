import type { Config } from "tailwindcss";
import { tokens } from "@supa/ui/tokens";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx,mdx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: tokens.colors,
      spacing: tokens.spacing,
      borderRadius: tokens.radius,
      fontSize: tokens.fontSize,
      fontFamily: {
        sans: tokens.fontFamily.sans.split(", "),
        mono: tokens.fontFamily.mono.split(", "),
      },
    },
  },
  plugins: [],
};

export default config;
