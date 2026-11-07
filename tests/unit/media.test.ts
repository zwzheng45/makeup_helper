import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64, captureFrame, encodeWav, stopMedia } from "../../lib/client/media";
import { CaptureSession, type SessionVad } from "../../lib/client/session";

afterEach(() => vi.unstubAllGlobals());

describe("microphone WAV encoding", () => {
  it("writes 16 kHz mono PCM16 headers and clips samples without wrapping", () => {
    const bytes = encodeWav(new Float32Array([-2, -1, 0, 1, 2, NaN]));
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([-32768, -32768, 0, 32767, 32767, 0]);
    expect(Buffer.from(bytesToBase64(bytes), "base64")).toEqual(Buffer.from(bytes));
  });

  it("caps an utterance at thirty seconds", () => {
    const bytes = encodeWav(new Float32Array(16000 * 35));
    expect(bytes.length).toBe(44 + 16000 * 30 * 2);
  });
});

describe("camera snapshots", () => {
  function video(properties: Partial<HTMLVideoElement> = {}) {
    return { readyState: 4, videoWidth: 1280, videoHeight: 720, paused: false, ...properties } as HTMLVideoElement;
  }

  it("does not present a stale, paused, or unavailable frame as a current view", () => {
    expect(captureFrame(video(), Date.now() - 3000)).toBeUndefined();
    expect(captureFrame(video({ paused: true }), Date.now())).toBeUndefined();
    expect(captureFrame(video({ readyState: 1 }), Date.now())).toBeUndefined();
    expect(captureFrame(video({ videoWidth: 0 }), Date.now())).toBeUndefined();
  });

  it("sends original pixels scaled proportionally, without a CSS mirror transform", () => {
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL: () => "data:image/jpeg;base64,example" };
    vi.stubGlobal("document", { createElement: () => canvas });
    const element = video();
    const capturedAt = Date.now();
    expect(captureFrame(element, capturedAt)).toEqual({ data: "example", mimeType: "image/jpeg", capturedAt });
    expect(canvas.width).toBe(960);
    expect(canvas.height).toBe(540);
    expect(drawImage).toHaveBeenCalledWith(element, 0, 0, 960, 540);
  });
});

it("stops every audio and video track", () => {
  const audioStop = vi.fn();
  const videoStop = vi.fn();
  stopMedia({ getTracks: () => [{ stop: audioStop }, { stop: videoStop }] } as unknown as MediaStream);
  expect(audioStop).toHaveBeenCalledOnce();
  expect(videoStop).toHaveBeenCalledOnce();
  expect(() => stopMedia(null)).not.toThrow();
});

describe("capture startup cancellation", () => {
  it("releases devices immediately but keeps the context alive until pending VAD can be destroyed", async () => {
    const events: string[] = [];
    const context = { state: "running", close: vi.fn(async () => { events.push("close context"); }) } as unknown as AudioContext;
    const session = new CaptureSession(1, context);
    const stop = vi.fn(() => events.push("stop microphone"));
    session.attachStream({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    let finish!: (vad: SessionVad) => void;
    const deferred = new Promise<SessionVad>((resolve) => { finish = resolve; });
    void session.initialize(() => deferred);
    const disposed = session.dispose();
    expect(stop).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();
    const vad = { start: vi.fn(async () => {}), pause: vi.fn(async () => {}), destroy: vi.fn(async () => { events.push("destroy vad"); }) };
    finish(vad);
    await disposed;
    expect(events).toEqual(["stop microphone", "destroy vad", "close context"]);
    expect(session.vad).toBeNull();
    await session.dispose();
    expect(vad.destroy).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("stops a permission result arriving after that session ended without touching a newer session", async () => {
    const oldClose = vi.fn(async () => {});
    const newClose = vi.fn(async () => {});
    const oldSession = new CaptureSession(1, { state: "running", close: oldClose } as unknown as AudioContext);
    const newSession = new CaptureSession(2, { state: "running", close: newClose } as unknown as AudioContext);
    await oldSession.dispose();
    const oldTrack = { stop: vi.fn() };
    const newTrack = { stop: vi.fn() };
    expect(newSession.attachStream({ getTracks: () => [newTrack] } as unknown as MediaStream)).toBe(true);
    expect(oldSession.attachStream({ getTracks: () => [oldTrack] } as unknown as MediaStream)).toBe(false);
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(newTrack.stop).not.toHaveBeenCalled();
    expect(newClose).not.toHaveBeenCalled();
    await newSession.dispose();
  });

  it("supports a camera-only session without an audio context", async () => {
    const session = new CaptureSession(1, null);
    const track = { stop: vi.fn() };
    expect(session.attachStream({ getTracks: () => [track] } as unknown as MediaStream)).toBe(true);
    await expect(session.dispose()).resolves.toBeUndefined();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("closes its context when initialization fails", async () => {
    const close = vi.fn(async () => {});
    const session = new CaptureSession(1, { state: "running", close } as unknown as AudioContext);
    const initialization = session.initialize(async () => { throw new Error("Model unavailable"); });
    await expect(initialization).rejects.toThrow("Model unavailable");
    await session.dispose();
    expect(close).toHaveBeenCalledOnce();
  });
});
