import { spawnSync } from "node:child_process";

// Synthetic media stays in memory. This script never prints credentials or media payloads.
const RED_SQUARE = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAEAAQADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAUH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AigILUgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/9k=";

function syntheticSpeech() {
  const result = spawnSync("espeak-ng", ["--stdout", "-v", "en-us", "-s", "145", "This is a mirror test. What color is the square?"], {
    encoding: "buffer", maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("SPEECH_SYNTHESIS_UNAVAILABLE");
  const wav = result.stdout;
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("INVALID_SYNTHETIC_AUDIO");
  let sourceRate;
  let data;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (name === "fmt ") {
      if (wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt16LE(start + 14) !== 16) throw new Error("INVALID_SYNTHETIC_AUDIO");
      sourceRate = wav.readUInt32LE(start + 4);
    }
    if (name === "data") {
      // espeak writes an unknown-length RIFF header when streaming to stdout.
      data = wav.subarray(start, Math.min(start + size, wav.length));
      break;
    }
    offset = start + size + size % 2;
  }
  if (!sourceRate || !data?.length) throw new Error("INVALID_SYNTHETIC_AUDIO");
  const sourceSamples = Math.floor(data.length / 2);
  const sampleCount = Math.floor(sourceSamples * 16_000 / sourceRate);
  const output = Buffer.alloc(44 + sampleCount * 2);
  output.write("RIFF", 0); output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVEfmt ", 8); output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(16_000, 24); output.writeUInt32LE(32_000, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write("data", 36); output.writeUInt32LE(sampleCount * 2, 40);
  for (let i = 0; i < sampleCount; i++) {
    const position = i * sourceRate / 16_000;
    const left = Math.min(Math.floor(position), sourceSamples - 1);
    const right = Math.min(left + 1, sourceSamples - 1);
    const fraction = position - left;
    const sample = data.readInt16LE(left * 2) * (1 - fraction) + data.readInt16LE(right * 2) * fraction;
    output.writeInt16LE(Math.round(sample), 44 + i * 2);
  }
  return output.toString("base64");
}

const startedAt = performance.now();
try {
  const mirrorBaseUrl = process.env.MIRROR_BASE_URL?.trim();
  const audio = syntheticSpeech();
  let result;
  if (mirrorBaseUrl) {
    // The running application owns its credential; this mode neither reads nor sends it.
    const response = await fetch(`${mirrorBaseUrl.replace(/\/+$/, "")}/api/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        turnId: 1,
        audio,
        frame: { data: RED_SQUARE, mimeType: "image/jpeg", capturedAt: Date.now() },
        history: [],
      }),
    });
    if (!response.ok) throw new Error(`APPLICATION_HTTP_${response.status}`);
    try { result = await response.json(); } catch { throw new Error("INVALID_STRUCTURED_RESPONSE"); }
    if (result?.turnId !== 1) throw new Error("TURN_ID_CHECK_FAILED");
  } else {
    const apiKey = process.env.GEMINI_PROXY_KEY;
    if (!apiKey) throw new Error("MISSING_API_KEY");
    const baseUrl = process.env.GEMINI_PROXY_BASE_URL || "https://ai4a11y.lovable.app/api/public/gemini/v1beta";
    const model = process.env.GEMINI_MODEL || "gemini-4-argon";
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_CONFIGURATION");
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "This is a technical QA test with synthetic speech and a synthetic image, not a real user interaction. Transcribe the supplied audio exactly in transcript. Answer the question spoken in the audio by inspecting the image. Keep reply to one short English sentence. Return action reply and the requested JSON object." }] },
        contents: [{ role: "user", parts: [
          { inlineData: { mimeType: "audio/wav", data: audio } },
          { inlineData: { mimeType: "image/jpeg", data: RED_SQUARE } },
        ] }],
        generationConfig: {
          responseMimeType: "application/json", maxOutputTokens: 1_024,
          thinkingConfig: { thinkingLevel: "LOW" },
          responseSchema: {
            type: "OBJECT", required: ["transcript", "reply", "action"],
            properties: {
              transcript: { type: "STRING" }, reply: { type: "STRING" },
              action: { type: "STRING", enum: ["reply", "stop", "pause", "end"] },
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`);
    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason !== "STOP") throw new Error("INCOMPLETE_RESPONSE");
    const output = candidate.content?.parts?.filter((part) => !part.thought && typeof part.text === "string").map((part) => part.text).join("");
    try { result = JSON.parse(output); } catch { throw new Error("INVALID_STRUCTURED_RESPONSE"); }
  }
  if (typeof result?.transcript !== "string" || typeof result.reply !== "string" || result.action !== "reply") throw new Error("INVALID_STRUCTURED_RESPONSE");
  if (!/mirror test/i.test(result.transcript)) throw new Error("AUDIO_TRANSCRIPTION_CHECK_FAILED");
  if (!/\bred\b/i.test(result.reply)) throw new Error("IMAGE_UNDERSTANDING_CHECK_FAILED");
  console.log(`PASS ${mirrorBaseUrl ? "application chain" : "direct Gemini"}: audio + image + structured JSON (${Math.round(performance.now() - startedAt)} ms)`);
  console.log(`Synthetic transcript: ${result.transcript.replace(/[\r\n]/g, " ").slice(0, 160)}`);
  console.log(`Synthetic image reply: ${result.reply.replace(/[\r\n]/g, " ").slice(0, 160)}`);
} catch (error) {
  // Only locally defined failure codes are safe to print; never print upstream bodies.
  const known = /^(?:SPEECH_SYNTHESIS_UNAVAILABLE|INVALID_SYNTHETIC_AUDIO|MISSING_API_KEY|INVALID_MODEL_CONFIGURATION|(?:UPSTREAM|APPLICATION)_HTTP_\d{3}|INCOMPLETE_RESPONSE|INVALID_STRUCTURED_RESPONSE|TURN_ID_CHECK_FAILED|AUDIO_TRANSCRIPTION_CHECK_FAILED|IMAGE_UNDERSTANDING_CHECK_FAILED)$/;
  const reason = error instanceof Error && known.test(error.message) ? error.message : "CONNECTION_OR_RESPONSE_FAILED";
  console.error(`FAIL ${reason} (${Math.round(performance.now() - startedAt)} ms)`);
  process.exitCode = 1;
}
