import { test, expect, type APIRequestContext, type Page, type Request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installBrowserMedia, sayQuestion, trackStates, waitForReply } from "./browser-media";

const mockUrl = process.env.MOCK_GEMINI_URL ?? "http://mock-gemini:8080";
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? "").replace(/\/$/, "");
const appPath = (path: string) => `${basePath}${path}`;
interface ResourceAudit { requests: string[]; failures: string[]; canceledVoiceResponses: Request[] }
const resourceAudits = new WeakMap<Page, ResourceAudit>();

async function expectResourcesWithinApp(page: Page, requireVad = false) {
  const audit = resourceAudits.get(page)!;
  if (audit.canceledVoiceResponses.length) {
    // Chromium can report ERR_ABORTED when a consumed NDJSON reader is released
    // through the proxy. Only accept this after every turn played and completed.
    await expect(page.locator(".status")).toHaveText("Listening");
    const turns = audit.requests.filter((path) => path === appPath("/api/turn")).length;
    await expect.poll(() => page.evaluate(() => window.__mirrorMedia.playbacks.filter((playback) => playback.events.some((event) => event.type === "drained")).length)).toBe(turns);
    for (const request of audit.canceledVoiceResponses) {
      const response = await request.response();
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-type"]).toContain("application/x-ndjson");
    }
  }
  expect(audit.failures, "Application resources should load successfully").toEqual([]);
  if (basePath) {
    expect(audit.requests.filter((path) => !path.startsWith(`${basePath}/`)), "Application requests must keep the proxy prefix").toEqual([]);
  }
  if (requireVad) {
    expect(audit.requests.some((path) => path === appPath("/vad/silero_vad_v5.onnx"))).toBe(true);
    expect(audit.requests.some((path) => path.startsWith(appPath("/vad/")) && path.endsWith(".wasm"))).toBe(true);
    expect(audit.requests).toContain(appPath("/api/turn"));
    // Worklet module requests do not surface in page.on('request') in Chromium.
    const workletPaths = await page.evaluate(() => window.__mirrorMedia.workletPaths);
    expect(workletPaths).toContain(appPath("/audio/pcm-player.worklet.js"));
    if (basePath) expect(workletPaths.every((path) => path.startsWith(`${basePath}/`))).toBe(true);
  }
}
async function configureNext(request: APIRequestContext, value: Record<string, unknown>) {
  const response = await request.post(`${mockUrl}/__control`, { data: value });
  expect(response.ok()).toBeTruthy();
}

async function mockRequests(request: APIRequestContext) {
  const response = await request.get(`${mockUrl}/__requests`);
  return (await response.json()).requests as { opening: boolean; hasAudio: boolean; hasImage: boolean; completed: boolean; canceled: boolean; typedText: string | null }[];
}

async function ttsRequests(request: APIRequestContext) {
  const response = await request.get(`${mockUrl}/__tts`);
  return (await response.json()).requests as { text: string; speed: number | null; canceled: boolean }[];
}

const OPENING = "Your camera is ready. What would you like help with?";

async function startMirror(page: Page) {
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await waitForReply(page, OPENING);
}

/** Saved settings are read when the mirror page loads. */
async function useSettings(page: Page, settings: Record<string, unknown>) {
  await page.evaluate((value) => localStorage.setItem("mirror-settings", JSON.stringify(value)), settings);
  await page.reload();
}

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test.beforeEach(async ({ page, request, browserName }) => {
  await request.post(`${mockUrl}/__reset`);
  await installBrowserMedia(page, browserName === "webkit");
  const audit: ResourceAudit = { requests: [], failures: [], canceledVoiceResponses: [] };
  resourceAudits.set(page, audit);
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000").origin;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) audit.requests.push(url.pathname);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) audit.failures.push(`${response.status()} ${url.pathname}`);
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    if (url.pathname === appPath("/api/turn") && request.failure()?.errorText === "net::ERR_ABORTED") {
      audit.canceledVoiceResponses.push(request);
    } else audit.failures.push(`${request.failure()?.errorText} ${url.pathname}`);
  });
  await page.goto(appPath("/mirror"));
});

