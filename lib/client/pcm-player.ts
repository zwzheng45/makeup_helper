import { appPath } from "../app-path";

const loadedContexts = new WeakMap<AudioContext, Promise<void>>();
const MAX_QUEUED_SAMPLES = 48_000;

export function preparePcmPlayback(context: AudioContext): Promise<void> {
  if (!context.audioWorklet || typeof AudioWorkletNode !== "function") {
    return Promise.reject(new Error("This browser cannot play the voice stream. Try a current version of Safari or Chrome."));
  }
  let loaded = loadedContexts.get(context);
  if (!loaded) {
    loaded = context.audioWorklet.addModule(appPath("/audio/pcm-player.worklet.js"));
    loadedContexts.set(context, loaded);
    void loaded.catch(() => loadedContexts.delete(context));
  }
  return loaded;
}

/** PCM chunks may split a 16-bit sample; keep that byte until the next chunk. */
export class Pcm16Decoder {
  private remainder: number | undefined;

  decode(base64: string, end = false): Float32Array {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error("The voice stream contained invalid audio.");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length + (this.remainder === undefined ? 0 : 1));
    let offset = 0;
    if (this.remainder !== undefined) bytes[offset++] = this.remainder;
    for (let i = 0; i < binary.length; i++) bytes[offset + i] = binary.charCodeAt(i);
    this.remainder = bytes.length % 2 ? bytes[bytes.length - 1] : undefined;
    if (end && this.remainder !== undefined) throw new Error("The voice stream ended with an incomplete audio sample.");
    const samples = new Float32Array(Math.floor(bytes.length / 2));
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    return samples;
  }
}

export interface PlaybackCallbacks {
  started: (segmentId: number) => void;
  completed: (segmentId: number) => void;
  error: (error: Error) => void;
}

export class PcmPlayer {
  private node: AudioWorkletNode;
  private gain: GainNode;
  private queued = 0;
  private stopped = false;
  private waiting: (() => void)[] = [];
  private resolveDrained!: () => void;
  private rejectDrained!: (error: Error) => void;
  private drained: Promise<void>;
  private lastProgress = performance.now();
  private watchdog: ReturnType<typeof setInterval>;
  private drainDeadline: ReturnType<typeof setTimeout> | undefined;
  private processorError = () => this.fail(new Error("Audio playback was interrupted. Resume your mirror and ask again."));

  constructor(private context: AudioContext, private playbackId: number, private callbacks: PlaybackCallbacks) {
    this.node = new AudioWorkletNode(context, "mirror-pcm-player", {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { playbackId },
    });
    this.gain = context.createGain();
    this.node.connect(this.gain).connect(context.destination);
    this.drained = new Promise((resolve, reject) => { this.resolveDrained = resolve; this.rejectDrained = reject; });
    void this.drained.catch(() => {});
    this.node.port.onmessage = ({ data }) => {
      if (this.stopped || data.playbackId !== this.playbackId) return;
      if (data.type === "progress") {
        this.queued = Math.max(0, this.queued - data.consumed);
        this.lastProgress = performance.now();
        this.wake();
      } else if (data.type === "started") this.callbacks.started(data.segmentId);
      else if (data.type === "completed") this.callbacks.completed(data.segmentId);
      else if (data.type === "drained") { clearTimeout(this.drainDeadline); this.resolveDrained(); }
      else if (data.type === "error") this.fail(new Error(data.message));
    };
    this.node.addEventListener("processorerror", this.processorError);
    this.watchdog = setInterval(() => {
      if (this.queued > 0 && performance.now() - this.lastProgress > 5000) {
        this.fail(new Error("Your device stopped playing the voice stream."));
      }
    }, 250);
  }

  private wake() { const waiting = this.waiting.splice(0); waiting.forEach((resolve) => resolve()); }
  private fail(error: Error) {
    if (this.stopped) return;
    this.rejectDrained(error);
    this.callbacks.error(error);
    this.stop();
  }

  async append(segmentId: number, samples: Float32Array, end: boolean, signal: AbortSignal): Promise<void> {
    const wake = () => this.wake();
    signal.addEventListener("abort", wake, { once: true });
    try {
      for (let offset = 0; offset < samples.length; offset += 4800) {
        const chunk = samples.slice(offset, offset + 4800);
        while (!this.stopped && !signal.aborted && this.queued + chunk.length > MAX_QUEUED_SAMPLES) {
          await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        if (this.stopped || signal.aborted) throw new DOMException("Playback canceled", "AbortError");
        if (this.queued === 0) this.lastProgress = performance.now();
        this.queued += chunk.length;
        this.node.port.postMessage({ type: "append", playbackId: this.playbackId, segmentId, samples: chunk, end: false }, [chunk.buffer]);
      }
      if (this.stopped || signal.aborted) throw new DOMException("Playback canceled", "AbortError");
      if (end) this.node.port.postMessage({ type: "append", playbackId: this.playbackId, segmentId, samples: new Float32Array(), end: true });
    } finally { signal.removeEventListener("abort", wake); }
  }

  async finish(): Promise<void> {
    if (this.stopped) throw new DOMException("Playback canceled", "AbortError");
    this.drainDeadline = setTimeout(() => this.fail(new Error("Audio playback did not finish.")), 5000 + this.queued / 24);
    this.node.port.postMessage({ type: "finish", playbackId: this.playbackId });
    return this.drained;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.drainDeadline);
    this.gain.gain.setValueAtTime(0, this.context.currentTime);
    this.node.port.postMessage({ type: "stop", playbackId: this.playbackId });
    this.node.disconnect();
    this.gain.disconnect();
    this.node.removeEventListener("processorerror", this.processorError);
    this.node.port.onmessage = null;
    setTimeout(() => this.node.port.close(), 100);
    this.rejectDrained(new DOMException("Playback canceled", "AbortError"));
    this.wake();
  }
}
