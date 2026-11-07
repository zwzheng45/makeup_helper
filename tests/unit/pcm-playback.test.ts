import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pcm16Decoder, PcmPlayer } from "../../lib/client/pcm-player";
import { readTurnEvents, VoiceStreamTransportError } from "../../lib/client/turn-stream";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const meta = { type: "meta", turnId: 5, seq: 0, transcript: "A café, please.", action: "reply" };
const done = { type: "done", turnId: 5, seq: 1, response: { turnId: 5, transcript: meta.transcript, reply: "", action: "reply" } };

async function collect(lines: unknown[], chunkSize = 17) {
  const bytes = new TextEncoder().encode(lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readTurnEvents(body, 5)) events.push(event);
  return events;
}

describe("PCM16 decoding", () => {
  it("retains an odd byte across network chunks and decodes signed little-endian samples", () => {
    const decoder = new Pcm16Decoder();
    expect(decoder.decode(Buffer.from([0]).toString("base64"))).toHaveLength(0);
    expect([...decoder.decode(Buffer.from([128, 255, 127]).toString("base64"), true)]).toEqual([-1, 32767 / 32768]);
  });

  it("rejects malformed base64 and a truncated final sample", () => {
    expect(() => new Pcm16Decoder().decode("not-base64!")).toThrow("invalid audio");
    expect(() => new Pcm16Decoder().decode("AA==", true)).toThrow("incomplete audio sample");
  });
});

describe("turn event stream", () => {
  it("reads JSON and UTF-8 characters split across every byte boundary", async () => {
    expect(await collect([meta, done], 1)).toEqual([meta, done]);
  });

  it.each([
    [{ ...meta, seq: 1 }, { ...done, seq: 2 }],
    [meta, { ...done, seq: 3 }],
    [meta, { ...meta, seq: 1 }, { ...done, seq: 2 }],
    [{ type: "audio", turnId: 5, seq: 0, segmentId: 0, data: "AAA=", sampleRate: 24000 }],
    [{ ...meta, turnId: 6 }],
    [meta, done, { ...meta, seq: 2 }],
    [meta, { ...done, response: { ...done.response, turnId: 6 } }],
  ])("rejects wrong order, metadata or turn ownership %#", async (...events) => {
    await expect(collect(events)).rejects.toThrow();
  });

  it("requires a terminal event and limits message size", async () => {
    await expect(collect([meta])).rejects.toThrow("before the reply was complete");
    await expect(collect([" ".repeat(129 * 1024)], 200000)).rejects.toThrow("oversized");
  });

  it("distinguishes a broken network reader from invalid protocol data", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError("Network failed")); } });
    await expect(readTurnEvents(body, 5).next()).rejects.toBeInstanceOf(VoiceStreamTransportError);
    await expect(collect(["invalid JSON"])).rejects.toBeInstanceOf(SyntaxError);
  });
});

function player() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  const messages: { type: string; samples?: Float32Array; end?: boolean }[] = [];
  class Worklet extends EventTarget {
    port = { onmessage: null as ((event: { data: Record<string, unknown> }) => void) | null, close: vi.fn(), postMessage: (message: typeof messages[number]) => messages.push(message) };
    connect = vi.fn((gain) => gain);
    disconnect = vi.fn();
    constructor() { super(); node = this; }
  }
  let node!: Worklet;
  vi.stubGlobal("AudioWorkletNode", Worklet);
  const gain = { gain: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
  const context = { currentTime: 10, destination: {}, createGain: () => gain } as unknown as AudioContext;
  const callbacks = { started: vi.fn(), completed: vi.fn(), error: vi.fn() };
  const value = new PcmPlayer(context, 9, callbacks);
  return { value, callbacks, messages, gain, node, emit: (data: Record<string, unknown>) => node.port.onmessage?.({ data: { playbackId: 9, ...data } }) };
}

