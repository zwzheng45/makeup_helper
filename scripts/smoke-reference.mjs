import { chromium } from "@playwright/test";

// Run in the Docker test image against the application. No credential is read here.
// Both pictures are drawn in memory; no real faces or personal files are used.
let browser;
const started = performance.now();
try {
  const base = process.env.MIRROR_BASE_URL?.replace(/\/+$/, "");
  if (!base) throw new Error("MISSING_APPLICATION_URL");
  const modes = process.env.MIRROR_REFERENCE_MODE ? [process.env.MIRROR_REFERENCE_MODE] : ["compare", "guided"];
  if (modes.some((mode) => !["compare", "guided"].includes(mode))) throw new Error("INVALID_REFERENCE_MODE");
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pictures = await page.evaluate(() => {
    return ["#e12626", "#245ef5"].map((lipColor) => {
      const canvas = document.createElement("canvas");
      canvas.width = 384;
      canvas.height = 512;
      const context = canvas.getContext("2d");
      context.fillStyle = "#f3f0e7";
      context.fillRect(0, 0, 384, 512);
      context.fillStyle = "#ebc1a7";
      context.beginPath();
      context.ellipse(192, 245, 115, 165, 0, 0, 2 * Math.PI);
      context.fill();
      context.fillStyle = "#352c29";
      for (const x of [150, 234]) {
        context.beginPath();
        context.ellipse(x, 210, 10, 8, 0, 0, 2 * Math.PI);
        context.fill();
      }
      context.strokeStyle = "#b78c76";
      context.lineWidth = 4;
      context.beginPath();
      context.moveTo(192, 233);
      context.lineTo(183, 273);
      context.lineTo(200, 273);
      context.stroke();
      context.fillStyle = lipColor;
      context.beginPath();
      context.ellipse(192, 320, 45, 14, 0, 0, 2 * Math.PI);
      context.fill();
      return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    });
  });
  await browser.close();
  browser = undefined;
  for (const [index, mode] of modes.entries()) {
    const turnStarted = performance.now();
    const response = await fetch(`${base}/api/turn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        turnId: index + 1, mode, opening: true, history: [],
        reference: { data: pictures[0], mimeType: "image/jpeg" },
        frame: { data: pictures[1], mimeType: "image/jpeg", capturedAt: Date.now() },
      }),
    });
    if (!response.ok) throw new Error(`APPLICATION_HTTP_${response.status}`);
    const result = await response.json();
    if (result.turnId !== index + 1 || result.action !== "reply" || result.transcript !== "" || !result.reply?.trim()) throw new Error("INVALID_STRUCTURED_RESPONSE");
    if (mode === "compare") {
      if (result.guidanceContext || !/\bred\b/i.test(result.reply) || !/\bblue\b/i.test(result.reply)) throw new Error("DUAL_IMAGE_CHECK_FAILED");
    } else {
      const context = result.guidanceContext;
      if (!context || typeof context.goal !== "string" || typeof context.currentStep !== "string" || context.completedSummary !== "" || context.complete !== false) throw new Error("GUIDANCE_CHECK_FAILED");
    }
    console.log(`PASS ${mode}: two synthetic images + structured reply (${Math.round(performance.now() - turnStarted)} ms)`);
    console.log(`Synthetic reply: ${result.reply.replace(/[\r\n]/g, " ").slice(0, 500)}`);
  }
  console.log(`Completed in ${Math.round(performance.now() - started)} ms.`);
} catch (error) {
  const known = /^(?:MISSING_APPLICATION_URL|INVALID_REFERENCE_MODE|APPLICATION_HTTP_\d{3}|INVALID_STRUCTURED_RESPONSE|DUAL_IMAGE_CHECK_FAILED|GUIDANCE_CHECK_FAILED)$/;
  console.error(`FAIL ${error instanceof Error && known.test(error.message) ? error.message : "CONNECTION_OR_RESPONSE_FAILED"} (${Math.round(performance.now() - started)} ms)`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
