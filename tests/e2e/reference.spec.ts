import { chromium, expect, test, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { GuidanceContext, TurnRequest } from "../../lib/contracts";
import { installBrowserMedia, sayQuestion, trackStates, waitForReply } from "./browser-media";

const mockUrl = process.env.MOCK_GEMINI_URL ?? "http://mock-gemini:8080";
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? "").replace(/\/$/, "");
const appPath = (path: string) => `${basePath}${path}`;
const requestsByPage = new WeakMap<Page, TurnRequest[]>();

interface MockTurn {
  opening: boolean;
  mode: "general" | "guided" | "compare";
  hasAudio: boolean;
  imageRoles: string[];
  referenceDigest: string | null;
  currentCameraDigest: string | null;
  guidanceContext: GuidanceContext | null;
  history: string[];
  completed: boolean;
  canceled: boolean;
}

async function mockTurns(request: APIRequestContext): Promise<MockTurn[]> {
  return (await (await request.get(`${mockUrl}/__requests`)).json()).requests;
}

async function syntheticImage(page: Page, mimeType = "image/jpeg", color = "#c87486", width = 320, height = 240) {
  const dataUrl = await page.evaluate(({ mimeType, color, width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#fadbcf";
    context.fillRect(width / 3, height / 3, width / 3, height / 3);
    return canvas.toDataURL(mimeType, 0.85);
  }, { mimeType, color, width, height });
  expect(dataUrl.startsWith(`data:${mimeType};base64,`), "Fixture encoder must produce the requested image format").toBe(true);
  return {
    name: `synthetic-reference.${mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]}`,
    mimeType,
    buffer: Buffer.from(dataUrl.split(",")[1], "base64"),
  };
}

async function uploadReference(page: Page, color?: string) {
  const image = await syntheticImage(page, "image/jpeg", color);
  await page.getByLabel("Reference makeup image", { exact: true }).setInputFiles(image);
  await expect(page.getByRole("img", { name: "Reference makeup look", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Guided makeup", exact: true })).toBeEnabled();
}

async function waitForTurns(request: APIRequestContext, count: number) {
  await expect.poll(async () => (await mockTurns(request)).length, { timeout: 25_000 }).toBe(count);
  return mockTurns(request);
}

async function waitForSpeech(page: Page, text: string) {
  await waitForReply(page, text);
}

async function beginMirror(page: Page) {
  await page.getByRole("button", { name: /^(Start|Resume) mirror$/ }).click();
}

async function selectModeWhileRunning(page: Page, label: string) {
  await page.getByRole("radio", { name: label, exact: true }).check();
  await expect(page.getByRole("button", { name: "Resume mirror", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
}

test.beforeEach(async ({ page, request, browserName }) => {
  await request.post(`${mockUrl}/__reset`);
  await installBrowserMedia(page, browserName === "webkit");
  const turns: TurnRequest[] = [];
  requestsByPage.set(page, turns);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === appPath("/api/turn") && request.method() === "POST") turns.push(request.postDataJSON() as TurnRequest);
  });
  await page.goto(appPath("/"));
});

test("reference selection is keyboard accessible and requires an image", async ({ page }) => {
  const general = page.getByRole("radio", { name: "General conversation", exact: true });
  const guided = page.getByRole("radio", { name: "Guided makeup", exact: true });
  const compare = page.getByRole("radio", { name: "Compare with reference", exact: true });
  await expect(general).toBeChecked();
  await expect(guided).toBeDisabled();
  await expect(compare).toBeDisabled();
  await uploadReference(page);
  await guided.focus();
  await page.keyboard.press("Space");
  await expect(guided).toBeChecked();
  await compare.focus();
  await page.keyboard.press("Space");
  await expect(compare).toBeChecked();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Remove reference", exact: true }).click();
  await expect(page.getByRole("img", { name: "Reference makeup look", exact: true })).toHaveCount(0);
  await expect(general).toBeChecked();
  await expect(guided).toBeDisabled();
  await expect(compare).toBeDisabled();
});

test("reference JPEG PNG and WebP inputs normalize to bounded JPEG previews", async ({ page }) => {
  // Chromium supplies the synthetic WebP encoder even when the app is tested
  // in WebKit, whose canvas encoder may fall back to PNG for WebP output.
  const encoder = await chromium.launch();
  try {
    const generator = await encoder.newPage();
    for (const mime of ["image/jpeg", "image/png", "image/webp"]) {
      if (await page.getByRole("img", { name: "Reference makeup look", exact: true }).count()) {
        await page.getByRole("button", { name: "Remove reference", exact: true }).click();
      }
      const fixture = await syntheticImage(generator, mime, "#bd7487", 1600, 1200);
      await page.getByLabel("Reference makeup image", { exact: true }).setInputFiles(fixture);
      const preview = page.getByRole("img", { name: "Reference makeup look", exact: true });
      await expect(preview).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
      await expect(page.getByRole("radio", { name: "Guided makeup", exact: true })).toBeEnabled();
      const image = await preview.evaluate(async (element: HTMLImageElement) => {
        await element.decode();
        return { width: element.naturalWidth, height: element.naturalHeight, bytes: atob(element.src.split(",")[1]).length };
      });
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1280);
      expect(image.width / image.height).toBeCloseTo(4 / 3, 2);
      expect(image.bytes).toBeLessThanOrEqual(512 * 1024);
    }
  } finally {
    await encoder.close();
  }
});

test("reference guided voice turn sends audio and separately labelled images", async ({ page, request }) => {
  await uploadReference(page);
  await page.getByRole("radio", { name: "Guided makeup", exact: true }).check();
  await beginMirror(page);
  await waitForSpeech(page, "Begin with a clean face. Tell me when you are ready for the next step.");
  await expect(page.getByRole("heading", { name: "Your makeup step", exact: true })).toBeVisible();
  await expect(page.getByText("Prepare your skin.", { exact: true })).toBeVisible();
  const opening = (await waitForTurns(request, 1))[0];
  expect(opening).toMatchObject({ mode: "guided", opening: true, imageRoles: ["reference", "current"], guidanceContext: null });
  expect(opening.referenceDigest).toBeTruthy();
  expect(opening.currentCameraDigest).toBeTruthy();
  expect(opening.referenceDigest).not.toBe(opening.currentCameraDigest);
  await sayQuestion(page);
  const voice = (await waitForTurns(request, 2))[1];
  expect(voice).toMatchObject({ mode: "guided", opening: false, hasAudio: true, imageRoles: ["reference", "current"] });
  expect(voice.referenceDigest).toBe(opening.referenceDigest);
  expect(voice.guidanceContext?.currentStep).toBe("Prepare your skin.");
  await waitForSpeech(page, "Apply a small amount of blush to your left cheek.");
  await expect(page.getByText("Apply blush to your left cheek.", { exact: true })).toBeVisible();
  expect(requestsByPage.get(page)?.[1]).toMatchObject({ mode: "guided", reference: { mimeType: "image/jpeg" }, frame: { mimeType: "image/jpeg" } });
});

test("reference modes pause and retain separate histories and guided progress", async ({ page, request }) => {
  test.setTimeout(90_000);
  await uploadReference(page);
  await page.getByRole("radio", { name: "Guided makeup", exact: true }).check();
  await beginMirror(page);
  await waitForSpeech(page, "Begin with a clean face. Tell me when you are ready for the next step.");
  await sayQuestion(page);
  await waitForSpeech(page, "Apply a small amount of blush to your left cheek.");
  await selectModeWhileRunning(page, "Compare with reference");
  expect((await mockTurns(request)).length).toBe(2);
  await expect(page.getByRole("heading", { name: "Your makeup step", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume mirror", exact: true }).click();
  await waitForSpeech(page, "The reference has rose blush. Your current cheeks look lighter.");
  const comparison = (await waitForTurns(request, 3))[2];
  expect(comparison).toMatchObject({ mode: "compare", opening: true, guidanceContext: null, history: [], imageRoles: ["reference", "current"] });
  await selectModeWhileRunning(page, "Guided makeup");
  await expect(page.getByText("Apply blush to your left cheek.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume mirror", exact: true }).click();
  await waitForSpeech(page, "Continue your saved step: Apply blush to your left cheek.");
  const resumed = (await waitForTurns(request, 4))[3];
  expect(resumed.guidanceContext).toMatchObject({ currentStep: "Apply blush to your left cheek.", completedSummary: "Prepare your skin." });
  expect(resumed.history.join("\n")).toContain("Apply a small amount of blush");
  expect(resumed.history.join("\n")).not.toContain("Your current cheeks look lighter");
  await selectModeWhileRunning(page, "General conversation");
  await page.getByRole("button", { name: "Resume mirror", exact: true }).click();
  await waitForSpeech(page, "Your camera is ready. What would you like help with?");
  expect((await waitForTurns(request, 5))[4]).toMatchObject({ mode: "general", guidanceContext: null, history: [], referenceDigest: null, imageRoles: ["current"] });
  expect(requestsByPage.get(page)?.[4].reference).toBeUndefined();
  await selectModeWhileRunning(page, "Compare with reference");
  await page.getByRole("button", { name: "Resume mirror", exact: true }).click();
  const repeated = (await waitForTurns(request, 6))[5];
  expect(repeated.history.join("\n")).toContain("Your current cheeks look lighter");
  expect(repeated.history.join("\n")).not.toContain("Apply a small amount of blush");
});

test("reference replacement clears progress and rejects an old in-flight answer", async ({ page, request }) => {
  await uploadReference(page);
  await page.getByRole("radio", { name: "Guided makeup", exact: true }).check();
  await beginMirror(page);
  await waitForSpeech(page, "Begin with a clean face. Tell me when you are ready for the next step.");
  const original = (await mockTurns(request))[0];
  await request.post(`${mockUrl}/__control`, { data: {
    delayMs: 4000,
    answer: { transcript: "Please check my makeup.", reply: "Obsolete reference advice must never play.", action: "reply", guidanceContext: { goal: "Old look.", currentStep: "Obsolete reference step.", completedSummary: "Old progress.", complete: true } },
  } });
  await sayQuestion(page);
  await waitForTurns(request, 2);
  await uploadReference(page, "#517db9");
  await expect(page.getByRole("button", { name: "Resume mirror", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await page.getByRole("button", { name: "Resume mirror", exact: true }).click();
  const replaced = (await waitForTurns(request, 3))[2];
  expect(replaced).toMatchObject({ mode: "guided", opening: true, guidanceContext: null, history: [] });
  expect(replaced.referenceDigest).not.toBe(original.referenceDigest);
  await expect.poll(async () => (await mockTurns(request))[1]?.canceled).toBe(true);
  await expect(page.locator(".latest-reply")).not.toContainText("Obsolete reference");
  await expect(page.getByText("Prepare your skin.", { exact: true })).toBeVisible();
  await expect(page.getByText("Obsolete reference step.", { exact: true })).toHaveCount(0);
});

test("reference removal stops capture and end clears the reference and conversation", async ({ page, request }) => {
  await uploadReference(page);
  await page.getByRole("radio", { name: "Guided makeup", exact: true }).check();
  await beginMirror(page);
  await waitForSpeech(page, "Begin with a clean face. Tell me when you are ready for the next step.");
  await page.getByRole("button", { name: "Remove reference", exact: true }).click();
  await expect(page.getByRole("radio", { name: "General conversation", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Resume mirror", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);
  await expect(page.getByRole("img", { name: "Reference makeup look", exact: true })).toHaveCount(0);
  await uploadReference(page);
  await page.getByRole("radio", { name: "Guided makeup", exact: true }).check();
  await page.getByRole("button", { name: "Resume mirror", exact: true }).click();
  await waitForTurns(request, 2);
  await expect(page.getByText("Prepare your skin.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect(page.getByRole("img", { name: "Reference makeup look", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your makeup step", exact: true })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "General conversation", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Guided makeup", exact: true })).toBeDisabled();
  await expect(page.locator(".transcript")).toHaveCount(0);
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  expect((await waitForTurns(request, 3))[2]).toMatchObject({ mode: "general", referenceDigest: null, guidanceContext: null, history: [] });
});

test("reference upload rejects unsupported oversized and corrupt images", async ({ page, request }) => {
  const input = page.getByLabel("Reference makeup image", { exact: true });
  await input.setInputFiles({ name: "unsupported.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  await expect(page.getByRole("alert")).toContainText("Choose a JPEG, PNG, or WebP image.");
  await input.setInputFiles({ name: "oversized.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await expect(page.getByRole("alert")).toContainText("Choose an image smaller than 10 MiB.");
  await input.setInputFiles({ name: "corrupt.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]) });
  await expect(page.getByRole("alert")).toContainText("This image could not be read.");
  await expect(page.getByRole("radio", { name: "Guided makeup", exact: true })).toBeDisabled();
  await expect(page.getByRole("img", { name: "Reference makeup look", exact: true })).toHaveCount(0);
  expect(await mockTurns(request)).toEqual([]);
  await uploadReference(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
