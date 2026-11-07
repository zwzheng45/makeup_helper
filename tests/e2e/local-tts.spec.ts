import { test, expect, type APIRequestContext } from "@playwright/test";
import { installBrowserMedia, sayQuestion, trackStates, waitForReply } from "./browser-media";

const mockUrl = process.env.MOCK_GEMINI_URL ?? "http://mock-gemini:8080";
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? "").replace(/\/$/, "");
type SpeechRequest = { text: string; firstChunkAt: number | null; completed: boolean; completedAt?: number; canceled: boolean; receivedAt: number };
async function speechRequests(request: APIRequestContext): Promise<SpeechRequest[]> {
  return (await (await request.get(`${mockUrl}/__tts`)).json()).requests;
}

test.beforeEach(async ({ page, request, browserName }) => {
  await request.post(`${mockUrl}/__reset`);
  await installBrowserMedia(page, browserName === "webkit");
  await page.goto(`${basePath}/`);
});

test("local voice plays PCM before synthesis finishes and preserves sentence order", async ({ page, request }) => {
  await request.post(`${mockUrl}/__control`, { data: {
    answer: { transcript: "", action: "reply", reply: "Your camera is ready. Tell me what you would like to do." },
    tts: { chunkCount: 12, chunkMs: 100, chunkDelayMs: 100 },
  } });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pcmSamples.length), { timeout: 25_000 }).toBeGreaterThan(0);
  const first = (await speechRequests(request))[0];
  expect(first.text).toBe("Your camera is ready.");
  const firstPlayedAt = await page.evaluate(() => window.__mirrorMedia.pcmSamples[0].at);
  await waitForReply(page, "Tell me what you would like to do.");
  await expect.poll(async () => (await speechRequests(request)).filter((turn) => turn.completed).length).toBe(2);
  // Compare observed event timestamps, not when a polling assertion wakes up.
  expect(firstPlayedAt).toBeLessThan((await speechRequests(request))[0].completedAt!);
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.playbacks.at(-1)?.events.filter((event) => event.type === "completed").length)).toBe(2);
  const segments = await page.evaluate(() => window.__mirrorMedia.playbacks.at(-1)!.events.filter((event) => event.type === "started").map((event) => event.segmentId));
  expect(segments).toEqual([0, 1]);
});

test("a local synthesis failure pauses capture and can recover without replaying the failed answer", async ({ page, request }) => {
  await request.post(`${mockUrl}/__control`, { data: {
    answer: { transcript: "", action: "reply", reply: "This failed answer must not be replayed." }, tts: { status: 503 },
  } });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  const resume = page.getByRole("button", { name: /^(Resume mirror|Reconnect audio)$/ });
  await expect(resume).toBeVisible({ timeout: 25_000 });
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  expect(await page.evaluate(() => window.__mirrorMedia.pcmSamples.length)).toBe(0);
  await resume.click();
  await expect(page.getByRole("button", { name: "Pause mirror", exact: true })).toBeVisible();
  await sayQuestion(page);
  await waitForReply(page, "Your hair is swept to your right");
  expect((await speechRequests(request)).filter((turn) => turn.text.includes("failed answer"))).toHaveLength(1);
});

test("a truncated voice stream releases devices and stops playing", async ({ page, request }) => {
  await request.post(`${mockUrl}/__control`, { data: { tts: { chunkCount: 20, chunkDelayMs: 100, failAfterChunks: 4 } } });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pcmSamples.length), { timeout: 25_000 }).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: /^(Resume mirror|Reconnect audio)$/ })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.speaking)).toBe(false);
});

test("ending a voice stream aborts synthesis and later audio cannot enter a new session", async ({ page, request }) => {
  await request.post(`${mockUrl}/__control`, { data: { tts: { chunkCount: 100, chunkDelayMs: 100 } } });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.pcmSamples.length), { timeout: 25_000 }).toBeGreaterThan(0);
  const oldId = await page.evaluate(() => window.__mirrorMedia.playbacks.at(-1)!.playbackId);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect.poll(async () => (await speechRequests(request))[0]?.canceled).toBe(true);
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await waitForReply(page, "Your camera is ready");
  const audit = await page.evaluate((id) => {
    const old = window.__mirrorMedia.playbacks.find((playback) => playback.playbackId === id)!;
    return {
      stopped: old.stopRequestedAt,
      lateOutput: window.__mirrorMedia.pcmSamples.filter((sample) => sample.playbackId === id && sample.at > old.stopRequestedAt! + 150),
      newId: window.__mirrorMedia.playbacks.at(-1)!.playbackId,
    };
  }, oldId);
  expect(audit.stopped).toBeDefined();
  expect(audit.lateOutput).toEqual([]);
  expect(audit.newId).not.toBe(oldId);
});

test("gentle processing cues stop on pause and do not create microphone turns", async ({ page, request }) => {
  await request.post(`${mockUrl}/__control`, { data: { delayMs: 6000 } });
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.cueOscillators.length), { timeout: 25_000 }).toBeGreaterThan(0);
  const turns = (await (await request.get(`${mockUrl}/__requests`)).json()).requests;
  expect(turns).toHaveLength(1);
  expect(turns[0].opening).toBe(true);
  await page.getByRole("button", { name: "Pause mirror", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mirrorMedia.cueOscillators.every((cue) => cue.endsAt <= Date.now() + 100))).toBe(true);
  const countAfterPause = await page.evaluate(() => window.__mirrorMedia.cueOscillators.length);
  // More than one pulse interval: a leaked timer would create another tone.
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => window.__mirrorMedia.cueOscillators.length)).toBe(countAfterPause);
  expect((await (await request.get(`${mockUrl}/__requests`)).json()).requests).toHaveLength(1);
});
