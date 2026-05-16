/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cc: {
          background: "rgb(var(--cc-background-rgb) / <alpha-value>)",
          foreground: "rgb(var(--cc-foreground-rgb) / <alpha-value>)",
          border: "var(--cc-border)",
          accent: "rgb(var(--cc-accent-rgb) / <alpha-value>)",
          surface: "rgb(var(--cc-surface-rgb) / <alpha-value>)",
          "surface-strong": "rgb(var(--cc-surface-strong-rgb) / <alpha-value>)",
          muted: "rgb(var(--cc-muted-rgb) / <alpha-value>)",
        },
      },
      fontFamily: {
        mono: ["var(--cc-font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["var(--cc-font-sans)", "system-ui", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
      },
    },
  },
  darkMode: "class",
  plugins: [],
};
