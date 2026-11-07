import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installBrowserMedia, sayQuestion, trackStates, waitForReply } from "./browser-media";

const mockUrl = process.env.MOCK_GEMINI_URL ?? "http://mock-gemini:8080";
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? "").replace(/\/$/, "");
const appPath = (path: string) => `${basePath}${path}`;
interface ResourceAudit { requests: string[]; failures: string[] }
const resourceAudits = new WeakMap<Page, ResourceAudit>();

async function expectResourcesWithinApp(page: Page, requireVad = false) {
  const audit = resourceAudits.get(page)!;
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
  return (await response.json()).requests as { opening: boolean; hasAudio: boolean; hasImage: boolean; completed: boolean; canceled: boolean }[];
}

async function startMirror(page: Page) {
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await waitForReply(page, "Your camera is ready. What would you like help with?");
}

test.beforeEach(async ({ page, request, browserName }) => {
  await request.post(`${mockUrl}/__reset`);
  await installBrowserMedia(page, browserName === "webkit");
  const audit: ResourceAudit = { requests: [], failures: [] };
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
    if (url.origin === origin) audit.failures.push(`${request.failure()?.errorText} ${url.pathname}`);
  });
  await page.goto(appPath("/"));
});

test("production health, keyboard entry and accessible page structure", async ({ page, request }) => {
  const health = await request.get(appPath("/api/health"));
  expect(health.ok()).toBeTruthy();
  expect(await health.json()).toEqual({ status: "ok" });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("link", { name: "Mirror home", exact: true })).toHaveAttribute("href", appPath("/"));
  const faviconHref = await page.locator('link[rel="icon"]').first().getAttribute("href");
  expect(new URL(faviconHref!, page.url()).pathname).toBe(appPath("/favicon.svg"));
  const favicon = await request.get(appPath("/favicon.svg"));
  expect(favicon.ok()).toBeTruthy();
  expect(favicon.headers()["content-type"]).toContain("image/svg+xml");
  if (basePath) expect((await request.get("/api/health")).status()).toBe(404);
  const start = page.getByRole("button", { name: "Start mirror", exact: true });
  await start.focus();
  await expect(start).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pcmSamples.length), { timeout: 25_000 }).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Pause mirror", exact: true })).toBeVisible();
  await expectResourcesWithinApp(page, true);
});

test("pause, resume and end release real media tracks", async ({ page, request }) => {
  await startMirror(page);
  await expect.poll(async () => (await mockRequests(request)).length).toBe(1);
  const opening = (await mockRequests(request))[0];
  expect(opening.opening).toBe(true);
  expect(opening.hasImage).toBe(true);
  await page.getByRole("button", { name: "Pause mirror", exact: true }).click();
  await expect.poll(() => trackStates(page)).toEqual(["ended", "ended"]);
  await page.getByRole("button", { name: "Resume mirror", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause mirror", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).filter((state) => state === "live").length).toBe(2);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await expect(page.getByRole("button", { name: "Start mirror", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.speaking)).toBe(false);
});

test("actual VAD sends a spoken turn with a fresh camera frame", async ({ page, request }) => {
  await startMirror(page);
  await sayQuestion(page);
  await expect.poll(async () => (await mockRequests(request)).length, { timeout: 20_000 }).toBe(2);
  const turn = (await mockRequests(request))[1];
  expect(turn).toMatchObject({ opening: false, hasAudio: true, hasImage: true });
  await waitForReply(page, "Your hair is swept to your right");
  await expectResourcesWithinApp(page, true);
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
  await expect.poll(async () => (await (await request.get(`${mockUrl}/__tts`)).json()).requests.some((turn: { text: string; canceled: boolean }) => turn.text.includes("earlier answer") && turn.canceled)).toBe(true);
  await waitForReply(page, "This is the newest answer.");
});

test("a delayed answer cannot speak after pause and resume", async ({ page, request }) => {
  await startMirror(page);
  await configureNext(request, { delayMs: 3000, answer: { transcript: "Please check.", reply: "This obsolete answer must never play.", action: "reply" } });
  await sayQuestion(page);
  await expect.poll(async () => (await mockRequests(request)).length, { timeout: 20_000 }).toBe(2);
  await page.getByRole("button", { name: "Pause mirror", exact: true }).click();
  await page.getByRole("button", { name: "Resume mirror", exact: true }).click();
  await expect.poll(async () => (await mockRequests(request))[1]?.canceled).toBe(true);
  await expect(page.locator(".latest-reply")).not.toContainText("obsolete answer");
  await expect(page.getByRole("button", { name: "Pause mirror", exact: true })).toBeVisible();
});

test("permission denial is recoverable without a reload", async ({ page }) => {
  await page.evaluate(() => { window.__mirrorMedia.denyPermission = true; });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect(page.getByText(/Camera or microphone permission was denied/)).toBeVisible();
  await page.evaluate(() => { window.__mirrorMedia.denyPermission = false; });
  await startMirror(page);
});

test("ending while permission is pending stops tracks returned later", async ({ page }) => {
  await page.evaluate(() => { window.__mirrorMedia.holdPermission = true; });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pendingPermission)).toBe(true);
  await page.getByRole("button", { name: "End session", exact: true }).click();
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
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await expect.poll(() => trackStates(page)).toEqual(["ended", "ended"]);
    await startMirror(page);
    releaseModel();
    await expect.poll(() => trackStates(page)).toEqual(["ended", "ended", "live", "live"]);
    await sayQuestion(page);
    await expect.poll(async () => (await mockRequests(request)).filter((turn) => turn.hasAudio).length, { timeout: 20_000 }).toBe(1);
    await expect(page.getByRole("button", { name: "Pause mirror", exact: true })).toBeVisible();
  } finally {
    releaseModel();
  }
});

