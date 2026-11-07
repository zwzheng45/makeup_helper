import type { MicVAD } from "@ricky0123/vad-web";
import type { SessionVad } from "./session";
import { appPath } from "../app-path";

export interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechRealStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onVADMisfire: () => void;
}

export async function createMirrorVad(stream: MediaStream, audioContext: AudioContext, callbacks: VadCallbacks): Promise<SessionVad> {
  const { MicVAD } = await import("@ricky0123/vad-web");
  // Check the worklet before allocating the ONNX session. MicVAD's public
  // destroy method requires a completed audio initialization.
  if (audioContext.audioWorklet && typeof AudioWorkletNode === "function") {
    await audioContext.audioWorklet.addModule(appPath("/vad/vad.worklet.bundle.min.js"));
  }
  let silentStream: MediaStream | null = null;
  const getStream = async () => {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.some((track) => track.readyState === "live")) return new MediaStream(audioTracks);
    // A canceled startup must finish disposal without reopening the microphone.
    silentStream ??= audioContext.createMediaStreamDestination().stream;
    return silentStream;
  };
  const probe = await getStream();
  const source = new MediaStreamAudioSourceNode(audioContext, { mediaStream: probe });
  source.disconnect();
  let vad: MicVAD | null = null;
  const stopSilent = () => { silentStream?.getTracks().forEach((track) => track.stop()); };
  try {
    vad = await MicVAD.new({
      model: "v5",
      baseAssetPath: appPath("/vad/"),
      onnxWASMBasePath: appPath("/vad/"),
      audioContext,
      startOnLoad: false,
      redemptionMs: 800,
      minSpeechMs: 250,
      preSpeechPadMs: 300,
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.35,
      submitUserSpeechOnPause: true,
      getStream,
      // Pausing VAD segments a long utterance. Session cleanup owns the tracks.
      pauseStream: async () => {},
      resumeStream: getStream,
      ortConfig: (ort) => { ort.env.wasm.numThreads = 1; ort.env.logLevel = "error"; },
      ...callbacks,
    });
    await vad.start();
    const initialized = vad;
    return {
      start: initialized.start,
      pause: initialized.pause,
      destroy: async () => {
        try { await initialized.destroy(); } finally { stopSilent(); }
      },
    };
  } catch (error) {
    try { await vad?.destroy(); } catch { /* Public destroy can reject partial initialization. */ }
    stopSilent();
    throw error;
  }
}
