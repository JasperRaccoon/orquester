import type { Config } from "tailwindcss";
import { orquesterPreset } from "../../packages/ui/tailwind-preset";

export default {
  presets: [orquesterPreset],
  // The embed (src/embed) compiles its own CSS: vite.embed.config.ts.
  content: ["./index.html", "./src/**/*.{ts,tsx}", "!./src/embed/**", "../../packages/ui/src/**/*.{ts,tsx}"],
  theme: {
    extend: {}
  },
  plugins: []
} satisfies Config;
