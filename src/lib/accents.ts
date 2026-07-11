// Catppuccin Mocha accent palette (RGB triplets), used to tint per-item chrome:
// recent-folder chips on the empty state, and each session tab's border/background/dot.
export const CATPPUCCIN_ACCENTS = [
  "245 224 220", // rosewater
  "242 205 205", // flamingo
  "245 194 231", // pink
  "203 166 247", // mauve
  "243 139 168", // red
  "235 160 172", // maroon
  "250 179 135", // peach
  "249 226 175", // yellow
  "166 227 161", // green
  "148 226 213", // teal
  "137 220 235", // sky
  "116 199 236", // sapphire
  "137 180 250", // blue
  "180 190 254", // lavender
];

export function catppuccinAccentFor(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return CATPPUCCIN_ACCENTS[Math.abs(hash) % CATPPUCCIN_ACCENTS.length];
}
