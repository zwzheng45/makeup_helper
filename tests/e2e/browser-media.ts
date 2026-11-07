import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";

interface TestMedia {
  streams: MediaStream[];
  destinations: MediaStreamAudioDestinationNode[];
  contexts: AudioContext[];
  speech: string[];
  canceled: string[];
  denyPermission: boolean;
  holdPermission: boolean;
  pendingPermission: boolean;
  releasePermission?: () => void;
  playbackMs: number;
  speaking: boolean;
  speechMode: "normal" | "error" | "silent";
}

declare global {
  interface Window { __mirrorMedia: TestMedia }
}

/** Replace device boundaries, while retaining the real VAD and audio processing. */
export async function installBrowserMedia(page: Page, fakeVideoPlayback = false) {
  await page.addInitScript(({ fakeVideoPlayback }) => {
    const media: TestMedia = {
      streams: [], destinations: [], contexts: [], speech: [], canceled: [],
      denyPermission: false, holdPermission: false, pendingPermission: false,
      playbackMs: 150, speaking: false, speechMode: "normal",
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
      }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: CapturedAudioContext });

    // Keep a strong reference to the overridden device object. WebKit can
    // recreate a native wrapper after collection, losing an expando override.
    const devices = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
    Object.defineProperty(devices, "getUserMedia", {
      configurable: true,
      value: async () => {
        if (media.denyPermission) throw new DOMException("Permission denied", "NotAllowedError");
        const context = applicationContext;
        if (!context) throw new Error("The application must create its audio context before requesting media.");
        const destination = context.createMediaStreamDestination();
        // Keep the synthetic microphone clock active before the speech fixture
        // starts; an unconnected destination can stall WebKit's media pipeline.
        const silence = context.createConstantSource();
        silence.offset.value = 0;
        silence.connect(destination);
        silence.start();
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
        const stream = new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]);
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
        media.contexts.push(context);
        media.destinations.push(destination);
        return stream;
      },
    });

    // A native utterance only accepts native SpeechSynthesisVoice objects. Mock
    // both boundaries together; headless systems often have no installed voice.
    class TestUtterance extends EventTarget {
      text: string;
      lang = "";
      voice: SpeechSynthesisVoice | null = null;
      rate = 1;
      pitch = 1;
      volume = 1;
      onstart: SpeechSynthesisUtterance["onstart"] = null;
      onend: SpeechSynthesisUtterance["onend"] = null;
      onerror: SpeechSynthesisUtterance["onerror"] = null;
      constructor(text = "") { super(); this.text = text; }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: TestUtterance });
    const voice = { name: "Test English voice", lang: "en-GB", localService: true, default: true, voiceURI: "test-english" };
    let timer: number | undefined;
    let active: SpeechSynthesisUtterance | null = null;
    const synthesis = new EventTarget();
    Object.assign(synthesis, {
      getVoices: () => [voice],
      speak: (utterance: SpeechSynthesisUtterance) => {
        if (!utterance.text) return;
        active = utterance;
        media.speech.push(utterance.text);
        media.speaking = true;
        if (media.speechMode === "silent") return;
        if (media.speechMode === "error") {
          timer = window.setTimeout(() => {
            if (active !== utterance) return;
            utterance.onerror?.call(utterance, Object.assign(new Event("error"), { error: "audio-busy" }) as SpeechSynthesisErrorEvent);
          }, 0);
          return;
        }
        utterance.onstart?.call(utterance, new Event("start") as SpeechSynthesisEvent);
        timer = window.setTimeout(() => {
          if (active !== utterance) return;
          active = null;
          media.speaking = false;
          utterance.onend?.call(utterance, new Event("end") as SpeechSynthesisEvent);
        }, media.playbackMs);
      },
      cancel: () => {
        if (timer) clearTimeout(timer);
        if (active) media.canceled.push(active.text);
        active = null;
        media.speaking = false;
      },
      pause: () => {},
      resume: () => {},
    });
    Object.defineProperties(synthesis, {
      speaking: { get: () => media.speaking },
      pending: { get: () => false },
      paused: { get: () => false },
    });
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synthesis });
  }, { fakeVideoPlayback });
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
