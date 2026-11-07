import { afterEach, describe, expect, it, vi } from "vitest";
import { MirrorCues } from "../../lib/client/cues";

function context() {
  const oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null; frequency: { setValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; type: string }[] = [];
  const gains: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; gain: { setValueCurveAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn>; setValueAtTime: ReturnType<typeof vi.fn> } }[] = [];
  const value = {
    currentTime: 10, state: "running", destination: {},
    createOscillator: () => {
      const oscillator = { start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: null, frequency: { setValueAtTime: vi.fn() }, connect: vi.fn((gain) => gain), type: "" };
      oscillators.push(oscillator);
      return oscillator;
    },
    createGain: () => {
      const gain = { connect: vi.fn(), disconnect: vi.fn(), gain: { setValueCurveAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn() } };
      gains.push(gain);
      return gain;
    },
  };
  return { value, oscillators, gains, cues: new MirrorCues(value as unknown as AudioContext) };
}

afterEach(() => vi.useRealTimers());

describe("voice conversation earcons", () => {
  it("confirms capture with two short quiet tones connected only to the speaker", () => {
    const test = context();
    test.cues.captured();
    expect(test.oscillators).toHaveLength(2);
    expect(test.oscillators[0].start).toHaveBeenCalledWith(10);
    expect(test.oscillators[1].stop).toHaveBeenCalledWith(10.16);
    for (const gain of test.gains) {
      expect(gain.connect).toHaveBeenCalledWith(test.value.destination);
      const curve = gain.gain.setValueCurveAtTime.mock.calls[0][0] as Float32Array;
      expect(Math.max(...curve)).toBeLessThanOrEqual(0.014);
      expect(curve[0]).toBe(0);
    }
    test.cues.stop();
  });

  it("waits 700 ms before a gentle processing pulse and leaves 2.8 seconds between pulses", () => {
    vi.useFakeTimers();
    const test = context();
    test.cues.processing();
    vi.advanceTimersByTime(699);
    expect(test.oscillators).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(test.oscillators).toHaveLength(2);
    vi.advanceTimersByTime(2799);
    expect(test.oscillators).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(test.oscillators).toHaveLength(4);
    test.cues.stop();
  });

  it("silences existing tones and cancels future pulses immediately and idempotently", () => {
    vi.useFakeTimers();
    const test = context();
    test.cues.processing();
    test.cues.captured();
    vi.advanceTimersByTime(700);
    const count = test.oscillators.length;
    test.cues.stop();
    expect(vi.getTimerCount()).toBe(0);
    for (const oscillator of test.oscillators) expect(oscillator.stop).toHaveBeenLastCalledWith();
    for (const gain of test.gains) expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 10);
    vi.advanceTimersByTime(20000);
    expect(test.oscillators).toHaveLength(count);
    test.cues.stop();
  });

  it("restarting processing replaces its timer and closed contexts stay silent", () => {
    vi.useFakeTimers();
    const test = context();
    test.cues.processing();
    test.cues.processing();
    expect(vi.getTimerCount()).toBe(1);
    test.value.state = "closed";
    vi.advanceTimersByTime(700);
    test.cues.captured();
    expect(test.oscillators).toHaveLength(0);
    test.cues.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
