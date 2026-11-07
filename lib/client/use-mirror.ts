"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError, GuidanceContext, HistoryTurn, MirrorMode, TurnRequest, TurnResponse } from "../contracts";
import { bytesToBase64, captureFrame, encodeWav, englishVoice, stopMedia } from "./media";
import { createMirrorVad } from "./vad";
import { CaptureSession } from "./session";
import { appPath } from "../app-path";
import { prepareReferenceImage, type PreparedReference } from "./reference-image";

/** "stopped" means capture ended without the user choosing to end (page hidden, device lost, error). */
export type MirrorPhase = "idle" | "starting" | "listening" | "hearing" | "thinking" | "speaking" | "stopped" | "error";
export interface ConversationTurn extends HistoryTurn { id: number }
export type InputMode = "voice" | "text";

export interface MirrorOptions {
  /** "text" never requests the microphone: questions are typed. */
  inputMode?: InputMode;
  readAloud?: boolean;
  speechRate?: number;
}

export const MODE_LABELS: Record<MirrorMode, string> = {
  general: "Ask anything",
  guided: "Step-by-step guide",
  compare: "Quick check",
};

function emptyHistories(): Record<MirrorMode, ConversationTurn[]> {
  return { general: [], guided: [], compare: [] };
}

function releaseReferencePreview(reference: PreparedReference | null) {
  if (reference?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(reference.previewUrl);
}

export function useMirror(options: MirrorOptions = {}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<CaptureSession | null>(null);
  const sessionIdRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const turnRef = useRef(0);
  const generationRef = useRef(0);
  const playbackRef = useRef(0);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const phaseRef = useRef<MirrorPhase>("idle");
  const mutedRef = useRef(false);
  const textSessionRef = useRef(false);
  const modeRef = useRef<MirrorMode>("general");
  const referenceRef = useRef<PreparedReference | null>(null);
  const referenceVersionRef = useRef(0);
  const referenceLoadingRef = useRef(false);
  const guidanceContextRef = useRef<GuidanceContext | undefined>(undefined);
  const historiesRef = useRef<Record<MirrorMode, ConversationTurn[]>>(emptyHistories());
  const historyRef = useRef<ConversationTurn[]>([]);
  const pendingOpeningRef = useRef(false);
  const lastFrameRef = useRef(0);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<MirrorPhase>("idle");
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [notice, setNotice] = useState("");
  const [audioError, setAudioError] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [muted, updateMuted] = useState(false);
  const [mode, updateMode] = useState<MirrorMode>("general");
  const [reference, updateReference] = useState<PreparedReference | null>(null);
  const [referenceLoading, updateReferenceLoading] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const [guidanceContext, updateGuidanceContext] = useState<GuidanceContext | undefined>(undefined);

  const textMode = () => optionsRef.current.inputMode === "text";
  const readAloud = () => optionsRef.current.readAloud !== false;

  function transition(next: MirrorPhase) {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  }

  function saveHistory(next: ConversationTurn[], targetMode = modeRef.current) {
    historiesRef.current[targetMode] = next.slice(-10);
    if (targetMode === modeRef.current) {
      historyRef.current = historiesRef.current[targetMode];
      if (mountedRef.current) setHistory(historyRef.current);
    }
  }

  function saveGuidanceContext(context: GuidanceContext | undefined) {
    guidanceContextRef.current = context;
    if (mountedRef.current) updateGuidanceContext(context);
  }

  function changeVisibleMode(nextMode: MirrorMode) {
    modeRef.current = nextMode;
    historyRef.current = historiesRef.current[nextMode];
    if (mountedRef.current) {
      updateMode(nextMode);
      setHistory(historyRef.current);
    }
  }

  function clearReferenceConversations() {
    saveHistory([], "guided");
    saveHistory([], "compare");
    saveGuidanceContext(undefined);
  }

  function setReferenceLoading(loading: boolean) {
    referenceLoadingRef.current = loading;
    if (mountedRef.current) updateReferenceLoading(loading);
  }

  function clearSpeechTimer() {
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    speechTimerRef.current = null;
  }

  /** Mute keeps the camera running but sends silence to the voice detector, so nothing is heard or sent. */
  function applyMute() {
    sessionRef.current?.stream?.getAudioTracks().forEach((track) => { track.enabled = !mutedRef.current; });
  }

  function setMuted(next: boolean, announce = true) {
    mutedRef.current = next;
    if (mountedRef.current) updateMuted(next);
    applyMute();
    if (next) {
      clearSpeechTimer();
      if (phaseRef.current === "hearing") transition("listening");
    }
    if (announce) setNotice(next ? "Microphone muted. Mirror can't hear you." : "Microphone on. Mirror is listening.");
  }

  function cancelReply(markInterrupted = true) {
    generationRef.current++;
    requestRef.current?.abort();
    requestRef.current = null;
    playbackRef.current++;
    if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
    if (markInterrupted && utteranceRef.current && historyRef.current.length) {
      saveHistory(historyRef.current.map((entry, index, entries) => index === entries.length - 1 ? { ...entry, interrupted: true } : entry));
    }
    utteranceRef.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  function releaseResources() {
    sessionIdRef.current++;
    activeRef.current = false;
    cancelReply();
    clearSpeechTimer();
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    frameTimerRef.current = null;
    lastFrameRef.current = 0;
    if (videoRef.current) videoRef.current.srcObject = null;
    const session = sessionRef.current;
    sessionRef.current = null;
    void session?.dispose();
    if (mountedRef.current) setCameraReady(false);
  }

  /** Releases the camera and microphone for reasons outside the user's control. Start mirror reconnects. */
  function stopCapture(message: string) {
    releaseResources();
    transition("stopped");
    setNotice(message);
  }

  function end() {
    releaseResources();
    referenceVersionRef.current++;
    releaseReferencePreview(referenceRef.current);
    referenceRef.current = null;
    updateReference(null);
    setReferenceLoading(false);
    setReferenceError("");
    historiesRef.current = emptyHistories();
    changeVisibleMode("general");
    saveGuidanceContext(undefined);
    pendingOpeningRef.current = false;
    mutedRef.current = false;
    if (mountedRef.current) updateMuted(false);
    transition("idle");
    setAudioError(false);
    setNotice("Session ended. Camera and microphone are off.");
  }

  /** Sends an opening for the current mode when the mirror is running; otherwise Start will. */
  function openCurrentMode() {
    pendingOpeningRef.current = true;
    if (activeRef.current) {
      transition("listening");
      void submitTurn(undefined, true);
    }
  }

  function prepareReferenceSelection() {
    // Invalidate any decode in progress. Capture keeps running; if the picker hides the page, the visibility handler stops it.
    referenceVersionRef.current++;
    setReferenceLoading(false);
    setReferenceError("");
  }

  async function selectReference(file: File | undefined) {
    const selectionVersion = ++referenceVersionRef.current;
    setReferenceError("");
    if (!file) { setReferenceLoading(false); return; }
    setReferenceLoading(true);
    try {
      const prepared = await prepareReferenceImage(file);
      if (!mountedRef.current || selectionVersion !== referenceVersionRef.current) {
        releaseReferencePreview(prepared);
        return;
      }
      const previousReference = referenceRef.current;
      referenceRef.current = prepared;
      updateReference(prepared);
      clearReferenceConversations();
      releaseReferencePreview(previousReference);
      setNotice(modeRef.current === "general"
        ? `Photo added. Choose ${MODE_LABELS.guided} or ${MODE_LABELS.compare} to use it.`
        : "Photo changed. Starting again with the new photo.");
      // Answers about the old photo are rejected by submitTurn's reference check.
      if (modeRef.current !== "general") {
        cancelReply();
        openCurrentMode();
      }
    } catch (error) {
      if (mountedRef.current && selectionVersion === referenceVersionRef.current) {
        setReferenceError(error instanceof Error ? error.message : "This photo could not be prepared. Please choose another image.");
      }
    } finally {
      if (mountedRef.current && selectionVersion === referenceVersionRef.current) setReferenceLoading(false);
    }
  }

  function removeReference() {
    referenceVersionRef.current++;
    setReferenceLoading(false);
    setReferenceError("");
    const previousMode = modeRef.current;
    if (previousMode !== "general") cancelReply();
    releaseReferencePreview(referenceRef.current);
    referenceRef.current = null;
    updateReference(null);
    clearReferenceConversations();
    changeVisibleMode("general");
    if (previousMode !== "general") {
      setNotice(`Photo removed. Mode: ${MODE_LABELS.general}.`);
      if (activeRef.current) transition("listening");
      else pendingOpeningRef.current = true;
    } else setNotice("Photo removed.");
  }

  function setMode(nextMode: MirrorMode) {
    if (nextMode === modeRef.current || referenceLoadingRef.current) return;
    if (nextMode !== "general" && !referenceRef.current) {
      setReferenceError("Add a photo of the look before choosing this mode.");
      return;
    }
    // Discard anything in flight for the old mode, then switch without turning the camera off.
    cancelReply();
    clearSpeechTimer();
    changeVisibleMode(nextMode);
    setReferenceError("");
    setNotice(`Mode: ${MODE_LABELS[nextMode]}.`);
    openCurrentMode();
  }

  function stopTalking() {
    cancelReply();
    if (activeRef.current) transition("listening");
  }

  function failAudio(message: string) {
    releaseResources();
    transition("error");
    setAudioError(true);
    setNotice(message);
  }

  /** Returns false when the reply is shown but not spoken. */
  function speak(text: string): boolean {
    if (!activeRef.current || !readAloud() || !voiceRef.current || !text.trim()) return false;
    const playback = ++playbackRef.current;
    const sessionId = sessionIdRef.current;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voiceRef.current;
    utterance.lang = "en-GB";
    utterance.rate = optionsRef.current.speechRate ?? 1;
    utteranceRef.current = utterance;
    const current = () => activeRef.current && sessionId === sessionIdRef.current && playback === playbackRef.current;
    utterance.onstart = () => {
      if (!current()) return;
      if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
      transition("speaking");
    };
    utterance.onend = () => {
      if (!current()) return;
      if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
      utteranceRef.current = null;
      transition("listening");
    };
    utterance.onerror = (event) => {
      if (!current() || event.error === "interrupted" || event.error === "canceled") return;
      failAudio("Your device could not play the reply. Check sound and speech voices, then reconnect audio and ask your question again.");
    };
    speakingTimerRef.current = setTimeout(() => {
      if (current()) failAudio("Spoken replies did not start. Check your device's sound settings, then reconnect audio and ask your question again.");
    }, 7000);
    transition("speaking");
    window.speechSynthesis.speak(utterance);
    return true;
  }

  async function submitTurn(audio?: Float32Array, opening = false, text?: string) {
    if (!activeRef.current) return;
    const sessionId = sessionIdRef.current;
    const requestMode = modeRef.current;
    const requestReference = requestMode === "general" ? null : referenceRef.current;
    if (requestMode !== "general" && !requestReference) {
      setReferenceError("Add a photo of the look before using this mode.");
      return;
    }
    cancelReply();
    const generation = generationRef.current;
    const current = () => activeRef.current && sessionId === sessionIdRef.current && generation === generationRef.current
      && requestMode === modeRef.current && (requestMode === "general" || requestReference === referenceRef.current);
    const turnId = ++turnRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    const video = videoRef.current;
    let frame;
    try { frame = video ? captureFrame(video, lastFrameRef.current) : undefined; } catch { frame = undefined; }
    setCameraReady(Boolean(frame));
    setNotice(frame ? "" : "The current camera view is unavailable. Mirror can answer, but cannot check your appearance right now.");
    const body: TurnRequest = {
      turnId,
      mode: requestMode,
      history: historiesRef.current[requestMode].map(({ user, assistant, interrupted }) => ({ user, assistant, interrupted })),
      ...(requestReference ? { reference: { data: requestReference.data, mimeType: requestReference.mimeType } } : {}),
      ...(requestMode === "guided" && guidanceContextRef.current ? { guidanceContext: { ...guidanceContextRef.current } } : {}),
      ...(frame ? { frame } : {}),
      ...(opening ? { opening: true } : {}),
      ...(audio ? { audio: bytesToBase64(encodeWav(audio)) } : {}),
      ...(text && !opening ? { text } : {}),
    };
    transition("thinking");
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
    try {
      const response = await fetch(appPath("/api/turn"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!current()) return;
      if (!response.ok) {
        const error = await response.json().catch(() => null) as ApiError | null;
        throw new Error(error?.error?.message ?? "Mirror could not answer just now. Please try asking again.");
      }
      const result = await response.json() as TurnResponse;
      if (!current() || result.turnId !== turnId) return;
      requestRef.current = null;
      if (result.transcript || result.reply) {
        saveHistory([...historiesRef.current[requestMode], { id: turnId, user: result.transcript, assistant: result.reply }], requestMode);
      }
      if (result.action === "end") { end(); return; }
      if (result.action === "stop") { stopTalking(); return; }
      // A spoken "pause" mutes the microphone; there is no paused state the user has to resume from.
      if (result.action === "pause" && !textSessionRef.current) setMuted(true, false);
      if (result.action === "reply" && result.reply.trim() && (opening || result.transcript.trim())) {
        pendingOpeningRef.current = false;
        if (requestMode === "guided" && result.guidanceContext) saveGuidanceContext({ ...result.guidanceContext });
      }
      if (!speak(result.reply)) transition("listening");
    } catch (error) {
      if (!current()) return;
      if (controller.signal.aborted && !timedOut) return;
      setNotice(timedOut ? "The reply took too long. Please try asking again." : error instanceof Error ? error.message : "Connection interrupted. Please try asking again.");
      transition("listening");
    } finally {
      clearTimeout(timeout);
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  /** Sends a typed question or a tapped conversation starter. Returns false if it could not be sent. */
  function sendText(value: string): boolean {
    const text = value.trim().slice(0, 1_000);
    if (!activeRef.current) return false;
    if (!text) { setNotice("Type a question first, then select Send."); return false; }
    void submitTurn(undefined, false, text);
    return true;
  }

  async function start() {
    if (activeRef.current || phaseRef.current === "starting") return;
    if (referenceLoadingRef.current) {
      setNotice("Your photo is still being prepared. Start your mirror when it is ready.");
      return;
    }
    if (modeRef.current !== "general" && !referenceRef.current) {
      setReferenceError("Add a photo of the look before starting this mode.");
      return;
    }
    releaseResources();
    const sessionId = sessionIdRef.current;
    const typed = textMode();
    textSessionRef.current = typed;
    const devices = typed ? "camera" : "camera and microphone";
    const current = () => mountedRef.current && sessionId === sessionIdRef.current;
    const listening = () => current() && activeRef.current && !mutedRef.current;
    transition("starting");
    setNotice("");
    setAudioError(false);
    let stage: "audio" | "permission" | "vad" = "audio";
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error(`The ${devices} need a secure connection. Open Mirror on HTTPS, or localhost on this computer.`);
      }
      // Unlock audio synchronously in the button gesture, before awaiting permissions.
      const context = typed ? null : new AudioContext();
      const session = new CaptureSession(sessionId, context);
      sessionRef.current = session;
      if (context) void context.resume().catch(() => { /* A user gesture will be required on retry. */ });
      voiceRef.current = null;
      if (readAloud()) {
        if ("speechSynthesis" in window) {
          const unlock = new SpeechSynthesisUtterance("Starting Mirror.");
          unlock.lang = "en-GB";
          unlock.rate = optionsRef.current.speechRate ?? 1;
          window.speechSynthesis.speak(unlock);
        }
        const voice = await englishVoice();
        if (!current()) return;
        voiceRef.current = voice;
      }
      stage = "permission";
      const video = { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };
      const stream = await navigator.mediaDevices.getUserMedia(typed ? { video } : {
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video,
      });
      if (!current()) { stopMedia(stream); return; }
      if (!session.attachStream(stream)) return;
      applyMute();
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => {
          if (current()) stopCapture(`${typed ? "Camera" : "Camera or microphone"} access ended. Select Start mirror to reconnect.`);
        });
      }
      const videoElement = videoRef.current;
      if (videoElement) {
        videoElement.srcObject = stream;
        await videoElement.play();
        if (!current()) return;
        let previousTime = -1;
        const updateFrame = () => {
          if (!current()) return;
          if (videoElement.readyState >= 2 && !videoElement.paused && videoElement.currentTime !== previousTime) {
            previousTime = videoElement.currentTime;
            lastFrameRef.current = Date.now();
            if (mountedRef.current) setCameraReady(true);
          } else if (Date.now() - lastFrameRef.current > 2000 && mountedRef.current) setCameraReady(false);
        };
        updateFrame();
        frameTimerRef.current = setInterval(updateFrame, 250);
      }
      if (context) {
        stage = "vad";
        await session.initialize(() => createMirrorVad(stream, context, {
          onSpeechStart: () => {
            if (!listening()) return;
            clearSpeechTimer();
            // Flush at 29 seconds so the pre-roll remains below the 30-second cap.
            speechTimerRef.current = setTimeout(() => {
              const currentVad = session.vad;
              if (!listening() || !currentVad) return;
              void currentVad.pause().then(() => {
                if (listening() && session.vad === currentVad) return currentVad.start();
              }).catch(() => {
                if (current()) stopCapture("The voice listener was interrupted. Select Start mirror to continue.");
              });
            }, 29_000);
          },
          onSpeechRealStart: () => {
            if (!listening()) return;
            cancelReply();
            transition("hearing");
            setNotice("");
          },
          onSpeechEnd: (samples) => {
            if (!listening()) return;
            clearSpeechTimer();
            void submitTurn(samples);
          },
          onVADMisfire: () => { if (listening()) clearSpeechTimer(); },
        }));
        if (!current()) return;
      }
      activeRef.current = true;
      transition("listening");
      if (pendingOpeningRef.current || historyRef.current.length === 0) void submitTurn(undefined, true);
      else setNotice(typed ? "Mirror reconnected. Type your question when you're ready." : "Mirror reconnected. Ask your question again when you're ready.");
    } catch (error) {
      if (!current()) return;
      releaseResources();
      transition("error");
      setAudioError(stage === "audio" && readAloud());
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setNotice(`${typed ? "Camera" : "Camera or microphone"} permission was denied. Allow it in your browser's site settings, then start again.`);
      } else if (error instanceof DOMException && error.name === "NotFoundError") {
        setNotice(`No ${devices} was found. Connect ${typed ? "a camera" : "both devices"}, then start again.`);
      } else if (error instanceof DOMException && error.name === "NotReadableError") {
        setNotice(`Your ${devices} ${typed ? "is" : "are"} busy. Close other apps using ${typed ? "it" : "them"}, then start again.`);
      } else if (stage === "vad") {
        setNotice("The voice listener could not start. Check your connection, reload this page, and try again.");
      } else {
        setNotice(error instanceof Error ? error.message : "Mirror could not start. Please try again.");
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    // Capture never continues out of sight. Start mirror reconnects when the person returns.
    const visibility = () => {
      if (document.hidden && (activeRef.current || phaseRef.current === "starting")) {
        stopCapture("Mirror stopped while the page was in the background. Camera and microphone are off. Select Start mirror to continue.");
      }
    };
    const pagehide = () => {
      if (activeRef.current || phaseRef.current === "starting") {
        stopCapture("Mirror stopped while you were away. Camera and microphone are off. Select Start mirror to continue.");
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    return () => {
      mountedRef.current = false;
      referenceVersionRef.current++;
      releaseReferencePreview(referenceRef.current);
      referenceRef.current = null;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      releaseResources();
    };
    // Resource ownership is stable through refs; cleanup must run only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { videoRef, phase, history, notice, audioError, cameraReady, start, end, stopTalking,
    muted, toggleMute: () => setMuted(!mutedRef.current), sendText,
    reference, referenceLoading, referenceError, mode, guidanceContext,
    prepareReferenceSelection, selectReference, removeReference, setMode,
    active: ["listening", "hearing", "thinking", "speaking"].includes(phase) };
}
