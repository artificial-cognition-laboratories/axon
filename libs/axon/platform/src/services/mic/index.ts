import { Capture } from "./capture"
import { computeBuckets } from "./fft"
import { renderBraille } from "./visualizer"
import { defaultVisualizerConfig, type VisualizerConfig } from "./config"

export type { VisualizerConfig } from "./config"
export { defaultVisualizerConfig } from "./config"

type MicOpts = {
    config?: Partial<VisualizerConfig>
}

/** Noise gate with a smooth knee — see gateThreshold/gateKneeWidth in config.ts. */
function applyGate(level: number, config: VisualizerConfig): number {
    const { gateThreshold, gateKneeWidth } = config
    if (level <= gateThreshold) return 0
    if (level >= gateThreshold + gateKneeWidth) return level
    const t = (level - gateThreshold) / gateKneeWidth
    return level * t
}

/**
 * Mic — the mic capture + visualizer service. Owns its own tick loop
 * (setInterval, framework-agnostic — runs the same whether or not any UI
 * is mounted, usable from the CLI headless too), so useMic() only ever
 * has to re-read a plain value on the same schedule the UI already
 * re-renders on.
 *
 * Per-bucket noise floor tracking, level smoothing, and decay are all
 * frame-to-frame state and live here — fft.ts and visualizer.ts stay pure
 * functions of whatever they're given.
 */
export function Mic(opts: MicOpts = {}) {
    const config: VisualizerConfig = { ...defaultVisualizerConfig, ...opts.config }
    const capture = Capture({ sampleRate: config.sampleRate, windowSamples: config.fftSize })

    // Per-bucket adaptive noise floor (in dB) — "silence" for THIS bucket,
    // on THIS machine, right now. Never a fixed number: room noise and mic
    // self-noise vary per environment, and even within a session (a fan
    // kicking on) — a real noise gate calibrates to the room, it doesn't
    // assume one. Snapped directly to each bucket's first real reading
    // (floorInitialized) rather than starting from an arbitrary guess —
    // starting miles off (e.g. -100dB when real quiet signal reads -20dB)
    // means the floor is playing catch-up for a long time, during which
    // the display would read as maxed-out regardless of actual loudness.
    // Raw per-tick dB, averaged (EMA) before floor tracking ever sees it —
    // a single FFT frame has real statistical variance (that's how
    // FFT-of-noise behaves, not a bug), so without this the floor tracker
    // itself chases per-frame noise instead of converging to a stable
    // baseline, and no gate threshold can then cleanly separate real quiet
    // signal from noise jitter.
    let dbAvg = new Array<number>(config.bucketCount).fill(0)
    let dbAvgInitialized = new Array<boolean>(config.bucketCount).fill(false)
    let floor = new Array<number>(config.bucketCount).fill(0)
    let floorInitialized = new Array<boolean>(config.bucketCount).fill(false)
    let levels = new Array<number>(config.bucketCount).fill(0)
    let waveform = renderBraille(levels)
    let timer: ReturnType<typeof setInterval> | null = null

    function tick(): void {
        const window = capture.currentWindow()
        const raw = computeBuckets(window, config)

        for (let i = 0; i < raw.length; i++) {
            const rawDb = raw[i]!

            if (!dbAvgInitialized[i]) {
                dbAvg[i] = rawDb
                dbAvgInitialized[i] = true
            } else {
                dbAvg[i] = dbAvg[i]! + (rawDb - dbAvg[i]!) * (1 - config.magnitudeSmoothing)
            }
            const db = dbAvg[i]!

            if (!floorInitialized[i]) {
                floor[i] = db
                floorInitialized[i] = true
            } else {
                // Floor chases the current reading: falls fast (quieter
                // conditions get picked up quickly), rises slowly (a
                // sustained loud moment doesn't get treated as "the new
                // normal" too fast, which would numb the display to
                // genuinely loud speech).
                const rate = db < floor[i]! ? config.floorFallRate : config.floorRiseRate
                floor[i] = floor[i]! + (db - floor[i]!) * rate
            }

            const rawTarget = Math.min(1, Math.max(0, (db - floor[i]!) / config.headroomDb))
            const target = applyGate(rawTarget, config)
            const prev = levels[i]!

            // Rise immediately toward louder input (smoothing blends in),
            // decay only (never jump down faster than decayPerTick) when
            // quieter — keeps trailing silence from cutting bars off
            // instantly between words.
            levels[i] = target >= prev
                ? prev + (target - prev) * (1 - config.smoothing)
                : Math.max(target, prev * config.decayPerTick)
        }

        waveform = renderBraille(levels)
    }

    return {
        isActive(): boolean {
            return capture.isCapturing()
        },

        /** Pre-rendered braille waveform, ready to display — recomputed every config.tickMs while active. */
        waveform(): string {
            return waveform
        },

        async start(): Promise<void> {
            await capture.start()
            dbAvg = new Array(config.bucketCount).fill(0)
            dbAvgInitialized = new Array(config.bucketCount).fill(false)
            floor = new Array(config.bucketCount).fill(0)
            floorInitialized = new Array(config.bucketCount).fill(false)
            levels = new Array(config.bucketCount).fill(0)
            waveform = renderBraille(levels)
            timer = setInterval(tick, config.tickMs)
        },

        /** Stops capture and returns the recorded audio, ready for cloud.client.stt.transcribe(). */
        async stop(): Promise<Blob> {
            if (timer) {
                clearInterval(timer)
                timer = null
            }
            const blob = await capture.stop()
            levels = new Array(config.bucketCount).fill(0)
            waveform = renderBraille(levels)
            return blob
        },
    }
}

export type MicT = ReturnType<typeof Mic>
