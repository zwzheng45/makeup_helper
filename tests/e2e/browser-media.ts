import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

interface PlaybackAudit {
  playbackId: number | null;
  commands: { type: string; at: number; samples?: number; segmentId?: number }[];
  events: Record<string, unknown>[];
  peak: number;
  stopRequestedAt?: number;
}

interface TestMedia {
  streams: MediaStream[];
  destinations: MediaStreamAudioDestinationNode[];
  contexts: AudioContext[];
  playbacks: PlaybackAudit[];
  playerNodes: AudioWorkletNode[];
  pcmSamples: { playbackId: number | null; at: number; peak: number }[];
  denyPermission: boolean;
  holdPermission: boolean;
  pendingPermission: boolean;
  releasePermission?: () => void;
  speaking: boolean;
  cueOscillators: { startedAt: number; endsAt: number }[];
  workletPaths: string[];
  failPlayerLoad: boolean;
  /** What each getUserMedia call asked for, to prove typed mode never opens the microphone. */
  requests: { audio: boolean; video: boolean }[];
  /** Every AudioContext the page created, including playback-only ones. */
  createdContexts: number;
}

declare global {
  interface Window { __mirrorMedia: TestMedia }
}

/** Replace device boundaries, while retaining the real VAD and audio processing. */
export async function installBrowserMedia(page: Page, fakeVideoPlayback = false) {
  await page.addInitScript(({ fakeVideoPlayback }) => {
    const media: TestMedia = {
      streams: [], destinations: [], contexts: [], playbacks: [], playerNodes: [], pcmSamples: [],
      denyPermission: false, holdPermission: false, pendingPermission: false,
      speaking: false,
      cueOscillators: [],
      workletPaths: [], failPlayerLoad: false,
      requests: [], createdContexts: 0,
    };
    window.__mirrorMedia = media;
    const cameraFrames = new Map<MediaStream, HTMLCanvasElement>();

    if (fakeVideoPlayback) {
      // Linux WebKit's synthetic canvas MediaStream does not consistently
      // deliver video metadata. Shim this camera boundary only; real audio
      // tracks, AudioWorklet, ONNX inference and media cleanup remain intact.
      const frameFor = (element: HTMLMediaElement) => element.srcObject instanceof MediaStream ? cameraFrames.get(element.srcObject) : undefined;
      for (const name of ["readyState", "paused", "currentTime"] as const) {
        const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name)!;
        Object.defineProperty(HTMLMediaElement.prototype, name, {
          configurable: true,
          get(this: HTMLMediaElement) {
            if (!frameFor(this)) return original.get!.call(this);
            if (name === "currentTime") return performance.now() / 1000;
            const live = (this.srcObject as MediaStream).getVideoTracks().some((track) => track.readyState === "live");
            return name === "paused" ? !live : live ? 4 : 0;
          },
        });
      }
      for (const name of ["videoWidth", "videoHeight"] as const) {
        const original = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, name)!;
        Object.defineProperty(HTMLVideoElement.prototype, name, {
          configurable: true,
          get(this: HTMLVideoElement) {
            const frame = frameFor(this);
            return frame ? name === "videoWidth" ? frame.width : frame.height : original.get!.call(this);
          },
        });
      }
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        return frameFor(this) ? Promise.resolve() : originalPlay.call(this);
      };
      const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (source: CanvasImageSource, ...coordinates: number[]) {
        const image = source instanceof HTMLVideoElement ? frameFor(source) ?? source : source;
        Reflect.apply(originalDrawImage, this, [image, ...coordinates]);
      };
    }
    // Reuse the context that the application creates in its trusted button
    // gesture. A second context created after getUserMedia's async boundary can
    // remain suspended in WebKit, unlike a genuine microphone stream.
    const NativeAudioContext = window.AudioContext;
    let applicationContext: AudioContext | undefined;
    class CapturedAudioContext extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        applicationContext = this;
        media.createdContexts++;
        const addModule = this.audioWorklet.addModule.bind(this.audioWorklet);
        Object.defineProperty(this.audioWorklet, "addModule", { configurable: true, value: (url: string | URL, options?: WorkletOptions) => {
          const path = new URL(String(url), window.location.href).pathname;
          media.workletPaths.push(path);
          if (media.failPlayerLoad && path.endsWith("/audio/pcm-player.worklet.js")) {
            media.failPlayerLoad = false;
            return Promise.reject(new Error("The audio player could not be loaded."));
          }
          return addModule(String(url), options);
        } });
      }
      createOscillator(): OscillatorNode {
        const oscillator = super.createOscillator();
        const audit = { startedAt: Infinity, endsAt: Infinity };
        media.cueOscillators.push(audit);
        const start = oscillator.start.bind(oscillator);
        const stop = oscillator.stop.bind(oscillator);
        oscillator.start = (when = 0) => {
          audit.startedAt = Date.now() + Math.max(0, when - this.currentTime) * 1000;
          start(when);
        };
        oscillator.stop = (when = 0) => {
          audit.endsAt = Date.now() + Math.max(0, when - this.currentTime) * 1000;
          stop(when);
        };
        return oscillator;
      }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: CapturedAudioContext });

    // Observe the real player without replacing its queue, resampling, timing,
    // or AudioWorklet code. A silent analyser branch measures actual samples.
    const NativeWorkletNode = window.AudioWorkletNode;
    class ObservedWorkletNode extends NativeWorkletNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== "mirror-pcm-player") return;
        const audit: PlaybackAudit = { playbackId: null, commands: [], events: [], peak: 0 };
        media.playbacks.push(audit);
        media.playerNodes.push(this);
        const send = this.port.postMessage.bind(this.port);
        Object.defineProperty(this.port, "postMessage", { configurable: true, value: (message: Record<string, unknown>, ...args: unknown[]) => {
          if (typeof message.playbackId === "number") audit.playbackId = message.playbackId;
          audit.commands.push({ type: String(message.type), at: Date.now(), ...(message.samples instanceof Float32Array ? { samples: message.samples.length } : {}), ...(typeof message.segmentId === "number" ? { segmentId: message.segmentId } : {}) });
          if (message.type === "stop") audit.stopRequestedAt = Date.now();
          Reflect.apply(send, this.port, [message, ...args]);
        } });
        this.port.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => { audit.events.push({ ...event.data, at: Date.now() }); });
        this.port.start();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        const mute = context.createGain();
        mute.gain.value = 0;
        this.connect(analyser);
        analyser.connect(mute);
        mute.connect(context.destination);
        const samples = new Float32Array(analyser.fftSize);
        const timer = window.setInterval(() => {
          if (context.state === "closed") { audit.peak = 0; clearInterval(timer); return; }
          analyser.getFloatTimeDomainData(samples);
          audit.peak = context.state === "running" ? samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0) : 0;
          if (audit.peak > 0.005) media.pcmSamples.push({ playbackId: audit.playbackId, at: Date.now(), peak: audit.peak });
        }, 20);
      }
    }
    Object.defineProperty(window, "AudioWorkletNode", { configurable: true, value: ObservedWorkletNode });
    Object.defineProperty(media, "speaking", { get: () => media.playbacks.some((playback) => playback.peak > 0.005) });

    // Keep a strong reference to the overridden device object. WebKit can
    // recreate a native wrapper after collection, losing an expando override.
    const devices = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
    Object.defineProperty(devices, "getUserMedia", {
      configurable: true,
      value: async (constraints?: MediaStreamConstraints) => {
        const wantsAudio = Boolean(constraints?.audio);
        media.requests.push({ audio: wantsAudio, video: Boolean(constraints?.video) });
        if (media.denyPermission) throw new DOMException("Permission denied", "NotAllowedError");
        const context = applicationContext;
        if (wantsAudio && !context) throw new Error("The application must create its audio context before requesting media.");
        let destination: MediaStreamAudioDestinationNode | undefined;
        if (wantsAudio && context) {
          destination = context.createMediaStreamDestination();
          // Keep the synthetic microphone clock active before the speech fixture
          // starts; an unconnected destination can stall WebKit's media pipeline.
          const silence = context.createConstantSource();
          silence.offset.value = 0;
          silence.connect(destination);
          silence.start();
        }
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        canvas.setAttribute("aria-hidden", "true");
        canvas.style.cssText = "position:fixed;bottom:0;right:0;width:1px;height:1px;pointer-events:none";
        document.body.append(canvas);
        const drawing = canvas.getContext("2d")!;
        let frame = 0;
        const paint = () => {
          drawing.fillStyle = frame++ % 2 ? "#ddd9d1" : "#dcd8d0";
          drawing.fillRect(0, 0, 640, 480);
          drawing.fillStyle = "#a38f76";
          drawing.beginPath();
          drawing.ellipse(320, 225, 115, 150, 0, 0, Math.PI * 2);
          drawing.fill();
        };
        paint();
        const video = canvas.captureStream(20);
        const timer = window.setInterval(paint, 50);
        const stream = new MediaStream([...video.getVideoTracks(), ...(destination?.stream.getAudioTracks() ?? [])]);
        cameraFrames.set(stream, canvas);
        const videoTrack = video.getVideoTracks()[0];
        const stop = videoTrack.stop.bind(videoTrack);
        videoTrack.stop = () => { clearInterval(timer); canvas.remove(); stop(); };
        if (media.holdPermission) {
          media.pendingPermission = true;
          await new Promise<void>((resolve) => {
            media.releasePermission = () => {
              media.pendingPermission = false;
              media.holdPermission = false;
              resolve();
            };
          });
        }
        media.streams.push(stream);
        if (context && destination) {
          media.contexts.push(context);
          media.destinations.push(destination);
        }
        return stream;
      },
    });

  }, { fakeVideoPlayback });
}

export async function waitForReply(page: Page, text: string) {
  await expect(page.locator(".reply-text")).toContainText(text, { timeout: 25_000 });
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pcmSamples.length), { timeout: 10_000 }).toBeGreaterThan(0);
}

export async function sayQuestion(page: Page) {
  const wav = await readFile("/tmp/mirror-fixtures/question.wav");
  await page.evaluate(async (encoded) => {
    const media = window.__mirrorMedia;
    const context = media.contexts.at(-1)!;
    const destination = media.destinations.at(-1)!;
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const audio = await context.decodeAudioData(bytes.buffer);
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(destination);
    source.start();
  }, wav.toString("base64"));
}

export async function trackStates(page: Page) {
  return page.evaluate(() => window.__mirrorMedia.streams.flatMap((stream) => stream.getTracks().map((track) => track.readyState)));
}