describe("PCM player ownership and backpressure", () => {
  it("stops reading at two seconds until the worklet reports actual consumption", async () => {
    const test = player();
    const signal = new AbortController().signal;
    let appended = false;
    const pending = test.value.append(0, new Float32Array(60000), true, signal).then(() => { appended = true; });
    await Promise.resolve();
    expect(test.messages.reduce((count, message) => count + (message.samples?.length ?? 0), 0)).toBe(48000);
    expect(appended).toBe(false);
    test.emit({ type: "progress", consumed: 12000 });
    await pending;
    expect(test.messages.reduce((count, message) => count + (message.samples?.length ?? 0), 0)).toBe(60000);
    expect(test.messages.at(-1)).toMatchObject({ type: "append", end: true });
    test.value.stop();
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a reader blocked by backpressure as soon as its request is aborted", async () => {
    const test = player();
    const controller = new AbortController();
    const pending = test.value.append(0, new Float32Array(60000), true, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    expect(test.messages.reduce((count, message) => count + (message.samples?.length ?? 0), 0)).toBe(48000);
    test.value.stop();
    vi.runAllTimers();
  });

  it("mutes and releases stalled playback instead of waiting forever", async () => {
    const test = player();
    await test.value.append(0, new Float32Array(4800), false, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5250);
    expect(test.callbacks.error).toHaveBeenCalledOnce();
    expect(test.callbacks.error.mock.calls[0][0].message).toContain("stopped playing");
    expect(test.gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 10);
    expect(test.node.disconnect).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles processor errors through an event listener and removes it when stopped", () => {
    const test = player();
    const remove = vi.spyOn(test.node, "removeEventListener");
    test.node.dispatchEvent(new Event("processorerror"));
    expect(test.callbacks.error).toHaveBeenCalledOnce();
    expect(test.callbacks.error.mock.calls[0][0].message).toContain("playback was interrupted");
    expect(test.gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 10);
    expect(remove).toHaveBeenCalledExactlyOnceWith("processorerror", expect.any(Function));
    test.node.dispatchEvent(new Event("processorerror"));
    expect(test.callbacks.error).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes only on drained and ignores messages belonging to old or stopped playback", async () => {
    const test = player();
    await test.value.append(0, new Float32Array(2400), true, new AbortController().signal);
    let finished = false;
    const pending = test.value.finish().then(() => { finished = true; });
    test.emit({ type: "started", segmentId: 0, playbackId: 8 });
    expect(test.callbacks.started).not.toHaveBeenCalled();
    test.emit({ type: "started", segmentId: 0 });
    test.emit({ type: "completed", segmentId: 0 });
    await Promise.resolve();
    expect(finished).toBe(false);
    test.emit({ type: "progress", consumed: 2400 });
    test.emit({ type: "drained" });
    await pending;
    expect(finished).toBe(true);
    test.value.stop();
    test.emit({ type: "started", segmentId: 1 });
    expect(test.callbacks.started).toHaveBeenCalledExactlyOnceWith(0);
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });
});

interface Processor {
  port: { onmessage: (event: { data: Record<string, unknown> }) => void };
  process: (inputs: unknown[], outputs: Float32Array[][]) => boolean;
}

function processor(sampleRate = 48000) {
  const messages: { type: string; segmentId?: number; consumed?: number }[] = [];
  let Constructor!: new (options: unknown) => Processor;
  class BaseProcessor {
    port = { onmessage: null, postMessage: (event: typeof messages[number]) => messages.push(event) };
  }
  runInNewContext(readFileSync(new URL("../../public/audio/pcm-player.worklet.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: BaseProcessor, Float32Array, sampleRate,
    registerProcessor: (name: string, value: typeof Constructor) => { expect(name).toBe("mirror-pcm-player"); Constructor = value; },
  });
  const instance = new Constructor({ processorOptions: { playbackId: 9 } });
  const send = (message: Record<string, unknown>) => instance.port.onmessage({ data: { playbackId: 9, ...message } });
  const render = () => { const output = new Float32Array(128); const active = instance.process([], [[output]]); return { output, active }; };
  return { messages, send, render };
}

describe("real PCM AudioWorklet", () => {
  it.each([48000, 44100])("resamples duration and reports played sentence boundaries at %i Hz", (rate) => {
    const engine = processor(rate);
    engine.send({ type: "append", segmentId: 0, samples: new Float32Array(240).fill(0.25), end: true });
    engine.send({ type: "finish" });
    const audio: number[] = [];
    for (let i = 0; i < 8; i++) {
      const block = engine.render();
      audio.push(...block.output);
      if (!block.active) break;
    }
    expect(Math.abs(audio.filter((value) => value !== 0).length - rate / 100)).toBeLessThanOrEqual(1);
    expect(engine.messages.filter((event) => event.type === "started")).toEqual([{ type: "started", playbackId: 9, segmentId: 0 }]);
    expect(engine.messages.filter((event) => event.type === "completed")).toEqual([{ type: "completed", playbackId: 9, segmentId: 0 }]);
    expect(engine.messages.at(-1)?.type).toBe("drained");
  });

  it("buffers an unfinished short chunk, then starts after 120 ms is available", () => {
    const engine = processor();
    engine.send({ type: "append", segmentId: 0, samples: new Float32Array(1000).fill(0.25), end: false });
    expect(engine.render().output.every((sample) => sample === 0)).toBe(true);
    expect(engine.messages.some((event) => event.type === "started")).toBe(false);
    engine.send({ type: "append", segmentId: 0, samples: new Float32Array(2000).fill(0.25), end: false });
    expect(engine.render().output.some((sample) => sample !== 0)).toBe(true);
  });

  it("handles an empty end marker arriving after its samples have played", () => {
    const engine = processor();
    engine.send({ type: "append", segmentId: 0, samples: new Float32Array(3000).fill(0.25), end: false });
    for (let i = 0; i < 50; i++) engine.render();
    engine.send({ type: "append", segmentId: 0, samples: new Float32Array(), end: true });
    engine.send({ type: "finish" });
    expect(engine.render().active).toBe(false);
    expect(engine.messages.filter((event) => event.type === "completed")).toHaveLength(1);
  });

  it("discards canceled playback and ignores chunks owned by another turn", () => {
    const engine = processor();
    engine.send({ type: "append", playbackId: 8, segmentId: 0, samples: new Float32Array(3000).fill(1), end: true });
    expect(engine.render().output.every((sample) => sample === 0)).toBe(true);
    engine.send({ type: "append", segmentId: 0, samples: new Float32Array(3000).fill(1), end: true });
    engine.send({ type: "stop" });
    expect(engine.render().active).toBe(false);
    expect(engine.messages.some((event) => event.type === "started")).toBe(false);
  });

  it("rejects more than two seconds of queued samples", () => {
    const engine = processor();
    engine.send({ type: "append", segmentId: 0, samples: new Float32Array(48001), end: false });
    expect(engine.messages[0]?.type).toBe("error");
    expect(engine.render().active).toBe(false);
  });
});
