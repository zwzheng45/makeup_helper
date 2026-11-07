import { describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/health/route";
import { confirmsGuidanceStep, createTurnHandler, explicitAction, MAX_REQUEST_BYTES } from "../../lib/server/gemini";

const NOW = 1_800_000_000_000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]).toString("base64");
const REFERENCE = { data: Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02, 0xff, 0xd9]).toString("base64"), mimeType: "image/jpeg" };
const GUIDE = { goal: "A soft rose makeup look.", currentStep: "Blend the blush gently on your right cheek.", completedSummary: "Prepared the skin.", complete: false };
const NEXT_GUIDE = { ...GUIDE, currentStep: "Blend blush on your left cheek.", completedSummary: "The model must not invent completed work." };

function sizedJpeg(length: number): string {
  const bytes = Buffer.alloc(length);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes.set([0xff, 0xd9], length - 2);
  return bytes.toString("base64");
}

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

describe("reference modes", () => {
  it.each(["guided", "compare"])("requires a reference for %s", async (mode) => {
    const { handler, fetcher } = setup();
    const response = await handler(request({ mode }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "REFERENCE_REQUIRED" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong MIME type", { data: REFERENCE.data, mimeType: "image/png" }],
    ["corrupt JPEG", { data: wav(), mimeType: "image/jpeg" }],
    ["over 512 KiB", { data: sizedJpeg(512 * 1024 + 1), mimeType: "image/jpeg" }],
  ])("rejects a reference with %s", async (_label, reference) => {
    const { handler, fetcher } = setup();
    const response = await handler(request({ mode: "compare", reference }));
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("labels the reference and current appearance immediately before their respective images", async () => {
    const { handler, fetcher } = setup();
    const response = await handler(request({ mode: "compare", reference: REFERENCE, frame: { data: JPEG, mimeType: "image/jpeg", capturedAt: NOW } }));
    expect(response.status).toBe(200);
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    const parts = sent.contents.at(-1).parts;
    expect(parts[0].text).toContain("Mode: compare");
    expect(parts[2].text).toMatch(/^Reference image:/);
    expect(parts[3].inlineData.data).toBe(REFERENCE.data);
    expect(parts[4].text).toMatch(/^Current camera image:/);
    expect(parts[5].inlineData.data).toBe(JPEG);
    expect(sent.systemInstruction.parts[0].text).toContain("never evidence of the user's identity, current appearance, or completed work");
  });

  it.each([undefined, { data: JPEG, mimeType: "image/jpeg", capturedAt: NOW - 6_000 }])("keeps the reference distinct when no usable current frame exists", async (frame) => {
    const { handler, fetcher } = setup();
    await handler(request({ mode: "compare", reference: REFERENCE, frame }));
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    const parts = sent.contents.at(-1).parts;
    expect(parts.filter((part: { inlineData?: { mimeType: string } }) => part.inlineData?.mimeType === "image/jpeg")).toEqual([{ inlineData: REFERENCE }]);
    expect(parts.some((part: { text?: string }) => part.text?.startsWith("Current camera image:"))).toBe(false);
    expect(sent.systemInstruction.parts[0].text).toContain("cannot assess the user's current result, similarity, or completion");
  });

  it("isolates general mode from supplied references and guided progress", async () => {
    const { handler, fetcher } = setup(() => modelResponse({ guidanceContext: GUIDE }));
    const response = await handler(request({ reference: REFERENCE, guidanceContext: GUIDE }));
    expect(await response.json()).not.toHaveProperty("guidanceContext");
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    expect(sent.contents.at(-1).parts).toHaveLength(2);
    expect(JSON.stringify(sent.contents)).not.toContain(REFERENCE.data);
    expect(JSON.stringify(sent.contents)).not.toContain(GUIDE.goal);
    expect(sent.generationConfig.responseSchema.properties).not.toHaveProperty("guidanceContext");
  });

  it("comparison neither sends nor returns a supplied guidance context", async () => {
    const { handler, fetcher } = setup(() => modelResponse({ guidanceContext: { ...NEXT_GUIDE, complete: true } }));
    const response = await handler(request({ mode: "compare", reference: REFERENCE, guidanceContext: GUIDE }));
    expect(await response.json()).not.toHaveProperty("guidanceContext");
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    expect(JSON.stringify(sent.contents)).not.toContain(GUIDE.goal);
    expect(sent.generationConfig.responseSchema.properties).not.toHaveProperty("guidanceContext");
  });

  it("fits maximum reference, camera, audio, and escaped history inside the existing request limit", async () => {
    const { handler } = setup();
    const response = await handler(request({
      mode: "compare", audio: wav(30),
      reference: { data: sizedJpeg(512 * 1024), mimeType: "image/jpeg" },
      frame: { data: sizedJpeg(1024 * 1024), mimeType: "image/jpeg", capturedAt: NOW },
      history: Array.from({ length: 10 }, () => ({ user: "\u0000".repeat(2_000), assistant: "\u0000".repeat(1_500) })),
    }));
    expect(response.status).toBe(200);
  });

  it.each([
    { ...GUIDE, goal: "x".repeat(241) },
    { ...GUIDE, currentStep: "x".repeat(601) },
    { ...GUIDE, completedSummary: "x".repeat(1_201) },
    { ...GUIDE, complete: "true" },
  ])("rejects invalid or unbounded guidance input", async (guidanceContext) => {
    const { handler, fetcher } = setup();
    expect((await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext }))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("guided progress", () => {
  it("sends bounded progress separately from a full ten-turn history", async () => {
    const { handler, fetcher } = setup(() => modelResponse({ guidanceContext: GUIDE }));
    await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: GUIDE, history: Array.from({ length: 10 }, () => ({ user: "A question", assistant: "A reply" })) }));
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    expect(sent.contents).toHaveLength(21);
    expect(sent.contents.at(-1).parts.at(-1).text).toBe(`Guidance context: ${JSON.stringify(GUIDE)}`);
    expect(sent.generationConfig.responseSchema.required).toContain("guidanceContext");
    expect(sent.generationConfig.maxOutputTokens).toBe(2_048);
  });

  it("creates only an initial goal and step even if the opening proposal invents completion", async () => {
    const { handler } = setup(() => modelResponse({ guidanceContext: { ...GUIDE, complete: true }, reply: "You finished the entire look." }));
    const response = await handler(request({ opening: true, audio: undefined, mode: "guided", reference: REFERENCE }));
    const result = await response.json();
    expect(result.guidanceContext).toEqual({ ...GUIDE, completedSummary: "", complete: false });
    expect(result.reply).not.toContain("finished the entire look");
  });

  it("resumes an existing context without advancing on opening", async () => {
    const { handler } = setup(() => modelResponse({ guidanceContext: NEXT_GUIDE, reply: "Move to the next step." }));
    const result = await (await handler(request({ opening: true, audio: undefined, mode: "guided", reference: REFERENCE, guidanceContext: GUIDE }))).json();
    expect(result.guidanceContext).toEqual(GUIDE);
    expect(result.reply).toContain(GUIDE.currentStep);
  });

  it("accepts a clarification answer as the first physical step without requiring done", async () => {
    const initial = { goal: "A soft rose reference look.", currentStep: "", completedSummary: "", complete: false };
    let opening = true;
    const { handler, fetcher } = setup(() => opening
      ? modelResponse({ transcript: "", reply: "The reference has a soft rose look. Which part would you like to focus on?", guidanceContext: initial })
      : modelResponse({ transcript: "Lips. I have lipstick.", reply: "Start by gently applying a little lipstick at the center of your lower lip.", guidanceContext: { ...initial, goal: "Soft rose lips.", currentStep: "Apply a little lipstick at the center of your lower lip." } }));
    const first = await (await handler(request({ opening: true, audio: undefined, mode: "guided", reference: REFERENCE }))).json();
    expect(first.guidanceContext).toEqual(initial);
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    expect(sent.systemInstruction.parts[0].text).toContain('Leave currentStep exactly ""');
    opening = false;
    const next = await (await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: first.guidanceContext }))).json();
    expect(next.guidanceContext).toEqual({ ...initial, goal: "Soft rose lips.", currentStep: "Apply a little lipstick at the center of your lower lip." });
    expect(next.reply).not.toContain('Say "done"');
  });

  it.each(["Am I done?", "I am not done.", "How should I blend it?", "Wait, please repeat that.", 'You said "next step".']) (
    "does not advance or claim completion for %s", async (transcript) => {
      const { handler } = setup(() => modelResponse({ transcript, guidanceContext: { ...NEXT_GUIDE, complete: true }, reply: "The entire look is complete." }));
      const result = await (await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: GUIDE }))).json();
      expect(result.guidanceContext).toEqual(GUIDE);
      expect(result.reply).toContain(GUIDE.currentStep);
      expect(result.reply).not.toContain("entire look is complete");
    },
  );

  it("can clarify the goal while keeping the current step and completion unchanged", async () => {
    const clarified = { ...GUIDE, goal: "A softer rose look, focusing on blush." };
    const { handler } = setup(() => modelResponse({ transcript: "I would like a softer blush.", guidanceContext: clarified, reply: "Use a lighter touch on this same step." }));
    const result = await (await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: GUIDE }))).json();
    expect(result.guidanceContext).toEqual(clarified);
    expect(result.reply).toBe("Use a lighter touch on this same step.");
  });

  it.each([undefined, GUIDE])("does not create or change context on silence", async (guidanceContext) => {
    const { handler } = setup(() => modelResponse({ transcript: "", guidanceContext: { ...NEXT_GUIDE, complete: true }, reply: "Made-up advice." }));
    const result = await (await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext }))).json();
    expect(result.reply).toBe("");
    expect(result.guidanceContext).toEqual(guidanceContext);
  });

  it("preserves the step after interrupted guidance rather than treating it as performed", async () => {
    const { handler } = setup(() => modelResponse({ transcript: "Wait.", guidanceContext: NEXT_GUIDE, reply: "Now move to the next cheek." }));
    const result = await (await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: GUIDE, history: [{ user: "Help", assistant: GUIDE.currentStep, interrupted: true }] }))).json();
    expect(result.guidanceContext).toEqual(GUIDE);
    expect(result.reply).toContain(GUIDE.currentStep);
  });

  it.each(["Done.", "I'm done.", "Next step, please."])("advances one step after an explicit confirmation: %s", async (transcript) => {
    const { handler } = setup(() => modelResponse({ transcript, guidanceContext: NEXT_GUIDE }));
    const result = await (await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: GUIDE }))).json();
    expect(result.guidanceContext).toEqual({ ...NEXT_GUIDE, completedSummary: `${GUIDE.completedSummary}\n${GUIDE.currentStep}` });
    expect(result.guidanceContext.completedSummary).not.toContain("invent");
  });

  it("does not record a completed step when the model has not proposed the next step", async () => {
    const { handler } = setup(() => modelResponse({ transcript: "Done.", guidanceContext: { ...GUIDE, completedSummary: "All steps finished." }, reply: "You advanced and finished all steps." }));
    const result = await (await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: GUIDE }))).json();
    expect(result.guidanceContext).toEqual(GUIDE);
    expect(result.reply).toBe("You confirmed this step, but the next step is not clear yet. Would you like to review the current step?");
  });

  it("does not lose the current step or claim advancement for an empty next-step proposal", async () => {
    const { handler } = setup(() => modelResponse({ transcript: "Next step.", guidanceContext: { ...NEXT_GUIDE, currentStep: "" }, reply: "You have moved to the next step." }));
    const result = await (await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: GUIDE }))).json();
    expect(result.guidanceContext).toEqual(GUIDE);
    expect(result.reply).not.toContain("have moved");
  });

  it("permits final completion only after confirmation and keeps the summary bounded", async () => {
    const prior = { ...GUIDE, completedSummary: "Earlier steps. ".repeat(85).slice(0, 1_200) };
    const { handler } = setup(() => modelResponse({ transcript: "Done.", guidanceContext: { ...NEXT_GUIDE, complete: true } }));
    const result = await (await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: prior }))).json();
    expect(result.guidanceContext.complete).toBe(true);
    expect(result.guidanceContext.currentStep).toBe("");
    expect(result.guidanceContext.completedSummary).toHaveLength(1_200);
    expect(result.guidanceContext.completedSummary.endsWith(GUIDE.currentStep)).toBe(true);
  });

  it.each(["Please pause.", "End session.", "Stop talking."])("keeps guidance unchanged for a session command: %s", async (transcript) => {
    const { handler } = setup(() => modelResponse({ transcript, guidanceContext: NEXT_GUIDE }));
    const result = await (await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: GUIDE }))).json();
    expect(result.guidanceContext).toEqual(GUIDE);
  });

  it("rejects a missing guided proposal for an intelligible turn", async () => {
    const { handler } = setup();
    expect((await handler(request({ mode: "guided", reference: REFERENCE, guidanceContext: GUIDE }))).status).toBe(502);
  });

  it("rejects malformed context returned by the model", async () => {
    const { handler } = setup(() => modelResponse({ guidanceContext: { ...GUIDE, goal: "x".repeat(241) } }));
    expect((await handler(request({ mode: "guided", reference: REFERENCE }))).status).toBe(502);
  });
});

describe("explicit step confirmations", () => {
  it.each([
    ["Done.", true], ["I'm done.", true], ["I’m done.", true], ["I have completed this step.", true],
    ["Next step, please.", true], ["Please move to the next step.", true], ["Done, next step.", true],
    ["Am I done?", false], ["Done?", false], ["I'm not done.", false], ['"Next step"', false],
    ["Do not move to the next step.", false], ["Can you explain the next step?", false], ["Continue.", false],
  ])("interprets %s conservatively", (transcript, expected) => expect(confirmsGuidanceStep(transcript)).toBe(expected));
});

describe("health API", () => {
  it("returns only health, without touching the model or exposing configuration", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
