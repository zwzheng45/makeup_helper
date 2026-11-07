import { stopMedia } from "./media";

export interface SessionVad {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
}

/** Owns a single capture attempt, including resources that are still loading. */
export class CaptureSession {
  stream: MediaStream | null = null;
  vad: SessionVad | null = null;
  closed = false;
  private initialization: Promise<SessionVad> | null = null;
  private disposal: Promise<void> | null = null;

  constructor(readonly id: number, readonly context: AudioContext) {}

  attachStream(stream: MediaStream): boolean {
    if (this.closed) { stopMedia(stream); return false; }
    this.stream = stream;
    return true;
  }

  initialize(factory: () => Promise<SessionVad>): Promise<SessionVad> {
    if (this.closed) return Promise.reject(new DOMException("Session ended", "AbortError"));
    this.initialization = Promise.resolve().then(factory).then((vad) => {
      this.vad = vad;
      return vad;
    });
    return this.initialization;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    // Releasing real devices cannot wait for model downloads or initialization.
    stopMedia(this.stream);
    this.stream = null;
    this.disposal = (async () => {
      try { await this.initialization; } catch { /* The factory cleans up failed initialization. */ }
      try { await this.vad?.destroy(); } catch { /* Browser resources can already be gone. */ }
      this.vad = null;
      try { if (this.context.state !== "closed") await this.context.close(); } catch { /* Already closed. */ }
    })();
    return this.disposal;
  }
}