test("production health, keyboard entry and accessible page structure", async ({ page, request }) => {
  const health = await request.get(appPath("/api/health"));
  expect(health.ok()).toBeTruthy();
  expect(await health.json()).toEqual({ status: "ok" });
  await expect(page).toHaveTitle("Mirror");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1, name: "Mirror" })).toBeAttached();
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", appPath("/"));
  const faviconHref = await page.locator('link[rel="icon"]').first().getAttribute("href");
  expect(new URL(faviconHref!, page.url()).pathname).toBe(appPath("/favicon.svg"));
  const favicon = await request.get(appPath("/favicon.svg"));
  expect(favicon.ok()).toBeTruthy();
  expect(favicon.headers()["content-type"]).toContain("image/svg+xml");
  if (basePath) expect((await request.get("/api/health")).status()).toBe(404);
  await expect(page.getByRole("button", { name: /pause/i })).toHaveCount(0);
  // The status live region must exist before its first message, or some screen readers miss it.
  await expect(page.getByRole("status")).toBeAttached();
  const start = page.getByRole("button", { name: "Start mirror", exact: true });
  await start.focus();
  await expect(start).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pcmSamples.length), { timeout: 25_000 }).toBeGreaterThan(0);
  // The Start button disappears; keyboard focus moves to the first new control instead of being lost.
  await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toBeFocused();
  await expect(page.getByText(OPENING, { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expectResourcesWithinApp(page, true);
});

test("mute keeps the camera on, sends nothing, and unmute listens again", async ({ page, request }) => {
  await startMirror(page);
  await expect.poll(async () => (await mockRequests(request)).length).toBe(1);
  const opening = (await mockRequests(request))[0];
  expect(opening.opening).toBe(true);
  expect(opening.hasImage).toBe(true);
  await page.getByRole("button", { name: "Mute microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unmute microphone", exact: true })).toBeVisible();
  await expect(page.getByText("Microphone muted", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Microphone muted.");
  expect((await trackStates(page)).filter((state) => state === "live")).toHaveLength(2);
  expect(await page.evaluate(() => window.__mirrorMedia.streams[0].getAudioTracks()[0].enabled)).toBe(false);
  await sayQuestion(page);
  await page.waitForTimeout(4_000);
  expect(await mockRequests(request)).toHaveLength(1);
  await page.getByRole("button", { name: "Unmute microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toBeVisible();
  await sayQuestion(page);
  await expect.poll(async () => (await mockRequests(request)).filter((turn) => turn.hasAudio).length, { timeout: 20_000 }).toBe(1);
});

test("Finish ends the session and returns to the setup page", async ({ page }) => {
  await startMirror(page);
  await expect(page.getByRole("button", { name: "Stop reply" })).toHaveCount(0);
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${appPath("/")}$`));
  await expect(page).toHaveTitle("Set up Mirror");
  await expect(page.getByRole("heading", { level: 1, name: "Set up Mirror your way." })).toBeVisible();
});

test("a spoken pause request mutes the microphone instead of stopping the mirror", async ({ page, request }) => {
  await startMirror(page);
  await expect(page.locator(".status")).toHaveText("Listening");
  await configureNext(request, { answer: { transcript: "Pause.", reply: "Pausing.", action: "pause" } });
  await sayQuestion(page);
  await expect(page.getByRole("button", { name: "Unmute microphone", exact: true })).toBeVisible({ timeout: 20_000 });
  // No speech is synthesized for a pause, so the status region says what happened.
  await expect(page.getByRole("status")).toContainText("Microphone muted.");
  await expect(page.locator(".status")).toHaveText("Microphone muted");
  expect((await trackStates(page)).filter((state) => state === "live")).toHaveLength(2);
});

test("actual VAD sends a spoken turn with a fresh camera frame", async ({ page, request }) => {
  await startMirror(page);
  await expect(page.locator(".status")).toHaveText("Listening");
  await sayQuestion(page);
  await expect.poll(async () => (await mockRequests(request)).length, { timeout: 20_000 }).toBe(2);
  const turn = (await mockRequests(request))[1];
  expect(turn).toMatchObject({ opening: false, hasAudio: true, hasImage: true, typedText: null });
  await waitForReply(page, "Your hair is swept to your right");
  await expect(page.getByText("Please look at my hair and tell me what you can see.")).toBeVisible();
  await expectResourcesWithinApp(page, true);
});

test("a conversation starter is sent as a typed question", async ({ page, request }) => {
  await startMirror(page);
  await page.getByRole("button", { name: "Have I missed a spot?", exact: true }).click();
  await expect.poll(async () => (await mockRequests(request)).length, { timeout: 20_000 }).toBe(2);
  expect((await mockRequests(request))[1]).toMatchObject({ opening: false, hasAudio: false, hasImage: true, typedText: "Have I missed a spot?" });
  await expect(page.locator(".you-said")).toHaveText("You: Have I missed a spot?");
  await waitForReply(page, "Your hair is swept to your right");
});

test("speaking again interrupts playback and replaces the earlier answer", async ({ page, request }) => {
  await startMirror(page);
  const samplesBefore = await page.evaluate(() => window.__mirrorMedia.pcmSamples.length);
  await configureNext(request, { answer: { transcript: "Please check my hair.", reply: "This is the earlier answer, which should be interrupted.", action: "reply" }, tts: { chunkCount: 100, chunkDelayMs: 100 } });
  await sayQuestion(page);
  await expect.poll(async () => (await mockRequests(request)).length, { timeout: 20_000 }).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pcmSamples.length), { timeout: 20_000 }).toBeGreaterThan(samplesBefore);
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.playbacks.at(-1)?.events.some((event) => event.type === "started"))).toBe(true);
  const interruptedPlayback = await page.evaluate(() => window.__mirrorMedia.playbacks.at(-1)?.playbackId);
  await configureNext(request, { answer: { transcript: "Please check again.", reply: "This is the newest answer.", action: "reply" } });
  await sayQuestion(page);
  await expect.poll(() => page.evaluate((id) => window.__mirrorMedia.playbacks.some((playback) => playback.playbackId === id && playback.stopRequestedAt !== undefined), interruptedPlayback), { timeout: 5000 }).toBe(true);
  await expect.poll(async () => (await ttsRequests(request)).some((turn) => turn.text.includes("earlier answer") && turn.canceled)).toBe(true);
  await waitForReply(page, "This is the newest answer.");
});

test("a delayed answer cannot speak after the mirror stops and starts again", async ({ page, request }) => {
  await startMirror(page);
  await configureNext(request, { delayMs: 3000, answer: { transcript: "Please check.", reply: "This obsolete answer must never play.", action: "reply" } });
  await sayQuestion(page);
  await expect.poll(async () => (await mockRequests(request)).length, { timeout: 20_000 }).toBe(2);
  await setHidden(page, true);
  await setHidden(page, false);
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect.poll(async () => (await mockRequests(request))[1]?.canceled).toBe(true);
  await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toBeVisible();
  await expect(page.locator(".reply-text")).not.toContainText("obsolete answer");
  expect((await ttsRequests(request)).some((turn) => turn.text.includes("obsolete answer"))).toBe(false);
});

test("permission denial is recoverable without a reload", async ({ page }) => {
  await page.evaluate(() => { window.__mirrorMedia.denyPermission = true; });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect(page.getByText(/Camera or microphone permission was denied/)).toBeVisible();
  await page.evaluate(() => { window.__mirrorMedia.denyPermission = false; });
  await startMirror(page);
});

test("leaving the page while permission is pending stops tracks returned later", async ({ page }) => {
  await page.evaluate(() => { window.__mirrorMedia.holdPermission = true; });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pendingPermission)).toBe(true);
  await setHidden(page, true);
  await page.evaluate(() => window.__mirrorMedia.releasePermission?.());
  await expect.poll(() => trackStates(page)).toEqual(["ended", "ended"]);
  await expect(page.getByRole("button", { name: "Start mirror", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.speaking)).toBe(false);
});

test("a canceled model load cannot take over a restarted session", async ({ page, request }) => {
  let releaseModel!: () => void;
  const firstModel = new Promise<void>((resolve) => { releaseModel = resolve; });
  let modelRequests = 0;
  await page.route("**/vad/silero_vad_v5.onnx", async (route) => {
    modelRequests += 1;
    if (modelRequests === 1) await firstModel;
    await route.continue().catch(() => {});
  });
  try {
    await page.getByRole("button", { name: "Start mirror", exact: true }).click();
    await expect.poll(() => modelRequests, { timeout: 20_000 }).toBe(1);
    await setHidden(page, true);
    await expect.poll(() => trackStates(page)).toEqual(["ended", "ended"]);
    await setHidden(page, false);
    await startMirror(page);
    releaseModel();
    await expect.poll(() => trackStates(page)).toEqual(["ended", "ended", "live", "live"]);
    await sayQuestion(page);
    await expect.poll(async () => (await mockRequests(request)).filter((turn) => turn.hasAudio).length, { timeout: 20_000 }).toBe(1);
    await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toBeVisible();
  } finally {
    releaseModel();
  }
});

test("audio worklet loading failure releases capture and can reconnect", async ({ page }) => {
  await page.evaluate(() => { window.__mirrorMedia.failPlayerLoad = true; });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  const reconnect = page.getByRole("button", { name: "Reconnect audio", exact: true });
  await expect(reconnect).toBeVisible({ timeout: 25_000 });
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await reconnect.click();
  await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).filter((state) => state === "live").length).toBe(2);
  await sayQuestion(page);
  await waitForReply(page, "Your hair is swept to your right");
});

test("audio processor failure stops playback and permits explicit recovery", async ({ page, request }) => {
  await configureNext(request, { tts: { chunkCount: 100, chunkDelayMs: 100 } });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pcmSamples.length), { timeout: 25_000 }).toBeGreaterThan(0);
  await page.evaluate(() => window.__mirrorMedia.playerNodes.at(-1)!.dispatchEvent(new Event("processorerror")));
  const reconnect = page.getByRole("button", { name: "Reconnect audio", exact: true });
  await expect(reconnect).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Select Reconnect audio");
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.speaking)).toBe(false);
  await reconnect.click();
  await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toBeVisible();
  await sayQuestion(page);
  await waitForReply(page, "Your hair is swept to your right");
});

test("upstream failure keeps the session available for a new question", async ({ page, request }) => {
  await startMirror(page);
  await configureNext(request, { status: 429 });
  await sayQuestion(page);
  await expect.poll(async () => (await mockRequests(request)).length, { timeout: 20_000 }).toBe(2);
  await expect(page.getByRole("status")).toContainText("The assistant is busy");
  await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toBeVisible();
  await sayQuestion(page);
  await waitForReply(page, "Your hair is swept to your right");
});

test("backgrounding stops capture and Start mirror reconnects", async ({ page }) => {
  await startMirror(page);
  await setHidden(page, true);
  await expect(page.getByRole("button", { name: "Start mirror", exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Select Start mirror to continue");
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.speaking)).toBe(false);
});

test("pagehide and restored pageshow require Start mirror", async ({ page }) => {
  await startMirror(page);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.getByRole("button", { name: "Start mirror", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).filter((state) => state === "live").length).toBe(2);
});

test.describe("personal settings", () => {
  test("typed mode never opens the microphone and sends typed questions", async ({ page, request }) => {
    await useSettings(page, { nonverbal: true });
    await expect(page.getByText("Mirror uses your camera. You type your questions.")).toBeVisible();
    // Replies are still read aloud by default, through the same voice stream.
    await startMirror(page);
    const question = page.getByRole("textbox", { name: "Your question" });
    await expect(question).toBeFocused();
    await expect(page.getByRole("button", { name: /microphone/i })).toHaveCount(0);
    expect(await page.evaluate(() => window.__mirrorMedia.requests)).toEqual([{ audio: false, video: true }]);
    expect(await page.evaluate(() => window.__mirrorMedia.contexts.length)).toBe(0);
    expect(resourceAudits.get(page)!.requests.some((path) => path.startsWith(appPath("/vad/")))).toBe(false);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Type a question first, then select Send.");
    expect(await mockRequests(request)).toHaveLength(1);
    await question.fill("Is my lipstick even?");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await mockRequests(request)).length, { timeout: 20_000 }).toBe(2);
    expect((await mockRequests(request))[1]).toMatchObject({ hasAudio: false, hasImage: true, typedText: "Is my lipstick even?" });
    await waitForReply(page, "Your hair is swept to your right. I can help you check it again.");
    await expect(question).toHaveValue("");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect((await trackStates(page))).toEqual(["live"]);
  });

  test("typed mode with read aloud off uses no audio at all", async ({ page, request }) => {
    await useSettings(page, { nonverbal: true, readAloud: false });
    await page.getByRole("button", { name: "Start mirror", exact: true }).click();
    await expect(page.getByText(OPENING, { exact: true })).toBeVisible({ timeout: 25_000 });
    expect(await page.evaluate(() => window.__mirrorMedia.createdContexts)).toBe(0);
    expect(await page.evaluate(() => window.__mirrorMedia.requests)).toEqual([{ audio: false, video: true }]);
    expect(await ttsRequests(request)).toEqual([]);
  });

  test("with read aloud off, replies are shown and announced but not spoken", async ({ page, request }) => {
    await useSettings(page, { readAloud: false });
    await page.getByRole("button", { name: "Start mirror", exact: true }).click();
    await expect(page.getByText(OPENING, { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(page.locator(".reply-text")).toHaveAttribute("aria-live", "polite");
    await expect.poll(async () => (await mockRequests(request)).length).toBe(1);
    await expect(page.locator(".status")).toHaveText("Listening");
    // The server answers in JSON, so the voice service is never asked to speak.
    expect(await ttsRequests(request)).toEqual([]);
    expect(await page.evaluate(() => window.__mirrorMedia.pcmSamples.length)).toBe(0);
    expect(await page.evaluate(() => window.__mirrorMedia.workletPaths)).not.toContain(appPath("/audio/pcm-player.worklet.js"));
    await sayQuestion(page);
    await expect(page.getByText("Your hair is swept to your right. I can help you check it again.")).toBeVisible({ timeout: 20_000 });
    expect(await ttsRequests(request)).toEqual([]);
  });

  test("talking speed reaches the voice service and text size scales the page", async ({ page, request }) => {
    await useSettings(page, { speed: "slow", textSize: "larger" });
    await expect(page.locator("html")).toHaveAttribute("data-text-size", "larger");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("24px");
    await startMirror(page);
    const spoken = await ttsRequests(request);
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken.every((turn) => turn.speed === 0.8)).toBe(true);
  });

  test("normal talking speed sends text alone to the voice service", async ({ page, request }) => {
    await startMirror(page);
    const spoken = await ttsRequests(request);
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken.every((turn) => turn.speed === null)).toBe(true);
  });
});
