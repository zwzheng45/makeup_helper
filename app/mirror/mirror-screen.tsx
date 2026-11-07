"use client";

import { useEffect, useRef, useState } from "react";
import { appPath } from "../../lib/app-path";
import type { MirrorMode } from "../../lib/contracts";
import { applySettings, loadSettings, parseSettings, speechRate, type MirrorSettings } from "../../lib/client/settings";
import { MODE_LABELS, useMirror, type MirrorPhase } from "../../lib/client/use-mirror";
import { Icon, Wordmark } from "../ui";

const MODES: MirrorMode[] = ["general", "guided", "compare"];

const STARTERS: Record<MirrorMode, string[]> = {
  general: ["How does my hair look?", "Have I missed a spot?", "Is my makeup even?"],
  guided: ["Done, next step", "What do I do now?", "Please repeat that"],
  compare: ["How close am I?", "What should I fix first?"],
};

function statusText(phase: MirrorPhase, muted: boolean, typed: boolean): string {
  if (phase === "listening") return muted ? "Microphone muted" : typed ? "Ready for your question" : "Listening";
  return { idle: "Ready", starting: "Starting…", hearing: "Hearing you", thinking: "Thinking…", speaking: "Speaking", stopped: "Stopped", error: "Needs attention" }[phase];
}

function initialSettings(): MirrorSettings {
  // The address carries settings only when this browser blocked saving them.
  const fromAddress = new URLSearchParams(window.location.search).get("settings");
  return fromAddress ? parseSettings(fromAddress) : loadSettings();
}

