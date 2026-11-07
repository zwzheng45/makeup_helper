"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError, HistoryTurn, TurnRequest, TurnResponse } from "../contracts";
import { bytesToBase64, captureFrame, encodeWav, englishVoice, stopMedia } from "./media";
import { createMirrorVad } from "./vad";
import { CaptureSession } from "./session";
import { appPath } from "../app-path";

export type MirrorPhase = "idle" | "starting" | "listening" | "hearing" | "thinking" | "speaking" | "paused" | "error";
export interface ConversationTurn extends HistoryTurn { id: number }

export function useMirror() {
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
  const historyRef = useRef<ConversationTurn[]>([]);
  const lastFrameRef = useRef(0);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<MirrorPhase>("idle");
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [notice, setNotice] = useState("");
  const [audioError, setAudioError] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);

  function transition(next: MirrorPhase) {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  }

  function saveHistory(next: ConversationTurn[]) {
    historyRef.current = next.slice(-10);
    if (mountedRef.current) setHistory(historyRef.current);
  }

  function clearSpeechTimer() {
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    speechTimerRef.current = null;
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

  function pause(message = "Mirror paused. Camera and microphone are off. Use Resume mirror to continue.") {
    releaseResources();
    transition("paused");
    setNotice(message);
  }

  function end() {
    releaseResources();
    saveHistory([]);
    transition("idle");
    setAudioError(false);
    setNotice("Session ended. Camera and microphone are off.");
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

  function speak(text: string) {
    if (!activeRef.current || !voiceRef.current || !text.trim()) return;
    const playback = ++playbackRef.current;
    const sessionId = sessionIdRef.current;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voiceRef.current;
    utterance.lang = "en-GB";
    utterance.rate = 1;
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
  }

  async function submitTurn(audio?: Float32Array, opening = false) {
    if (!activeRef.current) return;
    const sessionId = sessionIdRef.current;
    cancelReply();
    const generation = generationRef.current;
    const turnId = ++turnRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    const video = videoRef.current;
    let frame;
    try { frame = video ? captureFrame(video, lastFrameRef.current) : undefined; } catch { frame = undefined; }
    setCameraReady(Boolean(frame));
    setNotice(frame ? "" : "The current camera view is unavailable. Mirror can hear you, but cannot assess your appearance right now.");
    const body: TurnRequest = {
      turnId,
      history: historyRef.current.map(({ user, assistant, interrupted }) => ({ user, assistant, interrupted })),
      ...(frame ? { frame } : {}),
      ...(opening ? { opening: true } : {}),
      ...(audio ? { audio: bytesToBase64(encodeWav(audio)) } : {}),
    };
    transition("thinking");
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
    try {
      const response = await fetch(appPath("/api/turn"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!activeRef.current || sessionId !== sessionIdRef.current || generation !== generationRef.current) return;
      if (!response.ok) {
        const error = await response.json().catch(() => null) as ApiError | null;
        throw new Error(error?.error?.message ?? "Mirror could not answer just now. Please try asking again.");
      }
      const result = await response.json() as TurnResponse;
      if (!activeRef.current || sessionId !== sessionIdRef.current || generation !== generationRef.current || result.turnId !== turnId) return;
      requestRef.current = null;
      if (result.transcript || result.reply) saveHistory([...historyRef.current, { id: turnId, user: result.transcript, assistant: result.reply }]);
      if (result.action === "pause") { pause(); return; }
      if (result.action === "end") { end(); return; }
      if (result.action === "stop") { stopTalking(); return; }
      if (result.reply.trim()) speak(result.reply);
      else transition("listening");
    } catch (error) {
      if (!activeRef.current || sessionId !== sessionIdRef.current || generation !== generationRef.current) return;
      if (controller.signal.aborted && !timedOut) return;
      setNotice(timedOut ? "The reply took too long. Please try asking again." : error instanceof Error ? error.message : "Connection interrupted. Please try asking again.");
      transition("listening");
    } finally {
      clearTimeout(timeout);
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  async function start() {
    if (activeRef.current || phaseRef.current === "starting") return;
    releaseResources();
    const sessionId = sessionIdRef.current;
    const current = () => mountedRef.current && sessionId === sessionIdRef.current;
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
      void context.resume().catch(() => { /* A user gesture will be required on retry. */ });
      if ("speechSynthesis" in window) {
        const unlock = new SpeechSynthesisUtterance("Starting Mirror.");
        unlock.lang = "en-GB";
        window.speechSynthesis.speak(unlock);
      }
      const voice = await englishVoice();
      if (!current()) return;
      voiceRef.current = voice;
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
        },
        onVADMisfire: () => { if (listening()) clearSpeechTimer(); },
      }));
      if (!current()) return;
      activeRef.current = true;
      transition("listening");
      if (historyRef.current.length === 0) void submitTurn(undefined, true);
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
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      releaseResources();
    };
    // Resource ownership is stable through refs; cleanup must run only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { videoRef, phase, history, notice, audioError, cameraReady, start, pause: () => pause(), end, stopTalking,
    active: ["listening", "hearing", "thinking", "speaking"].includes(phase) };
}
