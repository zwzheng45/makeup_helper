"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError, GuidanceContext, HistoryTurn, MirrorMode, TurnEvent, TurnRequest } from "../contracts";
import { bytesToBase64, captureFrame, encodeWav, stopMedia } from "./media";
import { createMirrorVad } from "./vad";
import { CaptureSession } from "./session";
import { appPath } from "../app-path";
import { prepareReferenceImage, type PreparedReference } from "./reference-image";
import { Pcm16Decoder, PcmPlayer, preparePcmPlayback } from "./pcm-player";
import { readTurnEvents, VoiceStreamTransportError } from "./turn-stream";
import { MirrorCues } from "./cues";

export type MirrorPhase = "idle" | "starting" | "listening" | "hearing" | "thinking" | "speaking" | "paused" | "error";
export interface ConversationTurn extends HistoryTurn { id: number }
interface SpokenSegment { text: string; started: boolean; completed: boolean; samples: number; ended: boolean; decoder: Pcm16Decoder }
interface StreamingReply { id: number; mode: MirrorMode; transcript: string; segments: Map<number, SpokenSegment>; done: boolean; complete: boolean }

function emptyHistories(): Record<MirrorMode, ConversationTurn[]> {
  return { general: [], guided: [], compare: [] };
}

function releaseReferencePreview(reference: PreparedReference | null) {
  if (reference?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(reference.previewUrl);
}

export function useMirror() {
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

  function pause(message = "Mirror paused. Camera and microphone are off. Use Resume mirror to continue.") {
    releaseResources();
    transition("paused");
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
    transition("idle");
    setAudioError(false);
    setNotice("Session ended. Camera and microphone are off.");
  }

  function prepareReferenceSelection() {
    // Run before opening the native picker, which may hide the page on mobile.
    referenceVersionRef.current++;
    setReferenceLoading(false);
    setReferenceError("");
    if (activeRef.current || phaseRef.current === "starting") {
      pause("Mirror paused while you choose a reference photo. Use Resume mirror when you're ready.");
    }
  }

  async function selectReference(file: File | undefined) {
    const selectionVersion = ++referenceVersionRef.current;
    setReferenceError("");
    if (!file) { setReferenceLoading(false); return; }
    if (activeRef.current || phaseRef.current === "starting") {
      pause("Mirror paused while your reference photo is prepared. Use Resume mirror when you're ready.");
    }
    setReferenceLoading(true);
    try {
      const prepared = await prepareReferenceImage(file);
      if (!mountedRef.current || selectionVersion !== referenceVersionRef.current) {
        releaseReferencePreview(prepared);
        return;
      }
      // Capture never restarts as a side effect of selecting or replacing a photo.
      if (activeRef.current || phaseRef.current === "starting") pause();
      const previousReference = referenceRef.current;
      referenceRef.current = prepared;
      updateReference(prepared);
      clearReferenceConversations();
      if (modeRef.current !== "general") pendingOpeningRef.current = true;
      releaseReferencePreview(previousReference);
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
    if (activeRef.current || phaseRef.current === "starting" || previousMode !== "general") {
      pause("Reference photo removed. Use Resume mirror to continue in General mode.");
    }
    releaseReferencePreview(referenceRef.current);
    referenceRef.current = null;
    updateReference(null);
    clearReferenceConversations();
    changeVisibleMode("general");
    if (previousMode !== "general") pendingOpeningRef.current = true;
  }

  function setMode(nextMode: MirrorMode) {
    if (nextMode === modeRef.current || referenceLoadingRef.current) return;
    if (nextMode !== "general" && !referenceRef.current) {
      setReferenceError("Add a reference photo before choosing this mode.");
      return;
    }
    // A choice made before starting does not create a paused capture session.
    if (phaseRef.current === "idle") {
      const label = nextMode === "general" ? "General conversation" : nextMode === "guided" ? "Guided makeup" : "Compare with reference";
      setNotice(`${label} selected. Start your mirror when ready.`);
    } else {
      // Invalidate the old mode before allowing any new audio or camera capture.
      pause("Mode changed. Camera and microphone are off. Use Resume mirror when you're ready.");
    }
    changeVisibleMode(nextMode);
    pendingOpeningRef.current = true;
    setReferenceError("");
  }

  function stopTalking() {
    cancelReply();
    if (activeRef.current) transition("listening");
  }

  function failAudio(message: string) {
    releaseResources();
    transition("paused");
    setAudioError(true);
    setNotice(`${message} Mirror is paused. Use Resume mirror and ask your question again.`);
  }

  async function submitTurn(audio?: Float32Array, opening = false) {
    if (!activeRef.current) return;
    const sessionId = sessionIdRef.current;
    const requestMode = modeRef.current;
    const requestReference = requestMode === "general" ? null : referenceRef.current;
    if (requestMode !== "general" && !requestReference) {
      pause("Add a reference photo before resuming this mode.");
      return;
    }
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
    setNotice(frame ? "" : "The current camera view is unavailable. Mirror can hear you, but cannot assess your appearance right now.");
    const body: TurnRequest = {
      turnId,
      mode: requestMode,
      history: historiesRef.current[requestMode].map(({ user, assistant, interrupted }) => ({ user, assistant, interrupted })),
      ...(requestReference ? { reference: { data: requestReference.data, mimeType: requestReference.mimeType } } : {}),
      ...(requestMode === "guided" && guidanceContextRef.current ? { guidanceContext: { ...guidanceContextRef.current } } : {}),
      ...(frame ? { frame } : {}),
      ...(opening ? { opening: true } : {}),
      ...(audio ? { audio: bytesToBase64(encodeWav(audio)) } : {}),
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
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      responseReceived = true;
      if (!current()) return;
      if (!response.ok) {
        requestFailure = true;
        const error = await response.json().catch(() => null) as ApiError | null;
        throw new Error(error?.error?.message ?? "Mirror could not answer just now. Please try asking again.");
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
          if (event.action === "pause") { pause(); return; }
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

  async function start() {
    if (activeRef.current || phaseRef.current === "starting") return;
    if (referenceLoadingRef.current) {
      setNotice("Your reference photo is still being prepared. Start your mirror when it is ready.");
      return;
    }
    if (modeRef.current !== "general" && !referenceRef.current) {
      setReferenceError("Add a reference photo before starting this mode.");
      return;
    }
    releaseResources();
    const sessionId = sessionIdRef.current;
    const sessionMode = modeRef.current;
    const current = () => mountedRef.current && sessionId === sessionIdRef.current && sessionMode === modeRef.current;
    const listening = () => current() && activeRef.current;
    transition("starting");
    setNotice("");
    setAudioError(false);
    let stage: "audio" | "permission" | "vad" = "audio";
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera and microphone access need a secure connection. Open Mirror on HTTPS, or localhost on this computer.");
      }
      // Unlock audio synchronously in the button gesture, before awaiting permissions.
      const context = new AudioContext();
      const session = new CaptureSession(sessionId, context);
      sessionRef.current = session;
      cuesRef.current = new MirrorCues(context);
      void context.resume().catch(() => { /* A user gesture will be required on retry. */ });
      stage = "permission";
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (!current()) { stopMedia(stream); return; }
      if (!session.attachStream(stream)) return;
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => {
          if (current()) pause("Camera or microphone access ended. Use Resume mirror to reconnect.");
        });
      }
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
        if (!current()) return;
        let previousTime = -1;
        const updateFrame = () => {
          if (!current()) return;
          if (video.readyState >= 2 && !video.paused && video.currentTime !== previousTime) {
            previousTime = video.currentTime;
            lastFrameRef.current = Date.now();
            if (mountedRef.current) setCameraReady(true);
          } else if (Date.now() - lastFrameRef.current > 2000 && mountedRef.current) setCameraReady(false);
        };
        updateFrame();
        frameTimerRef.current = setInterval(updateFrame, 250);
      }
      stage = "audio";
      await preparePcmPlayback(context);
      if (!current()) return;
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
              if (current()) pause("The voice listener was interrupted. Use Resume mirror to continue.");
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
      activeRef.current = true;
      transition("listening");
      if (pendingOpeningRef.current || historyRef.current.length === 0) void submitTurn(undefined, true);
      else setNotice("Mirror reconnected. Ask your question again when you're ready.");
    } catch (error) {
      if (!current()) return;
      releaseResources();
      transition("error");
      setAudioError(stage === "audio");
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setNotice("Camera or microphone permission was denied. Allow both in your browser's site permissions, then start again.");
      } else if (error instanceof DOMException && error.name === "NotFoundError") {
        setNotice("No camera or microphone was found. Connect both devices, then start again.");
      } else if (error instanceof DOMException && error.name === "NotReadableError") {
        setNotice("Your camera or microphone is busy. Close other apps using it, then start again.");
      } else if (stage === "vad") {
        setNotice("The voice listener could not start. Check your connection, reload this page, and try again.");
      } else {
        setNotice(error instanceof Error ? error.message : "Mirror could not start. Please try again.");
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const visibility = () => {
      if (document.hidden && (activeRef.current || phaseRef.current === "starting")) {
        pause("Mirror paused while the page was away. Camera and microphone are off. Use Resume mirror to continue.");
      }
    };
    const pagehide = () => {
      if (activeRef.current || phaseRef.current === "starting") {
        pause("Mirror paused while you were away. Camera and microphone are off. Use Resume mirror to continue.");
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

  return { videoRef, phase, history, notice, audioError, cameraReady, start, pause: () => pause(), end, stopTalking,
    reference, referenceLoading, referenceError, mode, guidanceContext,
    prepareReferenceSelection, selectReference, removeReference, setMode,
    active: ["listening", "hearing", "thinking", "speaking"].includes(phase) };
}