export function MirrorScreen() {
  const [settings, setSettings] = useState<MirrorSettings | null>(null);
  const [question, setQuestion] = useState("");
  const typed = Boolean(settings?.nonverbal);
  const readAloud = settings?.readAloud ?? true;
  const mirror = useMirror({ inputMode: typed ? "text" : "voice", readAloud, speechRate: speechRate(settings?.speed ?? "normal") });
  const startRef = useRef<HTMLButtonElement>(null);
  const firstControlRef = useRef<HTMLButtonElement | HTMLInputElement | null>(null);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    const loaded = initialSettings();
    applySettings(loaded);
    setSettings(loaded);
  }, []);

  // The controls swap when the mirror starts or stops. Keep keyboard focus from falling back to the page.
  useEffect(() => {
    if (mirror.active === wasActiveRef.current) return;
    wasActiveRef.current = mirror.active;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    (mirror.active ? firstControlRef.current : startRef.current)?.focus();
  }, [mirror.active]);

  const starting = mirror.phase === "starting";
  const turns = mirror.history;
  const lastTurn = [...turns].reverse().find((turn) => turn.assistant || turn.user);
  const lastReply = [...turns].reverse().find((turn) => turn.assistant)?.assistant;
  const guidance = mirror.mode === "guided" ? mirror.guidanceContext : undefined;
  const startLabel = starting ? "Starting…" : mirror.audioError ? "Reconnect audio" : "Start mirror";

  /** Ends the session (camera and microphone off, conversation and photo cleared) and returns to the setup page. */
  function finish() {
    mirror.end();
    window.location.assign(appPath("/"));
  }

  function submitQuestion(event: React.FormEvent) {
    event.preventDefault();
    if (mirror.sendText(question)) setQuestion("");
  }

  return <div className={`mirror-page${mirror.cameraReady ? " has-camera" : ""}`}>
    <a className="skip-link" href="#mirror-controls">Skip to mirror controls</a>
    <div className="camera-backdrop" aria-hidden="true" />
    <video ref={mirror.videoRef} className={`camera-video${mirror.cameraReady ? " is-visible" : ""}`} autoPlay muted playsInline aria-hidden="true" />

    <header className="mirror-top">
      <span className="glass chip"><Wordmark /></span>
      <p className={`glass chip status${mirror.muted && mirror.active ? " is-muted" : ""}`}>
        <span className="status-dot" aria-hidden="true" />{statusText(mirror.phase, mirror.muted, typed)}
      </p>
      <div className="top-actions">
        {mirror.reference && <img className="look-thumb" src={mirror.reference.previewUrl} alt="Your look photo" />}
        <label className="button button-glass file-button">
          <Icon name="photo" />{mirror.reference ? "Change photo" : "Add photo"}
          <input id="reference-image" className="file-input" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="photo-help"
            onClick={mirror.prepareReferenceSelection}
            onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void mirror.selectReference(file); }} />
        </label>
        <span id="photo-help" className="visually-hidden">A photo of a makeup look to follow or check against. JPEG, PNG or WebP, up to 10 MB.</span>
        {(mirror.reference || mirror.referenceLoading) && <button type="button" className="button button-glass" onClick={() => { mirror.removeReference(); document.getElementById("reference-image")?.focus(); }}>Remove photo</button>}
        <a className="button button-glass" href={appPath("/")}><Icon name="settings" />Settings</a>
      </div>
    </header>

    <main id="main" className="mirror-main">
      <h1 className="visually-hidden">Mirror</h1>

      {mirror.reference && <fieldset className="glass mode-picker">
        <legend className="visually-hidden">Mode</legend>
        {MODES.map((mode) => <label key={mode} className="segment">
          <input type="radio" name="mirror-mode" value={mode} checked={mirror.mode === mode} disabled={mirror.referenceLoading} onChange={() => mirror.setMode(mode)} />
          <span>{MODE_LABELS[mode]}</span>
        </label>)}
      </fieldset>}

      {!mirror.active && <div className="mirror-center" id="mirror-controls">
        <h2>Come as you are.</h2>
        <button ref={startRef} type="button" className="button button-primary button-large start-button" aria-disabled={starting || mirror.referenceLoading || !settings}
          onClick={() => { if (!starting && !mirror.referenceLoading && settings) void mirror.start(); }}>
          <Icon name={typed ? "camera" : "mic"} />{startLabel}
        </button>
        <p className="fine-print">{typed ? "Mirror uses your camera. You type your questions." : "Mirror uses your camera and microphone."}</p>
      </div>}

      <div className="messages">
        {mirror.referenceError && <p className="message message-error" role="alert">{mirror.referenceError}</p>}
        <p className="message" role="status" aria-atomic="true">{mirror.referenceLoading ? "Preparing your photo…" : mirror.notice}</p>
        {/* Typed mode has no open microphone to pick up screen-reader speech, so the waiting state is announced.
            In voice mode it is not: an announcement could be heard as a new question and cancel the answer. */}
        <p className="visually-hidden" aria-live="polite">{typed && mirror.phase === "thinking" ? "Thinking…" : ""}</p>
      </div>

      {mirror.active && <div className="mirror-bottom" id="mirror-controls">
        <section className="glass reply-panel" aria-labelledby="reply-title">
          <h2 id="reply-title" className="visually-hidden">Conversation</h2>
          {guidance && (guidance.currentStep || guidance.complete) && <div className="current-step">
            <h3>{guidance.complete ? "Look complete" : "Your current step"}</h3>
            {guidance.currentStep && <p>{guidance.currentStep}</p>}
          </div>}
          {lastTurn?.user && <p className="you-said"><span>You:</span> {lastTurn.user}</p>}
          {/* Spoken replies are already heard; announce the text only when it is not read aloud. */}
          <div className="reply-text" aria-live={readAloud ? "off" : "polite"} aria-atomic="true">
            {lastReply ? <p>{lastReply}</p> : <p className="reply-placeholder">{typed ? "Type a question, or choose one below." : "Ask out loud, or choose a question below."}</p>}
          </div>
          <div className="starters" role="group" aria-label="Suggested questions">
            {STARTERS[mirror.mode].map((starter) => <button key={starter} type="button" className="starter" onClick={() => mirror.sendText(starter)}>{starter}</button>)}
          </div>
          {typed && <form className="type-form" onSubmit={submitQuestion}>
            <label htmlFor="question">Your question</label>
            <span className="type-row">
              <input ref={(element) => { firstControlRef.current = element; }} id="question" type="text" autoComplete="off" enterKeyHint="send" maxLength={1000}
                value={question} onChange={(event) => setQuestion(event.currentTarget.value)} />
              <button type="submit" className="button button-primary"><Icon name="send" />Send</button>
            </span>
          </form>}
        </section>
        <div className="glass controls-panel">
          {!typed && <button ref={(element) => { firstControlRef.current = element; }} type="button" className={`button ${mirror.muted ? "button-danger" : "button-secondary"}`} onClick={mirror.toggleMute}>
            <Icon name={mirror.muted ? "mic-off" : "mic"} />{mirror.muted ? "Unmute microphone" : "Mute microphone"}
          </button>}
          <button type="button" className="button button-secondary" onClick={finish}><Icon name="check" size={18} />Finish</button>
        </div>
      </div>}
    </main>
  </div>;
}
