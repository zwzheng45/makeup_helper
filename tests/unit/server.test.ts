import { describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/health/route";
import { createTurnHandler, explicitAction, MAX_REQUEST_BYTES } from "../../lib/server/gemini";

const NOW = 1_800_000_000_000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]).toString("base64");

function wav(seconds = 0.1, sampleRate = 16_000): string {
  const length = Math.floor(seconds * sampleRate) * 2;
  const bytes = Buffer.alloc(44 + length);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(length, 40);
  return bytes.toString("base64");
}

function request(overrides: Record<string, unknown> = {}, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/turn", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ turnId: 7, audio: wav(), history: [], ...overrides }),
  });
}

function modelResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
    transcript: "Can you see my face?", reply: "Your face is in view. What would you like help with?", action: "reply", ...overrides,
  }) }] } }] });
}

function setup(response: () => Response = () => modelResponse()) {
  const fetcher = vi.fn(async () => response());
  const handler = createTurnHandler({
    fetch: fetcher as unknown as typeof fetch, now: () => NOW,
    config: { apiKey: "test-secret-never-returned", baseUrl: "http://localhost:4010/v1beta", model: "gemini-4-argon" },
  });
  return { handler, fetcher };
}

describe("turn API", () => {
  it("sends audio and a fresh snapshot together and returns the caller's turn ID", async () => {
    const { handler, fetcher } = setup();
    const response = await handler(request({ frame: { data: JPEG, mimeType: "image/jpeg", capturedAt: NOW - 100 } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ turnId: 7, transcript: "Can you see my face?", action: "reply" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1beta/models/gemini-4-argon:generateContent");
    const sent = JSON.parse(init.body as string);
    expect(sent.contents.at(-1).parts.map((part: { inlineData?: { mimeType: string } }) => part.inlineData?.mimeType)).toEqual([undefined, "audio/wav", "image/jpeg"]);
    expect(sent.generationConfig.responseMimeType).toBe("application/json");
    expect(sent.systemInstruction.parts[0].text).toContain("anatomical left and right");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("supports an opening check without audio and suppresses invented opening transcripts", async () => {
    const { handler } = setup();
    const response = await handler(request({ opening: true, audio: undefined }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ transcript: "", action: "reply" });
  });

  it("explicitly tells the model when no camera is available", async () => {
    const { handler, fetcher } = setup();
    await handler(request());
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    expect(sent.contents.at(-1).parts[0].text).toContain("No camera image is attached");
  });

  it.each([NOW - 5_001, NOW + 5_001])("omits untrustworthy frame timestamp %s", async (capturedAt) => {
    const { handler, fetcher } = setup();
    await handler(request({ frame: { data: JPEG, mimeType: "image/jpeg", capturedAt } }));
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    expect(sent.contents.at(-1).parts).toHaveLength(2);
    expect(sent.contents.at(-1).parts[0].text).toContain("timestamp is stale or cannot be trusted");
  });

  it("accepts minor device clock skew", async () => {
    const { handler, fetcher } = setup();
    await handler(request({ frame: { data: JPEG, mimeType: "image/jpeg", capturedAt: NOW + 2_000 } }));
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    expect(sent.contents.at(-1).parts).toHaveLength(3);
  });

  it("marks interrupted history so the model cannot assume its advice was heard", async () => {
    const { handler, fetcher } = setup();
    await handler(request({ history: [{ user: "Where?", assistant: "Turn your head.", interrupted: true }] }));
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    expect(sent.contents[1].parts[0].text).toContain("was interrupted");
  });

  it("does not answer or execute actions when there was no intelligible speech", async () => {
    const { handler } = setup(() => modelResponse({ transcript: "  ", reply: "An invented question.", action: "end" }));
    expect(await (await handler(request())).json()).toEqual({ turnId: 7, transcript: "", reply: "", action: "reply" });
  });

  it("rejects a model's guessed end action without an explicit command", async () => {
    const { handler } = setup(() => modelResponse({ transcript: "I am done with my left cheek.", action: "end" }));
    expect(await (await handler(request())).json()).toMatchObject({
      action: "reply", reply: "I'm still listening. Did you want me to stop speaking, pause, or end this session?",
    });
  });

  it.each([
    ["Could we take a little break?", "pause", "Paused. The camera and microphone are off."],
    ["Do not end this session.", "end", "Session ended."],
    ["If I say stop, will you stop?", "stop", "I have stopped speaking."],
  ])("clarifies a rejected model action without claiming it happened: %s", async (transcript, action, reply) => {
    const { handler } = setup(() => modelResponse({ transcript, action, reply }));
    expect(await (await handler(request())).json()).toMatchObject({
      transcript, action: "reply", reply: "I'm still listening. Did you want me to stop speaking, pause, or end this session?",
    });
  });

  it.each([
    ["End session, please.", "end", "Session ended."],
    ["Stop listening.", "pause", "Paused. Use Resume when you are ready."],
    ["Pause for a minute.", "pause", "Paused. Use Resume when you are ready."],
  ])("executes a common explicit command with an accurate confirmation: %s", async (transcript, action, reply) => {
    const { handler } = setup(() => modelResponse({ transcript, action: "reply", reply: "An unrelated model reply." }));
    expect(await (await handler(request())).json()).toMatchObject({ transcript, action, reply });
  });

  it("honors an explicit command even if the model mislabels its action", async () => {
    const { handler } = setup(() => modelResponse({ transcript: "Please pause the mirror.", action: "reply" }));
    expect(await (await handler(request())).json()).toMatchObject({ action: "pause", reply: "Paused. Use Resume when you are ready." });
  });

  it.each([
    ["invalid base64", { audio: "not-base64" }],
    ["invalid WAV", { audio: Buffer.from("not a WAV").toString("base64") }],
    ["wrong sample rate", { audio: wav(0.1, 44_100) }],
    ["recording over 30 seconds", { audio: wav(30.01) }],
    ["missing audio", { audio: undefined }],
    ["invalid turn ID", { turnId: -1 }],
    ["excess history", { history: Array.from({ length: 11 }, () => ({ user: "Hello", assistant: "Hello" })) }],
    ["invalid image", { frame: { data: wav(), mimeType: "image/jpeg", capturedAt: NOW } }],
  ] satisfies [string, Record<string, unknown>][])("rejects %s before contacting Gemini", async (_label, input) => {
    const { handler, fetcher } = setup();
    const response = await handler(request(input));
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces the request byte limit before decoding media", async () => {
    const { handler, fetcher } = setup();
    const response = await handler(new Request("http://localhost/api/turn", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(MAX_REQUEST_BYTES + 1) }, body: "{}",
    }));
    expect(response.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces the body limit even without a declared content length", async () => {
    const { handler, fetcher } = setup();
    const response = await handler(new Request("http://localhost/api/turn", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(MAX_REQUEST_BYTES + 1),
    }));
    expect(response.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a safe error for malformed JSON", async () => {
    const { handler } = setup();
    const response = await handler(new Request("http://localhost/api/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("does not expose configuration or make an upstream request if the key is absent", async () => {
    const fetcher = vi.fn();
    const handler = createTurnHandler({ fetch: fetcher, config: {} });
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("GEMINI");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500])("sanitizes upstream status %s without retrying or returning upstream text", async (status) => {
    const { handler, fetcher } = setup(() => new Response("test-secret-never-returned", { status }));
    const response = await handler(request());
    expect(response.status).toBe(status === 429 ? 429 : 502);
    expect(await response.text()).not.toContain("test-secret-never-returned");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => Response.json({ candidates: [] }),
    () => Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } }] }),
    () => modelResponse({ action: "unsafe-action" }),
    () => modelResponse({ reply: "x".repeat(1_001) }),
  ])("rejects incomplete or invalid structured responses", async (makeResponse) => {
    const { handler } = setup(makeResponse);
    const response = await handler(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_MODEL_RESPONSE" } });
  });

  it("cancels a timed out request and never retries", async () => {
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, timeoutMs: 5, config: { apiKey: "test" } });
    const response = await handler(request());
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "UPSTREAM_TIMEOUT", retryable: true } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("propagates client cancellation to the upstream request", async () => {
    const client = new AbortController();
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      client.abort();
    }));
    const handler = createTurnHandler({ fetch: fetcher as typeof fetch, config: { apiKey: "test" } });
    const response = await handler(request({}, client.signal));
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_CANCELLED", retryable: false } });
  });
});

describe("explicit session commands", () => {
  it.each([
    ["Stop!", "stop"], ["Please stop talking.", "stop"], ["Can you pause the assistant?", "pause"],
    ["Please pause the mirror.", "pause"], ["End this session.", "end"], ["Could you end the conversation please?", "end"],
    ["End session, please.", "end"], ["Please, stop listening.", "pause"], ["Pause for a moment.", "pause"],
    ["Pause for a minute, please.", "pause"], ["Could you please pause for one minute?", "pause"],
    ["Do not end the session.", "reply"], ["How do I end this session?", "reply"], ["I am done with my hair.", "reply"],
    ["If I say stop, will you stop?", "reply"], ["Stop shaving there?", "reply"], ["End", "reply"],
    ["Don't stop listening.", "reply"], ['"Pause for a minute."', "reply"], ["Should I pause shaving for a minute?", "reply"],
  ])("interprets %s as %s", (transcript, action) => expect(explicitAction(transcript)).toBe(action));
});

describe("health API", () => {
  it("returns only health, without touching the model or exposing configuration", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
