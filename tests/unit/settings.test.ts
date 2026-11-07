import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, rootAttributes, speechRate, SETTINGS_SCRIPT, storedSettings } from "../../lib/client/settings";

describe("saved settings", () => {
  it("falls back to defaults for missing, malformed or unknown values", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("[]")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ textSize: "huge", theme: "purple", contrast: 3, speed: "warp", readAloud: "yes", nonverbal: 1 })))
      .toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid values", () => {
    const saved = { blind: true, nonverbal: true, textSize: "larger", contrast: "high", theme: "dark", readAloud: false, speed: "slow" } as const;
    expect(parseSettings(JSON.stringify(saved))).toEqual(saved);
  });

  it("follows the device for display options unless the user chose otherwise", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ textSize: "default", contrast: "auto", theme: "auto", readAloud: true, speed: "normal", blind: false, nonverbal: false });
    expect(rootAttributes(DEFAULT_SETTINGS)).toEqual({});
    expect(rootAttributes({ ...DEFAULT_SETTINGS, textSize: "large", contrast: "high", theme: "light" }))
      .toEqual({ "data-text-size": "large", "data-contrast": "high", "data-theme": "light" });
  });

  it("stores a contrast choice that matches the device as automatic", () => {
    expect(storedSettings({ ...DEFAULT_SETTINGS, contrast: "high" }, true).contrast).toBe("auto");
    expect(storedSettings({ ...DEFAULT_SETTINGS, contrast: "standard" }, false).contrast).toBe("auto");
    expect(storedSettings({ ...DEFAULT_SETTINGS, contrast: "high" }, false).contrast).toBe("high");
    expect(storedSettings({ ...DEFAULT_SETTINGS, contrast: "standard" }, true).contrast).toBe("standard");
  });

  it("maps talking speed to a speech rate", () => {
    expect(speechRate("slow")).toBeLessThan(speechRate("normal"));
    expect(speechRate("normal")).toBe(1);
    expect(speechRate("fast")).toBeGreaterThan(1);
  });

  it("applies only allow-listed attribute values before the page paints", () => {
    const attributes: Record<string, string> = {};
    const root = { setAttribute: (name: string, value: string) => { attributes[name] = value; } };
    const storage = { getItem: () => JSON.stringify({ textSize: "larger", theme: "dark", contrast: "\"><script>" }) };
    new Function("document", "localStorage", SETTINGS_SCRIPT)({ documentElement: root }, storage);
    expect(attributes).toEqual({ "data-text-size": "larger", "data-theme": "dark" });
    expect(() => new Function("document", "localStorage", SETTINGS_SCRIPT)({ documentElement: root }, { getItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });
});
