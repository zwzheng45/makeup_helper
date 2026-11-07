import { expect, test, type Page } from "@playwright/test";
import type { GuidanceContext, TurnRequest } from "../../lib/contracts";
import { installBrowserMedia, trackStates } from "./browser-media";

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? "").replace(/\/$/, "");
const appPath = (path: string) => `${basePath}${path}`;

interface ReferenceDecodeControl {
  holdNext: boolean;
  heldUrl: string;
  release: (() => void) | null;
  revoked: string[];
}

declare global {
  interface Window { __referenceDecode: ReferenceDecodeControl }
}

async function imageFile(page: Page, name: string, color: string) {
  const data = await page.evaluate((color) => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 60;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  }, color);
  return { name, mimeType: "image/png", buffer: Buffer.from(data, "base64") };
}

async function releaseHeldImage(page: Page) {
  const heldUrl = await page.evaluate(() => {
    window.__referenceDecode.release?.();
    return window.__referenceDecode.heldUrl;
  });
  // Revocation happens in the real image processor's finally block, after its
  // JPEG encoding has finished. Wait for that, not an arbitrary timeout.
  await expect.poll(() => page.evaluate((url) => window.__referenceDecode.revoked.includes(url), heldUrl)).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test.beforeEach(async ({ page, browserName }) => {
  await installBrowserMedia(page, browserName === "webkit");
  await page.addInitScript(() => {
    const control: ReferenceDecodeControl = { holdNext: false, heldUrl: "", release: null, revoked: [] };
    window.__referenceDecode = control;
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      const decoded = decode.call(this);
      if (!control.holdNext || !this.src.startsWith("blob:")) return decoded;
      control.holdNext = false;
      control.heldUrl = this.src;
      const held = new Promise<void>((resolve) => { control.release = resolve; });
      return Promise.all([decoded, held]).then(() => undefined);
    };
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { control.revoked.push(url); revokeObjectURL(url); };
  });
  await page.goto(appPath("/"));
});

test("reference selection keeps the newest image when an older decode finishes later", async ({ page }) => {
  const input = page.getByLabel("Reference makeup image", { exact: true });
  const first = await imageFile(page, "first-look.png", "#d13e52");
  const latest = await imageFile(page, "latest-look.png", "#355ec9");
  await page.evaluate(() => { window.__referenceDecode.holdNext = true; });
  await input.setInputFiles(first);
  await expect.poll(() => page.evaluate(() => Boolean(window.__referenceDecode.release))).toBe(true);
  await expect(page.getByText("Preparing your reference image…", { exact: true })).toBeVisible();

  await input.setInputFiles(latest);
  await expect(page.getByText("Reference ready: latest-look.png", { exact: true })).toBeVisible();
  const preview = page.getByRole("img", { name: "Reference makeup look", exact: true });
  const newestPreview = await preview.getAttribute("src");
  await releaseHeldImage(page);

  await expect(page.getByText("Reference ready: latest-look.png", { exact: true })).toBeVisible();
  await expect(preview).toHaveAttribute("src", newestPreview!);
  await expect(page.getByText("first-look.png", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "General conversation", exact: true })).toBeChecked();
  expect(await page.evaluate(() => window.__mirrorMedia.streams.length)).toBe(0);
});

test("reference selection cannot restore an image after end while decoding", async ({ page }) => {
  const image = await imageFile(page, "pending-look.png", "#a84575");
  await page.evaluate(() => { window.__referenceDecode.holdNext = true; });
  await page.getByLabel("Reference makeup image", { exact: true }).setInputFiles(image);
  await expect.poll(() => page.evaluate(() => Boolean(window.__referenceDecode.release))).toBe(true);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await releaseHeldImage(page);

  await expect(page.getByRole("img", { name: "Reference makeup look", exact: true })).toHaveCount(0);
  await expect(page.getByText("Preparing your reference image…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "General conversation", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Guided makeup", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start mirror", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__mirrorMedia.streams.length)).toBe(0);
});

test("reference selection failure and an empty file picker preserve the image and guided progress", async ({ page }) => {
  const guidance: GuidanceContext = {
    goal: "A soft rose look.", currentStep: "Apply blush to your left cheek.", completedSummary: "Skin preparation complete.", complete: false,
  };
  await page.route(`**${appPath("/api/turn")}`, async (route) => {
    const request = route.request().postDataJSON() as TurnRequest;
    await route.fulfill({ json: { turnId: request.turnId, transcript: "", reply: "Continue with the saved blush step.", action: "reply", guidanceContext: guidance } });
  });
  const input = page.getByLabel("Reference makeup image", { exact: true });
  await input.setInputFiles(await imageFile(page, "retained-look.png", "#d184a5"));
  await expect(page.getByText("Reference ready: retained-look.png", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Guided makeup", exact: true }).check();
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect(page.getByText(guidance.currentStep, { exact: true })).toBeVisible({ timeout: 25_000 });
  const preview = page.getByRole("img", { name: "Reference makeup look", exact: true });
  const originalPreview = await preview.getAttribute("src");

  await input.setInputFiles({ name: "corrupt.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]) });
  await expect(page.getByRole("alert")).toContainText("This image could not be read.");
  await expect(preview).toHaveAttribute("src", originalPreview!);
  await expect(page.getByText(guidance.currentStep, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume mirror", exact: true })).toBeVisible();
  await expect.poll(async () => (await trackStates(page)).every((state) => state === "ended")).toBe(true);

  const chooserPromise = page.waitForEvent("filechooser");
  await input.click();
  const chooser = await chooserPromise;
  // Close the native chooser boundary without selecting a replacement file.
  await chooser.setFiles([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(preview).toHaveAttribute("src", originalPreview!);
  await expect(page.getByText("Reference ready: retained-look.png", { exact: true })).toBeVisible();
  await expect(page.getByText(guidance.currentStep, { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Guided makeup", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Resume mirror", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__mirrorMedia.speaking)).toBe(false);
});

test("reference selection applies JPEG orientation and removes EXIF metadata", async ({ page }) => {
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 40, 40);
    context.fillStyle = "#0000ff";
    context.fillRect(40, 0, 40, 40);
    return canvas.toDataURL("image/jpeg", 0.95).split(",")[1];
  });
  const original = Buffer.from(jpeg, "base64");
  // APP1: Exif header, little-endian TIFF, one SHORT orientation tag (6 = 90° clockwise).
  const exif = Buffer.from([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0,
    0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0,
    0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
  ]);
  await page.getByLabel("Reference makeup image", { exact: true }).setInputFiles({
    name: "oriented-look.jpg", mimeType: "image/jpeg", buffer: Buffer.concat([original.subarray(0, 2), exif, original.subarray(2)]),
  });
  const preview = page.getByRole("img", { name: "Reference makeup look", exact: true });
  await expect(preview).toBeVisible();
  const pixels = await preview.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width, height: canvas.height,
      top: Array.from(context.getImageData(20, 20, 1, 1).data),
      bottom: Array.from(context.getImageData(20, 60, 1, 1).data),
    };
  });
  expect(pixels.width).toBe(40);
  expect(pixels.height).toBe(80);
  expect(pixels.top[0]).toBeGreaterThan(200);
  expect(pixels.top[2]).toBeLessThan(50);
  expect(pixels.bottom[0]).toBeLessThan(50);
  expect(pixels.bottom[2]).toBeGreaterThan(200);
  const encoded = Buffer.from((await preview.getAttribute("src"))!.split(",")[1], "base64");
  expect(encoded.includes(Buffer.from("Exif\0\0"))).toBe(false);
});
