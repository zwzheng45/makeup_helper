"use client";

import { useEffect, useState } from "react";
import { appPath } from "../lib/app-path";
import {
  applySettings, DEFAULT_SETTINGS, deviceHighContrast, loadSettings, saveSettings, storedSettings,
  type Contrast, type MirrorSettings, type Speed, type TextSize, type Theme,
} from "../lib/client/settings";
import { Icon, Wordmark } from "./ui";

interface Choice<T extends string> { value: T; label: string }

function Segmented<T extends string>({ name, label, value, choices, onChange }: {
  name: string; label: string; value: T; choices: Choice<T>[]; onChange: (value: T) => void;
}) {
  const labelId = `${name}-label`;
  return <div className="setting" role="radiogroup" aria-labelledby={labelId}>
    <span className="setting-label" id={labelId}>{label}</span>
    <span className="segmented">
      {choices.map((choice) => <label key={choice.value} className="segment">
        <input type="radio" name={name} value={choice.value} checked={value === choice.value} onChange={() => onChange(choice.value)} />
        <span>{choice.label}</span>
      </label>)}
    </span>
  </div>;
}

const TEXT_SIZES: Choice<TextSize>[] = [{ value: "default", label: "Default" }, { value: "large", label: "Large" }, { value: "larger", label: "Larger" }];
const CONTRASTS: Choice<Exclude<Contrast, "auto">>[] = [{ value: "standard", label: "Standard" }, { value: "high", label: "High" }];
const THEMES: Choice<Theme>[] = [{ value: "auto", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }];
const SPEEDS: Choice<Speed>[] = [{ value: "slow", label: "Slow" }, { value: "normal", label: "Normal" }, { value: "fast", label: "Fast" }];

export function SetupScreen() {
  const [settings, setSettings] = useState<MirrorSettings>(DEFAULT_SETTINGS);
  const [deviceHigh, setDeviceHigh] = useState(false);

  useEffect(() => {
    setSettings(loadSettings());
    setDeviceHigh(deviceHighContrast());
    let queries: MediaQueryList[] = [];
    try { queries = [window.matchMedia("(prefers-contrast: more)"), window.matchMedia("(forced-colors: active)")]; } catch { /* Older browsers. */ }
    const update = () => setDeviceHigh(deviceHighContrast());
    queries.forEach((query) => query.addEventListener?.("change", update));
    return () => queries.forEach((query) => query.removeEventListener?.("change", update));
  }, []);

  function change(patch: Partial<MirrorSettings>) {
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      applySettings(next); // Preview immediately; Save keeps it.
      return next;
    });
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const stored = storedSettings(settings, deviceHigh);
    applySettings(stored);
    const saved = saveSettings(stored);
    // If this browser blocks storage, carry the choices in the address instead of losing them.
    window.location.assign(appPath(saved ? "/mirror" : `/mirror?settings=${encodeURIComponent(JSON.stringify(stored))}`));
  }

  const contrast = settings.contrast === "auto" ? (deviceHigh ? "high" : "standard") : settings.contrast;

  return <div className="setup-page">
    <header className="setup-header"><Wordmark /></header>
    <main id="main" className="setup-main">
      <h1>Set up Mirror your way.</h1>
      <form className="setup-form" onSubmit={save}>
        <div className="setup-grid">
          <fieldset className="panel panel-use">
            <legend className="panel-title">How will you use Mirror? <span className="optional">(optional)</span></legend>
            <label className="choice">
              <input type="checkbox" checked={settings.blind} onChange={(event) => change({ blind: event.currentTarget.checked, ...(event.currentTarget.checked ? { readAloud: true } : {}) })} />
              <span className="choice-icon"><Icon name="sound" size={24} /></span>
              <span className="choice-label">Blind or low vision</span>
              <span className="choice-check"><Icon name="check" size={16} /></span>
            </label>
            <label className="choice">
              <input type="checkbox" checked={settings.nonverbal} onChange={(event) => change({ nonverbal: event.currentTarget.checked })} />
              <span className="choice-icon"><Icon name="keyboard" size={24} /></span>
              <span className="choice-label">Nonverbal (type instead)</span>
              <span className="choice-check"><Icon name="check" size={16} /></span>
            </label>
          </fieldset>

          <section className="panel panel-display" aria-labelledby="display-title">
            <h2 id="display-title" className="panel-title">Display and sound</h2>
            <Segmented name="text-size" label="Text size" value={settings.textSize} choices={TEXT_SIZES} onChange={(textSize) => change({ textSize })} />
            <Segmented name="contrast" label="Contrast" value={contrast} choices={CONTRASTS} onChange={(value) => change({ contrast: value })} />
            <Segmented name="theme" label="Theme" value={settings.theme} choices={THEMES} onChange={(theme) => change({ theme })} />
            <div className="setting">
              <label className="setting-label" htmlFor="read-aloud">Read replies aloud</label>
              <input id="read-aloud" className="switch" type="checkbox" role="switch" checked={settings.readAloud} onChange={(event) => change({ readAloud: event.currentTarget.checked })} />
            </div>
            <Segmented name="speed" label="Talking speed" value={settings.speed} choices={SPEEDS} onChange={(speed) => change({ speed })} />
          </section>
        </div>

        <div className="setup-actions">
          <p className="fine-print">To answer you, Mirror sends your camera view and questions to Gemini. Nothing is saved on our server.</p>
          <button type="submit" className="button button-primary button-large">Save and continue<Icon name="arrow" /></button>
        </div>
      </form>
    </main>
  </div>;
}
