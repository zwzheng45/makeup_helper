import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installBrowserMedia } from "./browser-media";

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? "").replace(/\/$/, "");
const appPath = (path: string) => `${basePath}${path}`;

async function expectNoAxeViolations(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

async function savedSettings(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("mirror-settings") ?? "null"));
}

test.beforeEach(async ({ page, browserName }) => {
  await installBrowserMedia(page, browserName === "webkit");
  await page.goto(appPath("/"));
});

test("setup page is labelled, keyboard operable and accessible in every theme", async ({ page }) => {
  await expect(page).toHaveTitle("Set up Mirror");
  await expect(page.getByRole("heading", { level: 1, name: "Set up Mirror your way." })).toBeVisible();
  await expect(page.getByRole("group", { name: /How will you use Mirror\?/ })).toBeVisible();
  for (const group of ["Text size", "Contrast", "Theme", "Talking speed"]) await expect(page.getByRole("radiogroup", { name: group })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Read replies aloud" })).toBeChecked();
  await expectNoAxeViolations(page);

  const blind = page.getByRole("checkbox", { name: "Blind or low vision" });
  await blind.focus();
  await page.keyboard.press("Space");
  await expect(blind).toBeChecked();
  await page.getByRole("radio", { name: "Large", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");

  for (const [colorScheme, contrast] of [["dark", "no-preference"], ["light", "more"], ["dark", "more"]] as const) {
    await page.emulateMedia({ colorScheme, contrast });
    await expectNoAxeViolations(page);
  }
  await page.emulateMedia({ colorScheme: "light", contrast: "no-preference" });
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await page.getByRole("radio", { name: "High", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
  await expectNoAxeViolations(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("display options start from the device's own settings", async ({ page }) => {
  await page.emulateMedia({ contrast: "more" });
  await page.reload();
  await expect(page.getByRole("radio", { name: "High", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Auto", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Default", exact: true })).toBeChecked();
  // Saving without changes keeps following the device.
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`${appPath("/mirror")}$`));
  expect(await savedSettings(page)).toMatchObject({ contrast: "auto", theme: "auto", textSize: "default" });
  await expect(page.locator("html")).not.toHaveAttribute("data-contrast");
});

test("saved choices apply on the mirror page and Settings returns to them", async ({ page }) => {
  await page.getByRole("checkbox", { name: "Nonverbal (type instead)" }).check();
  await page.getByRole("radio", { name: "Larger", exact: true }).check();
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await page.getByRole("radio", { name: "Fast", exact: true }).check();
  await page.getByRole("switch", { name: "Read replies aloud" }).uncheck();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`${appPath("/mirror")}$`));
  expect(await savedSettings(page)).toEqual({ blind: false, nonverbal: true, textSize: "larger", contrast: "auto", theme: "dark", readAloud: false, speed: "fast" });
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "larger");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("Mirror uses your camera. You type your questions.")).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveTitle("Set up Mirror");
  await expect(page.getByRole("checkbox", { name: "Nonverbal (type instead)" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Larger", exact: true })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Read replies aloud" })).not.toBeChecked();
});

test("choosing nothing opens the standard voice mirror", async ({ page }) => {
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`${appPath("/mirror")}$`));
  await expect(page.getByText("Mirror uses your camera and microphone.")).toBeVisible();
  await page.getByRole("button", { name: "Start mirror", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toBeVisible({ timeout: 25_000 });
  expect(await page.evaluate(() => window.__mirrorMedia.requests)).toEqual([{ audio: true, video: true }]);
});

test("the setup page reflows at 320 pixels wide with the largest text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole("radio", { name: "Larger", exact: true }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("button", { name: "Start mirror", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
