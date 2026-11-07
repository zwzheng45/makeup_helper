import { createServer } from "node:http";
import { createHash } from "node:crypto";

let nextResponse = null;
let requests = [];

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

createServer(async (request, response) => {
  try {
    if (request.url === "/healthz") return json(response, 200, { ok: true });
    if (request.url === "/__control" && request.method === "POST") {
      nextResponse = await readJson(request);
      return json(response, 200, { ok: true });
    }
    if (request.url === "/__reset" && request.method === "POST") {
      nextResponse = null;
      requests = [];
      return json(response, 200, { ok: true });
    }
    if (request.url === "/__requests") return json(response, 200, { requests });
    if (request.method !== "POST" || !request.url?.endsWith(":generateContent")) {
      return json(response, 404, { error: "Unknown mock route" });
    }
    const body = await readJson(request);
    const parts = body.contents?.at(-1)?.parts ?? [];
    const opening = parts.some((part) => part.text?.startsWith("Opening camera check."));
    const mode = parts.map((part) => part.text ?? "").join("\n").match(/Mode: (general|guided|compare)\./)?.[1] ?? "general";
    const contextText = parts.find((part) => part.text?.startsWith("Guidance context: {"))?.text;
    const guidanceContext = contextText ? JSON.parse(contextText.slice("Guidance context: ".length)) : null;
    let imageRole = "unlabelled";
    const images = [];
    for (const part of parts) {
      if (part.text?.startsWith("Reference image:")) imageRole = "reference";
      if (part.text?.startsWith("Current camera image:")) imageRole = "current";
      if (part.text?.includes("Image role: Current camera image of the user.")) imageRole = "current";
      if (part.inlineData?.mimeType === "image/jpeg") {
        images.push({ role: imageRole, digest: createHash("sha256").update(part.inlineData.data).digest("hex") });
      }
    }
    const override = nextResponse;
    nextResponse = null;
    const record = {
      opening,
      mode,
      guidanceContext,
      imageRoles: images.map((image) => image.role),
      referenceDigest: images.find((image) => image.role === "reference")?.digest ?? null,
      currentCameraDigest: images.find((image) => image.role === "current")?.digest ?? null,
      history: (body.contents ?? []).slice(0, -1).flatMap((content) => content.parts?.map((part) => part.text).filter(Boolean) ?? []),
      receivedAt: Date.now(),
      hasAudio: parts.some((part) => part.inlineData?.mimeType === "audio/wav"),
      hasImage: parts.some((part) => part.inlineData?.mimeType === "image/jpeg"),
      completed: false,
    };
    requests.push(record);
    if (override?.delayMs) await new Promise((resolve) => setTimeout(resolve, override.delayMs));
    record.completed = true;
    if (override?.status && override.status !== 200) {
      return json(response, override.status, { error: { message: "Simulated upstream failure" } });
    }
    const generalAnswer = {
      transcript: opening ? "" : "Please look at my hair and tell me what you can see.",
      reply: opening ? "Your camera is ready. What would you like help with?" : "Your hair is swept to your right. I can help you check it again.",
      action: "reply",
    };
    const guidedContext = opening
      ? guidanceContext ?? { goal: "A soft rose makeup look.", currentStep: "Prepare your skin.", completedSummary: "", complete: false }
      : { goal: "A soft rose makeup look.", currentStep: "Apply blush to your left cheek.", completedSummary: "Skin preparation complete.", complete: false };
    const answer = override?.answer ?? (mode === "guided" ? {
      ...generalAnswer,
      transcript: opening ? "" : "Done, next step.",
      reply: opening ? guidanceContext ? `Continue your saved step: ${guidanceContext.currentStep}` : "Begin with a clean face. Tell me when you are ready for the next step." : "Apply a small amount of blush to your left cheek.",
      guidanceContext: guidedContext,
    } : mode === "compare" ? {
      ...generalAnswer,
      reply: opening ? "The reference has rose blush. Your current cheeks look lighter." : "Your left cheek looks closer to the reference; your right cheek looks lighter.",
    } : generalAnswer);
    return json(response, 200, {
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(answer) }] } }],
    });
  } catch {
    json(response, 400, { error: { message: "Invalid mock request" } });
  }
}).listen(8080, "0.0.0.0", () => console.log("Mock Gemini listening on port 8080."));
