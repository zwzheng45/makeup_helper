import { createServer } from "node:http";

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
    const override = nextResponse;
    nextResponse = null;
    const record = {
      opening,
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
    const answer = override?.answer ?? {
      transcript: opening ? "" : "Please look at my hair and tell me what you can see.",
      reply: opening ? "Your camera is ready. What would you like help with?" : "Your hair is swept to your right. I can help you check it again.",
      action: "reply",
    };
    return json(response, 200, {
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(answer) }] } }],
    });
  } catch {
    json(response, 400, { error: { message: "Invalid mock request" } });
  }
}).listen(8080, "0.0.0.0", () => console.log("Mock Gemini listening on port 8080."));
