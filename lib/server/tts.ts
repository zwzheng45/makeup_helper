import type { ApiError, SpeechRate, TurnEvent, TurnResponse } from "../contracts";

const PCM_BYTES_PER_SECOND = 24_000 * 2;
const MAX_SEGMENT_AUDIO_BYTES = 30 * PCM_BYTES_PER_SECOND;
const MAX_TURN_AUDIO_BYTES = 90 * PCM_BYTES_PER_SECOND;
const MAX_EVENT_AUDIO_BYTES = 16 * 1024;
const DEFAULT_FIRST_AUDIO_TIMEOUT_MS = 3_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
type EventPayload = TurnEvent extends infer Event ? Event extends TurnEvent ? Omit<Event, "turnId" | "seq"> : never : never;

export interface SpeechDependencies {
  fetch?: typeof fetch;
  baseUrl?: string;
  firstAudioTimeoutMs?: number;
  totalTimeoutMs?: number;
}

class SpeechFailure extends Error {
  constructor(readonly code: string, message: string, readonly retryable = true) { super(message); }
}

function cancelled(): SpeechFailure {
  return new SpeechFailure("REQUEST_CANCELLED", "The request was cancelled.", false);
}

function failure(error: unknown, signal: AbortSignal): ApiError["error"] {
  const cause = signal.aborted ? signal.reason : error;
  const safe = cause instanceof SpeechFailure ? cause
    : new SpeechFailure("TTS_UNAVAILABLE", "The local voice service could not respond. Please try again.");
  return { code: safe.code, message: safe.message, retryable: safe.retryable };
}

