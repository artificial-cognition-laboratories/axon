/**
 * VisualizerConfig — every tunable knob for the mic's braille waveform,
 * gathered in one file. Getting this to look/feel right is fiddly (window
 * size, bucket count, smoothing, decay) — change values here, not in
 * fft.ts or visualizer.ts, which are meant to stay pure functions of
 * whatever config they're given.
 */
export type VisualizerConfig = {
    /** Must match capture.ts's sox invocation — samples/sec of the raw PCM stream. */
    sampleRate: number
    /** FFT window size in samples. Must be a power of two. Bigger = finer frequency resolution, slower to compute, more latency per frame. */
    fftSize: number
    /** How often (ms) a new frame is sampled, FFT'd, and rendered while the mic is active. */
    tickMs: number
    /** Number of frequency buckets, spaced log-scale across the audible range so bass/mid/treble get roughly even visual weight. Two buckets render per braille character (left/right dot columns are independent buckets) — keep this even. */
    bucketCount: number
    /** Lowest/highest frequency (Hz) folded into buckets — outside this range is discarded. */
    minFreqHz: number
    maxFreqHz: number
    /**
     * A single FFT frame's magnitude per bucket has real statistical
     * variance — it's not a bug, it's how FFT-of-noise behaves — so raw
     * per-tick dB is itself averaged (exponential moving average) BEFORE
     * floor tracking or the gate ever see it. Without this, even the
     * floor tracker chases per-frame noise instead of converging to a
     * stable baseline, and no gate threshold can cleanly separate real
     * quiet signal from noise jitter. 0 = no averaging (raw), 1 = frozen.
     */
    magnitudeSmoothing: number
    /** Exponential smoothing between frames, 0 (no smoothing, raw/jittery) to 1 (frozen). Blends toward the new magnitude each tick. */
    smoothing: number
    /** How much a bucket's visual level falls per tick when input drops (e.g. between words) — keeps silence from cutting bars off instantly. 0 = no decay (instant drop), 1 = never falls on its own. */
    decayPerTick: number
    /**
     * Dynamic range (dB) ABOVE each bucket's own live noise floor mapped to
     * the visual 0..1 range — a bucket reading floor+headroomDb or louder
     * shows full height. There is no fixed minDb: "silence" is whatever
     * that bucket's floor currently is, tracked live (see floorRiseRate/
     * floorFallRate) rather than a hardcoded number, because room noise/
     * mic self-noise varies per machine and even per session (a fan
     * kicking on, etc.) — the same reason real noise gates calibrate to
     * the room instead of assuming a fixed silence level.
     */
    headroomDb: number
    /**
     * Per-bucket floor tracking rate, applied once per tick. The floor
     * chases the current reading: FALLS fast when the signal drops below
     * it (so "someone stopped talking" or "quieter background" is picked
     * up quickly), RISES slowly when the signal sits above it (so a
     * sustained loud moment doesn't get treated as "the new normal" too
     * fast, which would numb the display to real loud speech). Both are
     * 0..1 blend rates per tick, same shape as smoothing/decayPerTick.
     */
    floorFallRate: number
    floorRiseRate: number
    /**
     * Gain compensation, in dB boost per octave above minFreqHz. Real audio
     * (voice, music, nearly everything) carries far more energy in bass
     * than treble — the spectral tilt is a physical property of sound, not
     * a bug — so without this, low buckets visually dominate and the
     * waveform reads as "bass-only" even when there's real energy higher
     * up (the consonants/sibilance that actually carry speech). Each
     * bucket gets +gainPerOctaveDb for every octave its center frequency
     * sits above minFreqHz, applied before the floor-relative mapping.
     */
    gainPerOctaveDb: number
    /**
     * Noise gate — a real, always-jittery noise floor means individual
     * buckets randomly poke a dot or two above 0 even in silence (that's
     * normal FFT-of-noise behavior, not a bug in the floor tracker). Below
     * gateThreshold, level snaps to exactly 0 — the same thing a hardware
     * noise gate does. gateKneeWidth ramps smoothly from 0 up to the real
     * value across [gateThreshold, gateThreshold+gateKneeWidth] instead of
     * a hard on/off step, so a bucket hovering right at the line doesn't
     * flicker between "nothing" and "some" every tick.
     */
    gateThreshold: number
    gateKneeWidth: number
}

export const defaultVisualizerConfig: VisualizerConfig = {
    sampleRate: 16_000,
    fftSize: 1024,
    // 16ms = 60fps — matches VTerm's real render rate. FFT cost is
    // negligible (~0.1ms/call, ~270x headroom even at a much slower 30ms
    // tick), so there's no reason to sample slower than the display can
    // show; every redraw is a fresh sample, not an interpolated one.
    tickMs: 16,
    bucketCount: 112, // 56 rendered characters (2 buckets/char) — double the previous display width
    minFreqHz: 80,
    maxFreqHz: 6_000,
    // ~3-4 ticks (at 16ms) to reach ~90% of a sudden loud onset — still
    // well within "reacts within a syllable" while smoothing away most
    // single-frame noise variance.
    magnitudeSmoothing: 0.6,
    // Low smoothing/decay = fast attack AND fast release — the bar should
    // snap up and back down within a syllable (roughly 80-200ms), not
    // linger across several. Tune by ear from here.
    smoothing: 0.15,
    decayPerTick: 0.5,
    headroomDb: 24,
    // Fall fast (react to quieter conditions quickly), rise slowly (don't
    // let a sustained loud moment redefine "normal" too fast).
    floorFallRate: 0.05,
    floorRiseRate: 0.01,
    gainPerOctaveDb: 6,
    gateThreshold: 0.22,
    gateKneeWidth: 0.1,
}
