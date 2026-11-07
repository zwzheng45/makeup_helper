/* Mono PCM playback. The queue contains source-rate (24 kHz) samples. */
class MirrorPcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.playbackId = options.processorOptions.playbackId;
    this.capacity = 48000;
    this.buffer = new Float32Array(this.capacity);
    this.writePosition = 0;
    this.readPosition = 0;
    this.reportedPosition = 0;
    this.segments = [];
    this.buffering = true;
    this.finished = false;
    this.stopped = false;
    this.drained = false;
    this.port.onmessage = ({ data }) => this.receive(data);
  }

  send(type, fields = {}) {
    this.port.postMessage({ type, playbackId: this.playbackId, ...fields });
  }

  receive(message) {
    if (message.playbackId !== this.playbackId || this.stopped) return;
    if (message.type === "stop") {
      this.stopped = true;
      this.segments = [];
      this.readPosition = this.writePosition;
      this.send("stopped");
      return;
    }
    if (message.type === "finish") { this.finished = true; return; }
    if (message.type !== "append" || this.finished) return;
    const samples = message.samples;
    if (!(samples instanceof Float32Array) || this.writePosition - Math.floor(this.readPosition) + samples.length > this.capacity) {
      this.send("error", { message: "The audio playback buffer overflowed." });
      this.stopped = true;
      return;
    }
    let segment = this.segments.at(-1);
    if (!segment || segment.id !== message.segmentId) {
      if (segment && segment.end === undefined) {
        this.send("error", { message: "Audio segments arrived out of order." });
        this.stopped = true;
        return;
      }
      segment = { id: message.segmentId, start: this.writePosition, end: undefined, started: false };
      this.segments.push(segment);
    }
    if (segment.end !== undefined) {
      this.send("error", { message: "Audio arrived after its sentence ended." });
      this.stopped = true;
      return;
    }
    for (let i = 0; i < samples.length; i++) this.buffer[this.writePosition++ % this.capacity] = samples[i];
    if (message.end) segment.end = this.writePosition;
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output || this.stopped) return !this.stopped;
    output.fill(0);
    const available = this.writePosition - this.readPosition;
    if (this.buffering && (available >= 2880 || this.segments.some((segment) => segment.end !== undefined) || this.finished)) this.buffering = false;
    if (!this.buffering) {
      for (let i = 0; i < output.length; i++) {
        if (this.readPosition >= this.writePosition) { this.buffering = !this.finished; break; }
        const segment = this.segments[0];
        if (segment && !segment.started) {
          segment.started = true;
          this.send("started", { segmentId: segment.id });
        }
        const index = Math.floor(this.readPosition);
        const fraction = this.readPosition - index;
        const first = this.buffer[index % this.capacity];
        const second = index + 1 < this.writePosition ? this.buffer[(index + 1) % this.capacity] : first;
        output[i] = first + (second - first) * fraction;
        this.readPosition = Math.min(this.writePosition, this.readPosition + 24000 / sampleRate);
        while (this.segments[0]?.end !== undefined && this.readPosition >= this.segments[0].end) {
          const completed = this.segments.shift();
          this.send("completed", { segmentId: completed.id });
        }
      }
    }
    // An empty end marker can arrive after all preceding samples were played.
    while (this.segments[0]?.end !== undefined && this.readPosition >= this.segments[0].end) {
      const completed = this.segments.shift();
      this.send("completed", { segmentId: completed.id });
    }
    const consumed = Math.floor(this.readPosition) - this.reportedPosition;
    if (consumed >= 480 || (consumed > 0 && this.readPosition === this.writePosition)) {
      this.reportedPosition += consumed;
      this.send("progress", { consumed });
    }
    if (this.finished && this.readPosition === this.writePosition && this.segments.length === 0 && !this.drained) {
      this.drained = true;
      this.send("drained");
    }
    return !this.drained;
  }
}

registerProcessor("mirror-pcm-player", MirrorPcmPlayer);
