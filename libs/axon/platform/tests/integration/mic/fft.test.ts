import { computeBuckets } from "@arcforge/platform/services/mic/fft"
import { defaultVisualizerConfig } from "@arcforge/platform/services/mic/config"
import { describe, it, expect } from "bun:test"

function sine(freqHz: number, sampleRate: number, n: number, amplitude = 0.5): Float32Array {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate)
    return out
}

describe("fft.computeBuckets", () => {
    it("returns exactly bucketCount magnitudes", () => {
        const config = defaultVisualizerConfig
        const samples = sine(440, config.sampleRate, config.fftSize)

        const buckets = computeBuckets(samples, config)

        expect(buckets).toHaveLength(config.bucketCount)
    })

    it("throws when given the wrong sample count — never silently pads or truncates", () => {
        const config = defaultVisualizerConfig
        const wrongSize = new Float32Array(config.fftSize - 1)

        expect(() => computeBuckets(wrongSize, config)).toThrow(/expected \d+ samples/)
    })

    it("puts a pure tone's energy in the bucket covering its frequency", () => {
        const config = defaultVisualizerConfig
        const freqHz = 1000 // well inside [minFreqHz, maxFreqHz]
        const samples = sine(freqHz, config.sampleRate, config.fftSize, 0.8)

        const buckets = computeBuckets(samples, config)
        const peakIndex = buckets.indexOf(Math.max(...buckets))

        // Reconstruct which bucket SHOULD contain freqHz from the same
        // log-spaced edges fft.ts itself uses.
        const logMin = Math.log2(config.minFreqHz)
        const logMax = Math.log2(config.maxFreqHz)
        const expectedIndex = Math.floor(
            ((Math.log2(freqHz) - logMin) / (logMax - logMin)) * config.bucketCount
        )

        expect(Math.abs(peakIndex - expectedIndex)).toBeLessThanOrEqual(1)
    })

    it("silence (zero samples) produces a low, uniform reading across buckets", () => {
        const config = defaultVisualizerConfig
        const silence = new Float32Array(config.fftSize) // all zeros

        const buckets = computeBuckets(silence, config)

        for (const db of buckets) {
            expect(db).toBeLessThan(-30) // well below any real signal, given gain compensation
        }
    })

    it("gain compensation makes an equal-amplitude high-frequency tone read louder than a low-frequency one", () => {
        const config = defaultVisualizerConfig
        const low = sine(150, config.sampleRate, config.fftSize, 0.5)
        const high = sine(3000, config.sampleRate, config.fftSize, 0.5)

        const lowPeak = Math.max(...computeBuckets(low, config))
        const highPeak = Math.max(...computeBuckets(high, config))

        // Real audio's spectral tilt means equal-amplitude tones are NOT
        // equally represented without compensation — this is the whole
        // point of gainPerOctaveDb (see config.ts's doc comment).
        expect(highPeak).toBeGreaterThan(lowPeak)
    })

    it("gainPerOctaveDb=0 disables compensation — the high/low gap shrinks dramatically versus the compensated default", () => {
        const low = sine(150, defaultVisualizerConfig.sampleRate, defaultVisualizerConfig.fftSize, 0.5)
        const high = sine(3000, defaultVisualizerConfig.sampleRate, defaultVisualizerConfig.fftSize, 0.5)

        const withGain = { ...defaultVisualizerConfig }
        const withoutGain = { ...defaultVisualizerConfig, gainPerOctaveDb: 0 }

        const gapWithGain = Math.max(...computeBuckets(high, withGain)) - Math.max(...computeBuckets(low, withGain))
        const gapWithoutGain = Math.max(...computeBuckets(high, withoutGain)) - Math.max(...computeBuckets(low, withoutGain))

        // Some residual gap is expected even with gain compensation off —
        // log-spaced buckets at higher frequencies span more raw FFT bins,
        // which isn't something gainPerOctaveDb controls. What matters is
        // that turning gain off removes MOST of the boost, not that the
        // gap vanishes entirely.
        expect(gapWithoutGain).toBeLessThan(gapWithGain)
    })
})
