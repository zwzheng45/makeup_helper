"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError, GuidanceContext, HistoryTurn, MirrorMode, TurnEvent, TurnRequest, TurnResponse } from "../contracts";
import { bytesToBase64, captureFrame, encodeWav, stopMedia } from "./media";
import { createMirrorVad } from "./vad";
import { CaptureSession } from "./session";
import { appPath } from "../app-path";
import { prepareReferenceImage, type PreparedReference } from "./reference-image";
import { Pcm16Decoder, PcmPlayer, preparePcmPlayback } from "./pcm-player";
import { readTurnEvents, VoiceStreamTransportError } from "./turn-stream";
import { MirrorCues } from "./cues";
import { isSpeechRate } from "../contracts";

/** "stopped" means capture ended without the user choosing to end (page hidden, device lost, error). */
export type MirrorPhase = "idle" | "starting" | "listening" | "hearing" | "thinking" | "speaking" | "stopped" | "error";
export interface ConversationTurn extends HistoryTurn { id: number }
export type InputMode = "voice" | "text";

export interface MirrorOptions {
  /** "text" never requests the microphone: questions are typed. */
  inputMode?: InputMode;
  /** When false, replies are shown but never synthesized or played. */
  readAloud?: boolean;
  /** Kokoro speaking speed, sent with each turn. */
  speechRate?: number;
}

