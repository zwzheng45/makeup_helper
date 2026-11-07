/** Personal settings chosen on the setup page and kept in this browser only. */
import type { SpeechRate } from "../contracts";
export type TextSize = "default" | "large" | "larger";
export type Contrast = "auto" | "standard" | "high";
export type Theme = "auto" | "light" | "dark";
export type Speed = "slow" | "normal" | "fast";

export interface MirrorSettings {
  /** The person is blind or has low vision: replies are always spoken. */
  blind: boolean;
  /** The person types instead of speaking; the microphone is never used. */
  nonverbal: boolean;
  textSize: TextSize;
  contrast: Contrast;
  theme: Theme;
  readAloud: boolean;
  speed: Speed;
}

export const SETTINGS_KEY = "mirror-settings";

/** Display options start from the device; "default" text size is the browser's own size. */
export const DEFAULT_SETTINGS: MirrorSettings = Object.freeze({
  blind: false, nonverbal: false, textSize: "default", contrast: "auto", theme: "auto", readAloud: true, speed: "normal",
});

const TEXT_SIZES: readonly TextSize[] = ["default", "large", "larger"];
const CONTRASTS: readonly Contrast[] = ["auto", "standard", "high"];
const THEMES: readonly Theme[] = ["auto", "light", "dark"];
const SPEEDS: readonly Speed[] = ["slow", "normal", "fast"];

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

export function parseSettings(raw: string | null): MirrorSettings {
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    blind: typeof saved.blind === "boolean" ? saved.blind : DEFAULT_SETTINGS.blind,
    nonverbal: typeof saved.nonverbal === "boolean" ? saved.nonverbal : DEFAULT_SETTINGS.nonverbal,
    textSize: pick(TEXT_SIZES, saved.textSize, DEFAULT_SETTINGS.textSize),
    contrast: pick(CONTRASTS, saved.contrast, DEFAULT_SETTINGS.contrast),
    theme: pick(THEMES, saved.theme, DEFAULT_SETTINGS.theme),
    readAloud: typeof saved.readAloud === "boolean" ? saved.readAloud : DEFAULT_SETTINGS.readAloud,
    speed: pick(SPEEDS, saved.speed, DEFAULT_SETTINGS.speed),
  };
}

export function loadSettings(): MirrorSettings {
  try { return parseSettings(window.localStorage.getItem(SETTINGS_KEY)); } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(settings: MirrorSettings): boolean {
  try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; } catch { return false; }
}

/** A contrast choice that matches the device is saved as automatic, so later device changes are still followed. */
export function storedSettings(settings: MirrorSettings, deviceHighContrast: boolean): MirrorSettings {
  const matchesDevice = settings.contrast === (deviceHighContrast ? "high" : "standard");
  return { ...settings, contrast: matchesDevice ? "auto" : settings.contrast };
}

export function deviceHighContrast(): boolean {
  try { return window.matchMedia("(prefers-contrast: more)").matches || window.matchMedia("(forced-colors: active)").matches; } catch { return false; }
}

export function rootAttributes(settings: MirrorSettings): Record<string, string> {
  return {
    ...(settings.textSize !== "default" ? { "data-text-size": settings.textSize } : {}),
    ...(settings.contrast !== "auto" ? { "data-contrast": settings.contrast } : {}),
    ...(settings.theme !== "auto" ? { "data-theme": settings.theme } : {}),
  };
}

/** Applies display settings to <html>; CSS media queries handle everything left on automatic. */
export function applySettings(settings: MirrorSettings): void {
  const root = document.documentElement;
  const attributes = rootAttributes(settings);
  for (const name of ["data-text-size", "data-contrast", "data-theme"]) {
    if (attributes[name]) root.setAttribute(name, attributes[name]);
    else root.removeAttribute(name);
  }
}

export function speechRate(speed: Speed): SpeechRate {
  return speed === "slow" ? 0.8 : speed === "fast" ? 1.25 : 1;
}

/** Runs in <head> before first paint so saved display choices never flash. Values are allow-listed. */
export const SETTINGS_SCRIPT = `try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)})||"{}"),r=document.documentElement,`
  + `a={"data-text-size":{k:"textSize",v:["large","larger"]},"data-theme":{k:"theme",v:["light","dark"]},"data-contrast":{k:"contrast",v:["standard","high"]}};`
  + `for(var n in a){var v=s&&s[a[n].k];if(a[n].v.indexOf(v)>=0)r.setAttribute(n,v)}}catch(e){}`;
