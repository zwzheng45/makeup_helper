"use client";

import { useMirror, type MirrorPhase } from "../lib/client/use-mirror";
import { appPath } from "../lib/app-path";
import type { MirrorMode } from "../lib/contracts";

function Icon({ name, size = 20 }: { name: "mic" | "pause" | "play" | "stop" | "sound" | "arrow" | "camera" | "leaf"; size?: number }) {
  const paths = {
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" /></>,
    pause: <><path d="M8 5v14M16 5v14" strokeWidth="3" /></>,
    play: <path d="m9 5 11 7-11 7Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    sound: <><path d="m11 5-6 4H2v6h3l6 4ZM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    camera: <><path d="m8 6 2-3h4l2 3h4v14H4V6Z" /><circle cx="12" cy="12" r="3" /></>,
    leaf: <><path d="M12 21V10m0 6C4 16 3 9 4 4c7 0 10 5 8 12Zm0-4C12 5 17 3 21 3c1 6-2 11-9 11" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const phaseText: Record<MirrorPhase, string> = {
  idle: "Ready when you are", starting: "Getting your mirror ready", listening: "I'm listening", hearing: "Take your time. I'm listening",
  thinking: "Taking a closer look", speaking: "A little guidance", paused: "A moment to yourself", error: "Let's get you reconnected",
};

const modes: { value: MirrorMode; label: string; description: string }[] = [
  { value: "general", label: "General conversation", description: "Ask about your everyday routine." },
  { value: "guided", label: "Guided makeup", description: "Build this look, one step at a time." },
  { value: "compare", label: "Compare with reference", description: "Ask how your makeup compares." },
];

export default function MirrorPage() {
  const mirror = useMirror();
  const busy = mirror.phase === "starting";
  const running = mirror.active || busy;
  const lastReply = [...mirror.history].reverse().find((turn) => turn.assistant)?.assistant;
  const buttonLabel = mirror.phase === "paused" ? "Resume mirror" : mirror.audioError ? "Reconnect audio" : "Start mirror";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#mirror-controls">Skip to mirror controls</a>
      <header className="site-header">
        <a className="wordmark" href={appPath("/")} aria-label="Mirror home"><span className="brand-symbol" aria-hidden="true"><span /><span /></span>mirror<span className="wordmark-dot">.</span></a>
        <span className="header-note"><span className={`status-dot ${mirror.active ? "is-on" : ""}`} aria-hidden="true" />{running ? "Your session" : "A space for you"}</span>
      </header>

      <main id="main-content">
        <div className="page-heading">
          <div><p className="eyebrow">YOUR EVERYDAY CARE COMPANION</p><h1>A fresh perspective.</h1></div>
          <p className="heading-description">A little help with your everyday routine.<br />{" "}{mirror.active ? "Just ask. Your mirror is listening." : "Start your mirror. Then just ask."}</p>
        </div>

        <section className="reference-panel" aria-labelledby="reference-heading">
          <div className="reference-intro">
            <p className="eyebrow">A LOOK YOU HAVE IN MIND</p>
            <h2 id="reference-heading">Your inspiration, your pace.</h2>
            <p>Add a makeup photo to follow a look or compare your progress. It stays in this session until you remove it or end.</p>
          </div>
          <div className="reference-picker">
            {mirror.reference && <img className="reference-preview" src={mirror.reference.previewUrl} alt="Reference makeup look" />}
            <div className="reference-picker-details">
              {mirror.reference && <p className="reference-filename">{mirror.reference.name}</p>}
              <label className="button reference-upload">
                <Icon name="camera" size={18} />{mirror.reference ? "Replace reference" : "Upload reference"}
                <input id="reference-image" className="reference-file-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Reference makeup image" aria-describedby="reference-file-help"
                  onClick={mirror.prepareReferenceSelection}
                  onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void mirror.selectReference(file); }} />
              </label>
              <p id="reference-file-help" className="reference-help">One JPEG, PNG, or WebP, up to 10 MiB.</p>
              {(mirror.reference || mirror.referenceLoading) && <button className="button button-quiet reference-remove" onClick={() => { mirror.removeReference(); document.getElementById("reference-image")?.focus(); }}>Remove reference</button>}
              <p className="reference-status" role="status" aria-atomic="true">{mirror.referenceLoading ? "Preparing your reference image…" : mirror.reference ? `Reference ready: ${mirror.reference.name}` : ""}</p>
              {mirror.referenceError && <p className="reference-error" role="alert">{mirror.referenceError}</p>}
            </div>
          </div>
          <fieldset className="mode-picker" aria-describedby="mode-help">
            <legend>Mirror mode</legend>
            <div className="mode-options">{modes.map((option) => <label key={option.value} className={`mode-option ${mirror.mode === option.value ? "is-selected" : ""}`}>
              <input type="radio" name="mirror-mode" value={option.value} checked={mirror.mode === option.value} aria-label={option.label} aria-describedby={`mode-${option.value}-help`}
                disabled={mirror.referenceLoading || (option.value !== "general" && !mirror.reference)} onChange={() => mirror.setMode(option.value)} />
              <span><strong>{option.label}</strong><span id={`mode-${option.value}-help`}>{option.description}</span></span>
            </label>)}</div>
            <p id="mode-help" className="reference-help">{mirror.reference ? "Switching modes pauses the mirror. Resume when you're ready; your guided step is kept." : "Add a reference image to unlock guided makeup and comparison. General conversation is always available."}</p>
          </fieldset>
        </section>

        <div className="mirror-grid">
          <section className="mirror-panel" aria-label="Camera mirror">
            <div className="mirror-stage">
              <video ref={mirror.videoRef} className={`camera-preview ${mirror.cameraReady ? "is-visible" : ""}`} autoPlay muted playsInline aria-hidden="true" />
              <div className="mirror-topline" aria-hidden="true"><span className="view-label"><span className={`status-dot ${mirror.cameraReady ? "is-on" : ""}`} />{mirror.cameraReady ? "LIVE MIRROR" : "YOUR MIRROR"}</span><span className="view-corner">01 / YOU</span></div>
              {!mirror.cameraReady && <div className="mirror-placeholder">
                <div className="reflection-art" aria-hidden="true"><div className="reflection-outline"><span className="face-line" /><span className="shoulder-line" /></div><span className="reflection-glint glint-one" /><span className="reflection-glint glint-two" /></div>
                <h2>{mirror.phase === "paused" ? "Room for a pause." : busy ? "One moment, please." : "Come as you are."}</h2>
                <p>{mirror.phase === "paused" ? "Your camera and microphone are off." : busy ? "Connecting your camera and microphone." : "Your camera view will appear here."}</p>
              </div>}
              {mirror.cameraReady && <div className="live-hint" aria-hidden="true"><Icon name="camera" size={15} />A mirror for you. A clear view for your companion.</div>}
            </div>
            <div className="mirror-caption"><span className="caption-mark" aria-hidden="true">↳</span><p>{running ? "Set your device somewhere steady, with your face in view." : "Find a comfortable spot. Face the camera. Make yourself at home."}</p></div>
          </section>

          <section className="conversation-panel" aria-label="Voice companion">
            <div className="companion-topline"><span className="eyebrow">HERE WITH YOU</span><span className="companion-badge"><Icon name="leaf" size={15} />Mirror</span></div>
            <div className={`voice-orb ${mirror.phase === "speaking" || mirror.phase === "hearing" ? "is-speaking" : ""}`} aria-hidden="true"><span /><span /><span /><span /><span /></div>
            <div className="conversation-heading"><h2>{phaseText[mirror.phase]}</h2><p>{mirror.phase === "idle" || mirror.phase === "error" ? "Start your mirror, then speak naturally. No menus, no perfect words needed." : mirror.phase === "paused" ? "When you're ready, resume your mirror to keep talking." : busy ? "Your browser may ask to use your camera and microphone." : "You can ask a question, interrupt, or simply take your time."}</p></div>

            <div id="mirror-controls" className="mirror-controls" tabIndex={-1}>
              {mirror.active ? <button className="button button-primary" onClick={mirror.pause}><Icon name="pause" />Pause mirror</button> : <button className="button button-primary" onClick={() => void mirror.start()} disabled={busy || mirror.referenceLoading}><Icon name={mirror.phase === "paused" ? "play" : "mic"} />{busy ? "Starting mirror…" : buttonLabel}{!busy && <span className="button-arrow"><Icon name="arrow" size={18} /></span>}</button>}
              {running || mirror.phase === "paused" || mirror.history.length > 0 || mirror.reference || mirror.referenceLoading ? <div className="secondary-controls"><button className="button button-quiet" onClick={mirror.stopTalking} disabled={!mirror.active || (mirror.phase !== "speaking" && mirror.phase !== "thinking")}><Icon name="sound" size={17} />Stop talking</button><button className="button button-quiet" onClick={mirror.end}><Icon name="stop" size={16} />End session</button></div> : <p className="permission-hint"><Icon name="camera" size={14} />Camera &amp; microphone permission needed</p>}
            </div>

            <div className={`notice ${mirror.notice ? "has-notice" : ""}`} role="status" aria-atomic="true">{mirror.notice}</div>

            <div className="conversation-divider" />
            {mirror.mode === "guided" && mirror.guidanceContext && <section className="guidance-step" aria-labelledby="guidance-step-heading" aria-live="off">
              <h3 id="guidance-step-heading">{mirror.guidanceContext.complete ? "Look complete" : "Your makeup step"}</h3>
              {mirror.guidanceContext.goal && <p className="guidance-goal">{mirror.guidanceContext.goal}</p>}
              <p>{mirror.guidanceContext.currentStep}</p>
              {!mirror.guidanceContext.complete && <p className="reference-help">{mirror.guidanceContext.currentStep ? "Say “Done” or “Next step” when you're ready to continue. You can ask a question at any time." : "Tell Mirror which part of the look you'd like to try and what products you have."}</p>}
            </section>}
            {lastReply ? <div className="latest-reply" aria-live="off"><span className="eyebrow">YOUR LAST REPLY</span><p>“{lastReply}”</p></div> : <div className="conversation-starters"><span className="eyebrow">A CONVERSATION CAN START WITH…</span><p>“How does my hair look?”</p><p>“Can you help me with my makeup?”</p><p>“Have I missed a spot?”</p></div>}
            <p className="companion-footnote">Everyday guidance, at your pace.</p>
          </section>
        </div>

        <div className="below-mirror">
          <div className="privacy-note"><span className="privacy-symbol" aria-hidden="true"><svg width="19" height="21" viewBox="0 0 20 22" fill="none"><path d="m10 2 7 3v6c0 4-4 7-7 9-3-2-7-5-7-9V5l7-3Z" stroke="currentColor" strokeWidth="1.4" /><path d="m7 10 2 2 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></span><p>Mirror sends your voice and available camera snapshots to our Gemini service provider. Reference modes also send your selected makeup photo. Mirror does not save recordings or images on its server. Your reference, conversation, and progress are kept in this page until you end or reload. <span>Pause or end your session to switch the camera and microphone off.</span></p></div>
          <span className="small-signoff" aria-hidden="true">A little clarity.<br />A little more you.</span>
        </div>

        {mirror.history.length > 0 && <details className="transcript"><summary>Conversation transcript <span>{mirror.history.length} {mirror.history.length === 1 ? "exchange" : "exchanges"}</span></summary><ol aria-live="off">{mirror.history.map((turn) => <li key={turn.id}>{turn.user && <div><span className="transcript-speaker">You</span><p>{turn.user}</p></div>}{turn.assistant && <div><span className="transcript-speaker">Mirror{turn.interrupted ? " · interrupted" : ""}</span><p>{turn.assistant}</p></div>}</li>)}</ol></details>}
      </main>
      <footer className="site-footer"><span>Made for your everyday.</span><span>Listen. Look. Feel like yourself.</span></footer>
    </div>
  );
}