export const MODE_LABELS: Record<MirrorMode, string> = {
  general: "Ask anything",
  guided: "Step-by-step guide",
  compare: "Quick check",
};
interface SpokenSegment { text: string; started: boolean; completed: boolean; samples: number; ended: boolean; decoder: Pcm16Decoder }
interface StreamingReply { id: number; mode: MirrorMode; transcript: string; segments: Map<number, SpokenSegment>; done: boolean; complete: boolean }

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
  const playerRef = useRef<PcmPlayer | null>(null);
  const replyRef = useRef<StreamingReply | null>(null);
  const cuesRef = useRef<MirrorCues | null>(null);
  const turnRef = useRef(0);
  const generationRef = useRef(0);
  const playbackRef = useRef(0);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const phaseRef = useRef<MirrorPhase>("idle");
  const mutedRef = useRef(false);
  /** Input and playback choices are fixed when a session starts. */
  const sessionOptionsRef = useRef({ typed: false, readAloud: true });
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

  function saveSpokenHistory(reply: StreamingReply) {
    const spoken = [...reply.segments.values()].filter((segment) => segment.started).map((segment) => segment.text).join(" ");
    if (!reply.transcript && !spoken) return;
    const history = historiesRef.current[reply.mode];
    const turn = { id: reply.id, user: reply.transcript, assistant: spoken, interrupted: !reply.complete };
    saveHistory(history.some((entry) => entry.id === reply.id) ? history.map((entry) => entry.id === reply.id ? turn : entry) : [...history, turn], reply.mode);
  }

  function cancelReply(markInterrupted = true) {
    cuesRef.current?.stop();
    generationRef.current++;
    requestRef.current?.abort();
    requestRef.current = null;
    playbackRef.current++;
    if (markInterrupted && replyRef.current && !replyRef.current.complete) saveSpokenHistory(replyRef.current);
    replyRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
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
    cuesRef.current = null;
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
    transition("stopped");
    setAudioError(true);
    setNotice(`${message} Mirror stopped. Select Reconnect audio and ask your question again.`);
  }

  /** A spoken "pause" mutes the microphone; there is no paused state the user has to resume from. */
  function muteFromSpeech() {
    if (!sessionOptionsRef.current.typed) setMuted(true);
    if (activeRef.current) transition("listening");
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
    const spoken = sessionOptionsRef.current.readAloud;
    const speechRate = optionsRef.current.speechRate ?? 1;
    cancelReply();
    const generation = generationRef.current;
    const playback = ++playbackRef.current;
    const current = () => activeRef.current && sessionId === sessionIdRef.current && generation === generationRef.current
      && playback === playbackRef.current && requestMode === modeRef.current && (requestMode === "general" || requestReference === referenceRef.current);
    const turnId = ++turnRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    const reply: StreamingReply = { id: turnId, mode: requestMode, transcript: "", segments: new Map(), done: false, complete: false };
    replyRef.current = reply;
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
      ...(spoken && isSpeechRate(speechRate) && speechRate !== 1 ? { speechRate } : {}),
    };
    transition("thinking");
    cuesRef.current?.processing();
    let timedOut = false;
    let responseReceived = false;
    let metaReceived = false;
    let requestFailure = false;
    let timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
    let totalDeadline: ReturnType<typeof setTimeout> | undefined;
    const waitForNextEvent = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    };
    try {
      const response = await fetch(appPath("/api/turn"), {
        method: "POST",
        // Without the stream header the server answers in JSON and never synthesizes speech.
        headers: { "Content-Type": "application/json", ...(spoken ? { Accept: "application/x-ndjson" } : {}) },
        body: JSON.stringify(body), signal: controller.signal,
      });
      responseReceived = true;
      if (!current()) return;
      if (!response.ok) {
        requestFailure = true;
        const error = await response.json().catch(() => null) as ApiError | null;
        throw new Error(error?.error?.message ?? "Mirror could not answer just now. Please try asking again.");
      }
      if (!spoken) {
        const result = await response.json() as TurnResponse;
        if (!current() || result.turnId !== turnId) return;
        clearTimeout(timeout);
        cuesRef.current?.stop();
        replyRef.current = null;
        requestRef.current = null;
        if (result.transcript || result.reply) {
          saveHistory([...historiesRef.current[requestMode], { id: turnId, user: result.transcript, assistant: result.reply }], requestMode);
        }
        if (result.action === "end") { end(); return; }
        if (result.action === "stop") { stopTalking(); return; }
        if (result.action === "pause") { muteFromSpeech(); return; }
        if (result.reply.trim() && (opening || result.transcript.trim())) {
          pendingOpeningRef.current = false;
          if (requestMode === "guided" && result.guidanceContext) saveGuidanceContext({ ...result.guidanceContext });
        }
        transition("listening");
        return;
      }
      if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) throw new Error("The assistant did not provide a voice stream.");
      let meta: Extract<TurnEvent, { type: "meta" }> | undefined;
      let final: Extract<TurnEvent, { type: "done" }> | undefined;
      let lastTextId: number | undefined;
      let lastAudioId: number | undefined;
      let textLength = 0;
      for await (const event of readTurnEvents(response.body, turnId)) {
        if (!current()) return;
        waitForNextEvent();
        if (event.type === "error") {
          if (!metaReceived) requestFailure = true;
          throw new Error(event.error.message);
        }
        if (event.type === "meta") {
          metaReceived = true;
          meta = event;
          reply.transcript = event.transcript;
          saveSpokenHistory(reply);
          totalDeadline = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
          if (event.action === "pause") {
            // No speech is synthesized for a pause; the status region announces the mute instead.
            reply.complete = true;
            saveSpokenHistory(reply);
            cancelReply(false);
            muteFromSpeech();
            return;
          }
          if (event.action === "end") { end(); return; }
          if (event.action === "stop") { stopTalking(); return; }
          continue;
        }
        if (!meta) throw new Error("The voice stream was missing its metadata.");
        if (event.type === "text") {
          if ((!opening && !meta.transcript.trim()) || event.segmentId !== (lastTextId === undefined ? 0 : lastTextId + 1)) throw new Error("The voice stream contained an unexpected sentence.");
          textLength += event.text.length;
          if (textLength > 1000 || reply.segments.has(event.segmentId)) throw new Error("The voice reply was too long or repeated a sentence.");
          lastTextId = event.segmentId;
          reply.segments.set(event.segmentId, { text: event.text, started: false, completed: false, samples: 0, ended: false, decoder: new Pcm16Decoder() });
        } else if (event.type === "audio") {
          const segment = reply.segments.get(event.segmentId);
          if (!segment || segment.ended || (!event.data && !event.end)) throw new Error("The voice stream contained unexpected audio.");
          if (lastAudioId === undefined) {
            if (event.segmentId !== reply.segments.keys().next().value) throw new Error("Audio sentences arrived out of order.");
          } else if (event.segmentId !== lastAudioId && (event.segmentId !== lastAudioId + 1 || !reply.segments.get(lastAudioId)?.ended)) {
            throw new Error("Audio sentences arrived out of order.");
          }
          lastAudioId = event.segmentId;
          const samples = segment.decoder.decode(event.data, event.end);
          segment.samples += samples.length;
          segment.ended = Boolean(event.end);
          if (segment.ended && segment.samples === 0) throw new Error("The assistant returned an empty audio sentence.");
          if (!playerRef.current) {
            const context = sessionRef.current?.context;
            if (!context || context.state !== "running") throw new Error("Audio is paused on your device.");
            playerRef.current = new PcmPlayer(context, playback, {
              started: (id) => {
                if (!current()) return;
                const spoken = reply.segments.get(id);
                if (!spoken) { failAudio("The voice stream could not be played."); return; }
                spoken.started = true;
                cuesRef.current?.stop();
                pendingOpeningRef.current = false;
                saveSpokenHistory(reply);
                transition("speaking");
              },
              completed: (id) => {
                if (!current()) return;
                const spoken = reply.segments.get(id);
                if (spoken) spoken.completed = true;
              },
              error: (error) => { if (current()) failAudio(error.message); },
            });
          }
          await playerRef.current.append(event.segmentId, samples, Boolean(event.end), controller.signal);
        } else if (event.type === "done") {
          const result = event.response;
          const expectedText = [...reply.segments.values()].map((segment) => segment.text).join(" ");
          const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
          if (result.transcript !== meta.transcript || result.action !== meta.action
            || JSON.stringify(result.guidanceContext) !== JSON.stringify(meta.guidanceContext)
            || normalize(result.reply) !== normalize(expectedText)
            || [...reply.segments.values()].some((segment) => !segment.ended || !segment.samples)) {
            throw new Error("The completed voice reply did not match its stream.");
          }
          final = event;
        }
      }
      if (!current()) return;
      if (!final) throw new Error("The voice stream ended before the reply was complete.");
      clearTimeout(timeout);
      clearTimeout(totalDeadline);
      const result = final.response;
      reply.done = true;
      if (result.reply.trim() && (opening || result.transcript.trim())) {
        pendingOpeningRef.current = false;
        if (requestMode === "guided" && result.guidanceContext) saveGuidanceContext({ ...result.guidanceContext });
      }
      const player = playerRef.current;
      if (player) await player.finish();
      if (!current()) return;
      if ([...reply.segments.values()].some((segment) => !segment.completed)) throw new Error("Not all audio sentences finished playing.");
      reply.complete = true;
      cuesRef.current?.stop();
      saveSpokenHistory(reply);
      player?.stop();
      playerRef.current = null;
      replyRef.current = null;
      requestRef.current = null;
      transition("listening");
    } catch (error) {
      if (!current()) return;
      if (controller.signal.aborted && !timedOut) return;
      const message = error instanceof Error && !["ZodError", "SyntaxError"].includes(error.name) ? error.message : "The voice stream could not be read.";
      if (requestFailure || !responseReceived || (!metaReceived && (timedOut || error instanceof VoiceStreamTransportError))) {
        cancelReply();
        setNotice(timedOut ? "The assistant took too long. Please try asking again." : message);
        transition("listening");
      } else failAudio(timedOut ? "The voice reply took too long." : message);
    } finally {
      clearTimeout(timeout);
      clearTimeout(totalDeadline);
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
    const typed = optionsRef.current.inputMode === "text";
    const spoken = optionsRef.current.readAloud !== false;
    sessionOptionsRef.current = { typed, readAloud: spoken };
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
      // A typed session with replies on screen only never needs audio at all.
      const context = typed && !spoken ? null : new AudioContext();
      const session = new CaptureSession(sessionId, context);
      sessionRef.current = session;
      if (context) {
        cuesRef.current = new MirrorCues(context);
        void context.resume().catch(() => { /* A user gesture will be required on retry. */ });
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
      if (context && spoken) {
        stage = "audio";
        await preparePcmPlayback(context);
        if (!current()) return;
      }
      if (context && !typed) {
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
            if (listening()) cuesRef.current?.captured();
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
      setAudioError(stage === "audio" && spoken);
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