test("audio worklet loading failure releases capture and can reconnect", async ({ page }) => {
  await page.evaluate(() => { window.__mirrorMedia.failPlayerLoad = true; });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  const reconnect = page.getByRole("button", { name: /^(Reconnect audio|Resume mirror)$/ });
  await expect(reconnect).toBeVisible({ timeout: 25_000 });
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await reconnect.click();
  await expect(page.getByRole("button", { name: "Pause mirror", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).filter((state) => state === "live").length).toBe(2);
  await sayQuestion(page);
  await waitForReply(page, "Your hair is swept to your right");
});

test("audio processor failure stops playback and permits explicit recovery", async ({ page, request }) => {
  await configureNext(request, { tts: { chunkCount: 100, chunkDelayMs: 100 } });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pcmSamples.length), { timeout: 25_000 }).toBeGreaterThan(0);
  await page.evaluate(() => window.__mirrorMedia.playerNodes.at(-1)!.dispatchEvent(new Event("processorerror")));
  const reconnect = page.getByRole("button", { name: /^(Reconnect audio|Resume mirror)$/ });
  await expect(reconnect).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.speaking)).toBe(false);
  await reconnect.click();
  await expect(page.getByRole("button", { name: "Pause mirror", exact: true })).toBeVisible();
  await sayQuestion(page);
  await waitForReply(page, "Your hair is swept to your right");
});

test("upstream failure keeps the session available for a new question", async ({ page, request }) => {
  await startMirror(page);
  await configureNext(request, { status: 429 });
  await sayQuestion(page);
  await expect.poll(async () => (await mockRequests(request)).length, { timeout: 20_000 }).toBe(2);
  await expect(page.locator(".notice")).toContainText("The assistant is busy");
  await expect(page.getByRole("button", { name: "Pause mirror", exact: true })).toBeVisible();
  await sayQuestion(page);
  await waitForReply(page, "Your hair is swept to your right");
});

test("backgrounding pauses capture and requires explicit resume", async ({ page }) => {
  await startMirror(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("button", { name: "Resume mirror", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.speaking)).toBe(false);
});

test("pagehide and restored pageshow require explicit resume", async ({ page }) => {
  await startMirror(page);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.getByRole("button", { name: "Resume mirror", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await page.getByRole("button", { name: "Resume mirror", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause mirror", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).filter((state) => state === "live").length).toBe(2);
});
