import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnEvent, TurnResponse } from "../../lib/contracts";
import { createTurnHandler } from "../../lib/server/gemini";
import { createSpeechResponse, localTtsEndpoint, speechSegments } from "../../lib/server/tts";

const TURN: TurnResponse = { turnId: 7, transcript: "Can you see me?", reply: "Your face is in view. Hold still for a moment.", action: "reply" };
const PCM = new Uint8Array([0, 0, 0, 1, 0, 2, 0, 3]);
const HEADERS = { "Content-Type": "audio/pcm; rate=24000; channels=1", "X-PCM-Format": "s16le" };
const DECODER = new TextDecoder();

function audio(bytes: Uint8Array = PCM, headers: Record<string, string> = HEADERS): Response {
  return new Response(new Uint8Array(bytes).buffer, { headers });
}

function speech(result: TurnResponse = TURN, fetcher: typeof fetch = vi.fn(async () => audio()), signal: AbortSignal = new AbortController().signal) {
  return createSpeechResponse(result, signal, { fetch: fetcher });
}

async function events(response: Response): Promise<TurnEvent[]> {
  return (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<TurnEvent> {
  const next = await reader.read();
  expect(next.done).toBe(false);
  return JSON.parse(DECODER.decode(next.value));
}

afterEach(() => { vi.useRealTimers(); });

describe("local speech response", () => {
  it("sends validated metadata, ordered sentences and PCM, then the exact committed response", async () => {
    const fetcher = vi.fn(async () => audio());
    const response = speech(TURN, fetcher);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const output = await events(response);
    expect(output.map((event) => event.type)).toEqual(["meta", "text", "audio", "audio", "text", "audio", "audio", "done"]);
    expect(output.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(output.every((event) => event.turnId === 7)).toBe(true);
    expect(output[2]).toMatchObject({ type: "audio", segmentId: 0, data: Buffer.from(PCM).toString("base64"), sampleRate: 24_000 });
    expect(output[3]).toMatchObject({ type: "audio", segmentId: 0, data: "", end: true });
    expect(output.at(-1)).toMatchObject({ type: "done", response: TURN });
    expect(fetcher.mock.calls).toHaveLength(2);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("http://tts:8000/synthesize");
    expect(JSON.parse(init.body as string)).toEqual({ text: "Your face is in view." });
    expect(new Headers(init.headers).has("x-goog-api-key")).toBe(false);
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.redirect).toBe("error");
  });

  it.each(["stop", "pause", "end"] as const)("does not synthesize an explicit %s command", async (action) => {
    const fetcher = vi.fn(async () => audio());
    const output = await events(speech({ ...TURN, action }, fetcher));
    expect(output.map((event) => event.type)).toEqual(["meta", "done"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not synthesize silent or empty replies", async () => {
    const fetcher = vi.fn(async () => audio());
    expect((await events(speech({ ...TURN, transcript: "", reply: "" }, fetcher))).map((event) => event.type)).toEqual(["meta", "done"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("applies downstream backpressure and has only one sidecar request in flight", async () => {
    let reads = 0;
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { reads += 1; controller.enqueue(PCM); controller.close(); },
    }, { highWaterMark: 0 }), { headers: HEADERS }));
    const reader = speech(TURN, fetcher).body!.getReader();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await readEvent(reader)).type).toBe("meta");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await readEvent(reader)).type).toBe("text");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await readEvent(reader)).type).toBe("audio");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reads).toBe(1);
    expect(await readEvent(reader)).toMatchObject({ type: "audio", end: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readEvent(reader)).toMatchObject({ type: "text", segmentId: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caps audio event size and preserves samples split across network chunks", async () => {
    const source = new Uint8Array(40_002);
    source[1] = 4; source[20_001] = 5;
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(source.subarray(0, 1)); controller.enqueue(source.subarray(1, 20_001)); controller.enqueue(source.subarray(20_001)); controller.close(); },
    }), { headers: HEADERS }));
    const output = await events(speech({ ...TURN, reply: "A short sentence." }, fetcher));
    const chunks = output.filter((event): event is Extract<TurnEvent, { type: "audio" }> => event.type === "audio" && !event.end).map((event) => Buffer.from(event.data, "base64"));
    expect(chunks.every((chunk) => chunk.byteLength <= 16_384 && chunk.byteLength % 2 === 0)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(source));
  });

  it.each([
    { "Content-Type": "audio/wav", "X-PCM-Format": "s16le" },
    { "Content-Type": "audio/pcm; rate=16000; channels=1", "X-PCM-Format": "s16le" },
    { "Content-Type": "audio/pcm; rate=24000; channels=2", "X-PCM-Format": "s16le" },
    { "Content-Type": "audio/pcm; rate=24000; channels=1", "X-PCM-Format": "f32le" },
    { "Content-Type": "audio/pcm; rate=24000; channels=1; rate=16000", "X-PCM-Format": "s16le" },
  ])("rejects unsupported or ambiguous PCM headers %j", async (headers) => {
    const output = await events(speech(TURN, vi.fn(async () => audio(PCM, headers))));
    expect(output.at(-1)).toMatchObject({ type: "error", error: { code: "INVALID_TTS_AUDIO" } });
    expect(output.some((event) => event.type === "audio" || event.type === "done")).toBe(false);
  });

  it.each([new Uint8Array(0), new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4, 5]), new TextEncoder().encode("RIFFdata")])("rejects empty, truncated, or container audio without a done commit", async (bytes) => {
    const output = await events(speech(TURN, vi.fn(async () => audio(bytes))));
    expect(output.at(-1)).toMatchObject({ type: "error", error: { code: "INVALID_TTS_AUDIO" } });
    expect(output.some((event) => event.type === "done")).toBe(false);
  });

  it("bounds declared and actual segment audio", async () => {
    for (const response of [audio(PCM, { ...HEADERS, "Content-Length": String(30 * 48_000 + 2) }), audio(new Uint8Array(30 * 48_000 + 2))]) {
      const output = await events(speech(TURN, vi.fn(async () => response)));
      expect(output.at(-1)).toMatchObject({ type: "error", error: { code: "TTS_AUDIO_TOO_LARGE" } });
      expect(output.some((event) => event.type === "done")).toBe(false);
    }
  });

  it("bounds cumulative audio across otherwise valid segments", async () => {
    const output = await events(speech({ ...TURN, reply: "Sentence one. Sentence two. Sentence three. Sentence four." }, vi.fn(async () => audio(new Uint8Array(30 * 48_000)))));
    expect(output.at(-1)).toMatchObject({ type: "error", error: { code: "TTS_AUDIO_TOO_LARGE" } });
    expect(output.some((event) => event.type === "done")).toBe(false);
  });

  it("redacts sidecar errors and never retries or replays a failed sentence", async () => {
    const fetcher = vi.fn(async () => new Response("private-service-secret", { status: 500 }));
    const output = await events(speech(TURN, fetcher));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.at(-1)).toMatchObject({ type: "error", error: { code: "TTS_UNAVAILABLE" } });
    expect(JSON.stringify(output)).not.toContain("private-service-secret");
    expect(output.some((event) => event.type === "done")).toBe(false);
  });

  it("starts the first-PCM deadline at request submission, including time to headers", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => { signal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); });
    const reader = speech(TURN, fetcher as typeof fetch).body!.getReader();
    await readEvent(reader); await readEvent(reader);
    const pending = readEvent(reader);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ type: "error", error: { code: "TTS_TIMEOUT" } });
    expect(signal?.aborted).toBe(true);
    await reader.cancel();
  });

  it("headers and an incomplete PCM prefix do not satisfy the first-audio deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0])); }, cancel }), { headers: HEADERS }));
    const reader = speech(TURN, fetcher).body!.getReader();
    await readEvent(reader); await readEvent(reader);
    const pending = readEvent(reader);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toMatchObject({ type: "error", error: { code: "TTS_TIMEOUT" } });
    expect(cancel).toHaveBeenCalledOnce();
    await reader.cancel();
  });

  it("clears the first-audio timer but still bounds a stalled stream after audio starts", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = createSpeechResponse(TURN, new AbortController().signal, {
      totalTimeoutMs: 6_000,
      fetch: vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(PCM); }, cancel }), { headers: HEADERS })),
    });
    const reader = response.body!.getReader();
    await readEvent(reader); await readEvent(reader); await readEvent(reader);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(cancel).not.toHaveBeenCalled();
    const pending = readEvent(reader);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(await pending).toMatchObject({ type: "error", error: { code: "TTS_TIMEOUT" } });
    expect(cancel).toHaveBeenCalledOnce();
    await reader.cancel();
  });

  it("propagates request cancellation to a pending sidecar body and skips later sentences", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let upstreamSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(PCM); }, cancel }), { headers: HEADERS });
    });
    const reader = speech(TURN, fetcher as typeof fetch, controller.signal).body!.getReader();
    await readEvent(reader); await readEvent(reader); await readEvent(reader);
    const pending = readEvent(reader);
    controller.abort();
    expect(await pending).toMatchObject({ type: "error", error: { code: "REQUEST_CANCELLED" } });
    expect(upstreamSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    await reader.cancel();
  });

  it("cancels synthesis when the response reader is cancelled", async () => {
    const cancel = vi.fn();
    let upstreamSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(PCM); }, cancel }), { headers: HEADERS });
    });
    const reader = speech(TURN, fetcher as typeof fetch).body!.getReader();
    await readEvent(reader); await readEvent(reader); await readEvent(reader);
    await reader.cancel();
    expect(upstreamSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not start synthesis when cancelled before the first pull", async () => {
    const fetcher = vi.fn(async () => audio());
    await speech(TURN, fetcher).body!.cancel();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("local speech configuration and segmentation", () => {
  it.each(["http://tts:8000", "http://mock-gemini:8080", "http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000", "http://10.0.0.5:8000", "http://172.16.1.2:8000", "https://192.168.1.10:8000"]) ("accepts explicit local destination %s", (url) => {
    expect(localTtsEndpoint(url).pathname).toBe("/synthesize");
  });
  it.each(["https://example.com", "http://169.254.169.254", "http://172.32.0.1", "http://192.169.1.1", "file:///tmp/audio", "http://secret@tts:8000", "http://tts:8000?key=secret", "http://tts:8000#secret", "invalid"]) ("rejects unsafe or credential-bearing destination %s", (url) => {
    expect(() => localTtsEndpoint(url)).toThrow("configuration needs attention");
  });
  it("keeps abbreviations, decimals, quotes, and the final unpunctuated tail intact", () => {
    expect(speechSegments('Ask Dr. Lee for advice. Use 0.5 grams. Say "done." Keep your eyes closed')).toEqual([
      "Ask Dr. Lee for advice.", "Use 0.5 grams.", 'Say "done."', "Keep your eyes closed",
    ]);
  });
  it("uses natural clauses and never splits a long word or unpunctuated sentence", () => {
    expect(speechSegments("Keep the brush steady while you gently blend, then stop to check.")).toEqual(["Keep the brush steady while you gently blend,", "then stop to check."]);
    expect(speechSegments("A long unpunctuated sentence should remain complete and never become several isolated words")).toHaveLength(1);
    expect(speechSegments("  ")).toEqual([]);
  });
  it("bounds a long preserved-step instruction without dropping words or changing its guidance", () => {
    const instruction = 'We are still on this step: Blend the blush softly over your cheek using gentle pressure and keep the brush moving slowly as you work toward the edge of your cheek while taking your time to feel where the bristles rest and pausing whenever you need to adjust your grip or ask for help with the technique so that each movement remains comfortable and controlled while you finish blending the product that you have already applied to this side of your face. Say "done" or "next step" when you are ready to move on.';
    const segments = speechSegments(instruction);
    expect(segments.length).toBeGreaterThan(2);
    expect(segments.every((segment) => segment.length <= 250)).toBe(true);
    expect(segments.join(" ")).toBe(instruction);
    expect(speechSegments("a".repeat(1_000))).toEqual(["a".repeat(1_000)]);
  });
});

describe("turn API speech integration", () => {
  function request(accept?: string, overrides: Record<string, unknown> = {}): Request {
    return new Request("http://localhost/api/turn", { method: "POST", headers: { "Content-Type": "application/json", ...(accept ? { Accept: accept } : {}) }, body: JSON.stringify({ turnId: 4, opening: true, history: [], ...overrides }) });
  }
  function model(overrides: Record<string, unknown> = {}): Response {
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ transcript: "", reply: "Your face is in view.", action: "reply", ...overrides }) }] } }] });
  }
  it("opts in to local speech only after a complete validated generateContent response", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/synthesize") ? audio() : model());
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, config: { apiKey: "private-gemini-key", baseUrl: "http://localhost:4010/v1beta", ttsBaseUrl: "http://mock-gemini:8080" } });
    const output = await events(await handler(request("application/x-ndjson")));
    expect(output.at(-1)).toMatchObject({ type: "done", response: { turnId: 4, reply: "Your face is in view." } });
    expect(String(fetcher.mock.calls[0][0])).toContain(":generateContent");
    expect(String(fetcher.mock.calls[1][0])).toBe("http://mock-gemini:8080/synthesize");
    expect(JSON.stringify(output)).not.toContain("private-gemini-key");
  });
  it.each([undefined, "application/json", "application/x-ndjson;q=0"]) ("preserves legacy JSON for Accept %s", async (accept) => {
    const fetcher = vi.fn(async () => model());
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, config: { apiKey: "test-key" } });
    const response = await handler(request(accept));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ turnId: 4, transcript: "", reply: "Your face is in view.", action: "reply" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not speak invalid model output and emits an error before metadata", async () => {
    const fetcher = vi.fn(async () => model({ reply: 123 }));
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, config: { apiKey: "test-key" } });
    const response = await handler(request("application/x-ndjson"));
    expect(response.status).toBe(200);
    expect(await events(response)).toEqual([{ type: "error", turnId: 4, seq: 0, error: {
      code: "INVALID_MODEL_RESPONSE", message: "The assistant's response could not be read. Please try again.", retryable: true,
    } }]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("returns the stream before Argon completes so reader cancellation aborts inference", async () => {
    let started!: () => void;
    const inferenceStarted = new Promise<void>((resolve) => { started = resolve; });
    let upstreamSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      upstreamSignal = init?.signal as AbortSignal;
      upstreamSignal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      started();
    }));
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, config: { apiKey: "test-key" } });
    const original = request("application/x-ndjson");
    const response = await handler(original);
    expect(fetcher).not.toHaveBeenCalled();
    const reader = response.body!.getReader();
    const pending = reader.read();
    await inferenceStarted;
    expect(upstreamSignal?.aborted).toBe(false);
    await reader.cancel();
    expect(upstreamSignal?.aborted).toBe(true);
    expect(original.signal.aborted).toBe(false);
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not invoke Argon when the outer response is cancelled before reading", async () => {
    const fetcher = vi.fn(async () => model());
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, config: { apiKey: "test-key" } });
    await (await handler(request("application/x-ndjson"))).body!.cancel();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reads a streaming request body once and preserves Node duplex requests", async () => {
    let reads = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ turnId: 4, opening: true, history: [] })));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const original = new Request("http://localhost/api/turn", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: source, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/synthesize") ? audio() : model());
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, config: { apiKey: "test-key" } });
    const output = await events(await handler(original));
    expect(output.at(-1)?.type).toBe("done");
    expect(reads).toBe(1);
  });
  it("accepts framework request proxies without passing them to Undici's Request constructor", async () => {
    const original = request("application/x-ndjson");
    // A framework may forward public properties while hiding Undici internals.
    // Such an object is usable as a route Request but cannot be cloned by brand.
    const proxied = new Proxy(original, {
      get(target, property) {
        if (typeof property === "symbol") return undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(() => new Request(proxied)).toThrow();
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/synthesize") ? audio() : model());
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, config: { apiKey: "test-key" } });
    const output = await events(await handler(proxied));
    expect(output.at(-1)).toMatchObject({ type: "done", response: { turnId: 4, reply: "Your face is in view." } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("propagates outer cancellation after metadata to the speech reader and sidecar", async () => {
    let sidecarSignal: AbortSignal | undefined;
    const sidecarCancelled = vi.fn();
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith("/synthesize")) return model();
      sidecarSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(PCM); }, cancel: sidecarCancelled }), { headers: HEADERS });
    });
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, config: { apiKey: "test-key" } });
    const reader = (await handler(request("application/x-ndjson"))).body!.getReader();
    await readEvent(reader); await readEvent(reader); await readEvent(reader);
    await reader.cancel();
    expect(sidecarSignal?.aborted).toBe(true);
    expect(sidecarCancelled).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("speaks the guarded replacement and never the model's rejected progress claim", async () => {
    const prior = { goal: "Rose makeup", currentStep: "Blend the blush.", completedSummary: "Prepared skin.", complete: false };
    const reference = { data: Buffer.from([255, 216, 255, 224, 255, 217]).toString("base64"), mimeType: "image/jpeg" };
    const spoken: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/synthesize")) { spoken.push(JSON.parse(init?.body as string).text); return audio(); }
      return model({ reply: "All your steps are now complete.", guidanceContext: { ...prior, currentStep: "", complete: true } });
    });
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, config: { apiKey: "test-key" } });
    const output = await events(await handler(request("application/x-ndjson", { mode: "guided", reference, guidanceContext: prior })));
    expect(output[0]).toMatchObject({ type: "meta", guidanceContext: prior });
    expect(spoken.join(" ")).toContain("We are still on this step:");
    expect(spoken.join(" ")).not.toContain("All your steps are now complete");
    expect(output.at(-1)).toMatchObject({ type: "done", response: { guidanceContext: prior } });
  });
});