/** The sidecar receives text (and a speed, when not normal) only, on the explicitly supported local network. */
export function localTtsEndpoint(baseUrl = "http://tts:8000"): URL {
  const invalid = () => new SpeechFailure("TTS_NOT_CONFIGURED", "The local voice service configuration needs attention.", false);
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw invalid(); }
  const host = url.hostname.toLowerCase();
  const octets = host.split(".").map(Number);
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
  const privateIpv4 = ipv4 && (octets[0] === 127 || octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168));
  const local = ["localhost", "[::1]", "tts", "mock-tts", "mock-gemini"].includes(host) || privateIpv4;
  if (!["http:", "https:"].includes(url.protocol) || !local || url.username || url.password || url.search || url.hash) throw invalid();
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/synthesize`;
  return url;
}

/** Keep whole sentences where possible, splitting long sentences at natural clauses. */
export function speechSegments(text: string): string[] {
  const segments: string[] = [];
  const normalized = text.trim();
  let start = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const preceding = normalized.slice(start, index + 1);
    const sentenceEnd = /[.!?]/.test(character);
    const clauseEnd = /[,;:]/.test(character) && preceding.split(/\s+/).length >= 8;
    if (!sentenceEnd && !clauseEnd) continue;
    if (character === "." && /(?:\b(?:Mr|Mrs|Ms|Dr|St|Prof|e\.g|i\.e)|\b[A-Z])\.$/i.test(preceding)) continue;
    let end = index + 1;
    while (end < normalized.length && /["'”’)]/.test(normalized[end])) end += 1;
    if (end < normalized.length && !/\s/.test(normalized[end])) continue;
    const segment = normalized.slice(start, end).trim();
    if (segment) segments.push(segment);
    start = end;
    index = end - 1;
  }
  const tail = normalized.slice(start).trim();
  if (tail) segments.push(tail);
  // Bound long instructions too, while preserving whole words and every word
  // of a guarded replacement. A single word with no whitespace stays intact.
  return segments.flatMap((segment) => {
    const bounded: string[] = [];
    let remaining = segment;
    while (remaining.length > 240) {
      const boundaries = [...remaining.matchAll(/\s+/g)].map((match) => match.index);
      if (!boundaries.length) break;
      const boundary = boundaries.reduce((best, candidate) => Math.abs(candidate - 240) < Math.abs(best - 240) ? candidate : best);
      bounded.push(remaining.slice(0, boundary).trim());
      remaining = remaining.slice(boundary).trim();
    }
    if (remaining) bounded.push(remaining);
    return bounded;
  });
}

function validateAudioHeaders(response: Response): void {
  const invalid = () => new SpeechFailure("INVALID_TTS_AUDIO", "The voice service returned an unsupported audio format. Please try again.");
  const [mime, ...rawParameters] = (response.headers.get("content-type") ?? "").toLowerCase().split(";");
  const parameters = new Map<string, string>();
  for (const parameter of rawParameters) {
    const match = /^\s*([a-z]+)\s*=\s*([a-z0-9]+)\s*$/.exec(parameter);
    if (!match || parameters.has(match[1])) throw invalid();
    parameters.set(match[1], match[2]);
  }
  if (mime.trim() !== "audio/pcm" || parameters.get("rate") !== "24000" || parameters.get("channels") !== "1"
    || parameters.size !== 2 || response.headers.get("x-pcm-format")?.toLowerCase() !== "s16le") throw invalid();
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_SEGMENT_AUDIO_BYTES)) {
    throw new SpeechFailure("TTS_AUDIO_TOO_LARGE", "The voice service returned too much audio. Please try again.");
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? cancelled());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One sidecar request at a time. Pausing this generator backpressures its body. */
async function* synthesize(
  text: string,
  endpoint: URL,
  fetcher: typeof fetch,
  controller: AbortController,
  firstAudioTimeoutMs: number,
  speed: number,
): AsyncGenerator<Uint8Array> {
  const { signal } = controller;
  if (signal.aborted) throw signal.reason ?? cancelled();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let firstAudio = false;
  let bytesRead = 0;
  let pending = new Uint8Array(0);
  const timeout = setTimeout(() => controller.abort(new SpeechFailure("TTS_TIMEOUT", "The local voice took too long to start. Please try again.")), firstAudioTimeoutMs);
  const abort = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const fetching = fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/pcm" },
      // Normal speed sends text alone, so the default sidecar contract is unchanged.
      body: JSON.stringify(speed === 1 ? { text } : { text, speed }),
      signal,
      redirect: "error",
      cache: "no-store",
    });
    // A noncompliant/custom fetch may finish after cancellation; close its body.
    void fetching.then((late) => { if (signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
    response = await abortable(fetching, signal);
    if (!response.ok) throw new SpeechFailure("TTS_UNAVAILABLE", "The local voice service could not respond. Please try again.");
    validateAudioHeaders(response);
    if (!response.body) throw new SpeechFailure("INVALID_TTS_AUDIO", "The voice service returned no audio. Please try again.");
    reader = response.body.getReader();
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (signal.aborted) throw signal.reason ?? cancelled();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_SEGMENT_AUDIO_BYTES) throw new SpeechFailure("TTS_AUDIO_TOO_LARGE", "The voice service returned too much audio. Please try again.");
      if (chunk.value.byteLength === 0) continue;
      const combined = new Uint8Array(pending.byteLength + chunk.value.byteLength);
      combined.set(pending);
      combined.set(chunk.value, pending.byteLength);
      // Examine the first four bytes before treating any payload as raw PCM.
      if (!firstAudio && combined.byteLength < 4) { pending = combined; continue; }
      if (!firstAudio) {
        const signature = String.fromCharCode(...combined.subarray(0, 4));
        if (["RIFF", "RF64", "OggS", "fLaC"].includes(signature)) throw new SpeechFailure("INVALID_TTS_AUDIO", "The voice service returned an unsupported audio format. Please try again.");
        firstAudio = true;
        clearTimeout(timeout);
      }
      const alignedLength = combined.byteLength - combined.byteLength % 2;
      pending = combined.slice(alignedLength);
      for (let offset = 0; offset < alignedLength; offset += MAX_EVENT_AUDIO_BYTES) {
        if (signal.aborted) throw signal.reason ?? cancelled();
        yield combined.subarray(offset, Math.min(offset + MAX_EVENT_AUDIO_BYTES, alignedLength));
      }
    }
    if (!firstAudio || pending.byteLength) throw new SpeechFailure("INVALID_TTS_AUDIO", "The voice service returned incomplete audio. Please try again.");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    } else await response?.body?.cancel().catch(() => {});
  }
}

export function createSpeechResponse(result: TurnResponse, requestSignal: AbortSignal, dependencies: SpeechDependencies = {}, speed: SpeechRate = 1): Response {
  const fetcher = dependencies.fetch ?? fetch;
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  requestSignal.addEventListener("abort", abort, { once: true });
  if (requestSignal.aborted) abort();
  let totalTimeout: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (totalTimeout) clearTimeout(totalTimeout);
    requestSignal.removeEventListener("abort", abort);
  };
  async function* events(): AsyncGenerator<EventPayload> {
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      totalTimeout = setTimeout(() => controller.abort(new SpeechFailure("TTS_TIMEOUT", "The local voice took too long to finish. Please try again.")), dependencies.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
      yield { type: "meta", transcript: result.transcript, action: result.action, ...(result.guidanceContext ? { guidanceContext: result.guidanceContext } : {}) };
      if (result.action === "reply" && result.reply.trim()) {
        const endpoint = localTtsEndpoint(dependencies.baseUrl);
        let totalBytes = 0;
        let segmentId = 0;
        for (const text of speechSegments(result.reply)) {
          if (controller.signal.aborted) throw controller.signal.reason;
          yield { type: "text", segmentId, text };
          for await (const chunk of synthesize(text, endpoint, fetcher, controller, dependencies.firstAudioTimeoutMs ?? DEFAULT_FIRST_AUDIO_TIMEOUT_MS, speed)) {
            totalBytes += chunk.byteLength;
            if (totalBytes > MAX_TURN_AUDIO_BYTES) throw new SpeechFailure("TTS_AUDIO_TOO_LARGE", "The voice service returned too much audio. Please try again.");
            yield { type: "audio", segmentId, data: Buffer.from(chunk).toString("base64"), sampleRate: 24_000 };
          }
          yield { type: "audio", segmentId, data: "", sampleRate: 24_000, end: true };
          segmentId += 1;
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      cleanup();
      yield { type: "done", response: result };
    } catch (error) {
      const safe = failure(error, controller.signal);
      controller.abort(error);
      cleanup();
      yield { type: "error", error: safe };
    } finally { cleanup(); }
  }
  const iterator = events();
  const encoder = new TextEncoder();
  let seq = 0;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      const next = await iterator.next();
      if (closed) return;
      if (next.done) { closed = true; stream.close(); cleanup(); return; }
      stream.enqueue(encoder.encode(`${JSON.stringify({ ...next.value, turnId: result.turnId, seq: seq++ })}\n`));
    },
    cancel() {
      closed = true;
      controller.abort(cancelled());
      cleanup();
      void iterator.return(undefined).catch(() => {});
    },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Content-Type-Options": "nosniff",
    "X-Accel-Buffering": "no",
  } });
}
