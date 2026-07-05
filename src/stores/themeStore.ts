import { create } from "zustand";

export type PaletteName = "light" | "latte" | "dark" | "mocha";

export interface Palette {
  name: PaletteName;
  label: string;
  background: string;
  foreground: string;
  muted: string;
  surface: string;
  surfaceStrong: string;
  border: string;
  accent: string;
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

export const palettes: Record<PaletteName, Palette> = {
  light: {
    name: "light",
    label: "Light",
    background: "#f8f5ef",
    foreground: "#2f2923",
    muted: "#7a7067",
    surface: "#fffdf8",
    surfaceStrong: "#eee8df",
    border: "rgba(47, 41, 35, 0.14)",
    accent: "#d97757",
    terminal: claudeLightTerminal(),
  },
  latte: {
    name: "latte",
    label: "Latte",
    background: "#eff1f5",
    foreground: "#4c4f69",
    muted: "#7c7f93",
    surface: "#e6e9ef",
    surfaceStrong: "#dce0e8",
    border: "rgba(76, 79, 105, 0.16)",
    accent: "#1e66f5",
    terminal: catppuccinLatteTerminal(),
  },
  dark: {
    name: "dark",
    label: "Dark",
    background: "#191715",
    foreground: "#f1ece3",
    muted: "#a79f96",
    surface: "#211f1c",
    surfaceStrong: "#2c2925",
    border: "rgba(241, 236, 227, 0.13)",
    accent: "#d97757",
    terminal: claudeDarkTerminal(),
  },
  mocha: {
    name: "mocha",
    label: "Mocha",
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    muted: "#a6adc8",
    surface: "#181825",
    surfaceStrong: "#313244",
    border: "rgba(69, 71, 90, 0.65)",
    accent: "#89b4fa",
    terminal: catppuccinMochaTerminal(),
  },
};

export type PalettePreference = PaletteName | "system";

interface ThemeState {
  preference: PalettePreference;
  systemDark: boolean;
  fontSize: "small" | "medium" | "large";
  setPreference: (preference: PalettePreference) => void;
  setFontSize: (fontSize: ThemeState["fontSize"]) => void;
}

function isPalettePreference(value: string | null): value is PalettePreference {
  return value === "system" || (!!value && value in palettes);
}

const systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export const useThemeStore = create<ThemeState>((set) => ({
  preference: (() => {
    const stored = localStorage.getItem("sogo.palette");
    return isPalettePreference(stored) ? stored : "mocha";
  })(),
  systemDark: systemDarkQuery.matches,
  fontSize: (localStorage.getItem("sogo.fontSize") as ThemeState["fontSize"] | null) ?? "medium",
  setPreference: (preference) => {
    localStorage.setItem("sogo.palette", preference);
    set({ preference });
  },
  setFontSize: (fontSize) => {
    localStorage.setItem("sogo.fontSize", fontSize);
    set({ fontSize });
  },
}));

systemDarkQuery.addEventListener("change", (event) => {
  useThemeStore.setState({ systemDark: event.matches });
});

export function resolvePaletteName(preference: PalettePreference, systemDark: boolean): PaletteName {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** Resolved palette for the current preference, tracking system appearance. */
export function useResolvedPalette(): Palette {
  const preference = useThemeStore((state) => state.preference);
  const systemDark = useThemeStore((state) => state.systemDark);
  return palettes[resolvePaletteName(preference, systemDark)];
}

export function applyPalette(palette: Palette) {
  const root = document.documentElement;
  root.style.colorScheme = palette.name === "light" || palette.name === "latte" ? "light" : "dark";
  root.style.setProperty("--cc-background", palette.background);
  root.style.setProperty("--cc-background-rgb", hexToRgbChannels(palette.background));
  root.style.setProperty("--cc-foreground", palette.foreground);
  root.style.setProperty("--cc-foreground-rgb", hexToRgbChannels(palette.foreground));
  root.style.setProperty("--cc-muted", palette.muted);
  root.style.setProperty("--cc-muted-rgb", hexToRgbChannels(palette.muted));
  root.style.setProperty("--cc-surface", palette.surface);
  root.style.setProperty("--cc-surface-rgb", hexToRgbChannels(palette.surface));
  root.style.setProperty("--cc-surface-strong", palette.surfaceStrong);
  root.style.setProperty("--cc-surface-strong-rgb", hexToRgbChannels(palette.surfaceStrong));
  root.style.setProperty("--cc-border", palette.border);
  root.style.setProperty("--cc-accent", palette.accent);
  root.style.setProperty("--cc-accent-rgb", hexToRgbChannels(palette.accent));
}

function hexToRgbChannels(hex: string) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;

  return `${red} ${green} ${blue}`;
}

function claudeLightTerminal(): Palette["terminal"] {
  return {
    background: "#fffdf8",
    foreground: "#2f2923",
    cursor: "#d97757",
    selectionBackground: "rgba(217, 119, 87, 0.22)",
    black: "#3a332d",
    red: "#b84a3b",
    green: "#4f7d4b",
    yellow: "#a46f18",
    blue: "#4772ad",
    magenta: "#9363a8",
    cyan: "#3d7d82",
    white: "#e7ded2",
    brightBlack: "#8a8076",
    brightRed: "#d45d4d",
    brightGreen: "#5f965a",
    brightYellow: "#c38322",
    brightBlue: "#5c84c6",
    brightMagenta: "#aa78be",
    brightCyan: "#4d969b",
    brightWhite: "#fffaf2",
  };
}

function claudeDarkTerminal(): Palette["terminal"] {
  return {
    background: "#191715",
    foreground: "#f1ece3",
    cursor: "#d97757",
    selectionBackground: "rgba(217, 119, 87, 0.24)",
    black: "#2c2925",
    red: "#e06c5f",
    green: "#8fbf7f",
    yellow: "#d9b36d",
    blue: "#7da6d9",
    magenta: "#c596d9",
    cyan: "#7fc4c8",
    white: "#ddd4c8",
    brightBlack: "#81776d",
    brightRed: "#f07f72",
    brightGreen: "#a5d995",
    brightYellow: "#edc77f",
    brightBlue: "#93bdf1",
    brightMagenta: "#d8acec",
    brightCyan: "#93d8dc",
    brightWhite: "#fff7ec",
  };
}

function catppuccinLatteTerminal(): Palette["terminal"] {
  return {
    background: "#eff1f5",
    foreground: "#4c4f69",
    cursor: "#dc8a78",
    selectionBackground: "#ccd0da",
    black: "#5c5f77",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb",
    cyan: "#179299",
    white: "#acb0be",
    brightBlack: "#6c6f85",
    brightRed: "#d20f39",
    brightGreen: "#40a02b",
    brightYellow: "#df8e1d",
    brightBlue: "#1e66f5",
    brightMagenta: "#ea76cb",
    brightCyan: "#179299",
    brightWhite: "#bcc0cc",
  };
}

function catppuccinMochaTerminal(): Palette["terminal"] {
  return {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    selectionBackground: "#45475a",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  };
}
