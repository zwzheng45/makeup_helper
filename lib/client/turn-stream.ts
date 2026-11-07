import { z } from "zod";
import type { TurnEvent } from "../contracts";

export class VoiceStreamTransportError extends Error {}

const context = z.object({ goal: z.string().max(240), currentStep: z.string().max(600), completedSummary: z.string().max(1200), complete: z.boolean() }).strict();
const action = z.enum(["reply", "stop", "pause", "end"]);
const ids = { turnId: z.number().int().nonnegative(), seq: z.number().int().nonnegative() };
const response = z.object({ turnId: ids.turnId, transcript: z.string().max(2000), reply: z.string().max(1000), action, guidanceContext: context.optional() }).strict();
const event = z.discriminatedUnion("type", [
  z.object({ ...ids, type: z.literal("meta"), transcript: z.string().max(2000), action, guidanceContext: context.optional() }).strict(),
  z.object({ ...ids, type: z.literal("text"), segmentId: z.number().int().nonnegative(), text: z.string().min(1).max(1000) }).strict(),
  z.object({ ...ids, type: z.literal("audio"), segmentId: z.number().int().nonnegative(), data: z.string().max(96 * 1024), sampleRate: z.literal(24000), end: z.boolean().optional() }).strict(),
  z.object({ ...ids, type: z.literal("done"), response }).strict(),
  z.object({ ...ids, type: z.literal("error"), error: z.object({ code: z.string(), message: z.string().max(1000), retryable: z.boolean() }).strict() }).strict(),
]);

export async function* readTurnEvents(body: ReadableStream<Uint8Array>, turnId: number): AsyncGenerator<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let previousSequence: number | undefined;
  let terminal = false;
  let meta = false;
  const parse = (line: string): TurnEvent => {
    const parsed = event.parse(JSON.parse(line));
    if (parsed.turnId !== turnId || terminal || parsed.seq !== (previousSequence === undefined ? 0 : previousSequence + 1)) throw new Error("The voice stream arrived out of order.");
    previousSequence = parsed.seq;
    if (parsed.type === "meta") { if (meta) throw new Error("The voice stream repeated its metadata."); meta = true; }
    else if (parsed.type !== "error" && !meta) throw new Error("The voice stream was missing its metadata.");
    if (parsed.type === "done" && parsed.response.turnId !== turnId) throw new Error("The voice stream changed its turn identifier.");
    if (parsed.type === "done" || parsed.type === "error") terminal = true;
    return parsed;
  };
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await reader.read(); }
      catch { throw new VoiceStreamTransportError("The connection to Mirror was interrupted. Please try asking again."); }
      const { value, done } = result;
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const rawLine = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (rawLine.length > 128 * 1024) throw new Error("The voice stream contained an oversized message.");
        const line = rawLine.trim();
        if (line) yield parse(line);
      }
      if (pending.length > 128 * 1024) throw new Error("The voice stream contained an oversized message.");
      if (done) break;
    }
    if (pending.trim()) yield parse(pending.trim());
    if (!terminal) throw new Error("The voice stream ended before the reply was complete.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
