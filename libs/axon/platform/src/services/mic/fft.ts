import FFT from "fft.js"
import { err } from "@arcforge/err"
import type { VisualizerConfig } from "./config"

/**
 * fft — pure signal math, no process/state. Takes one window of PCM
 * samples and a config, returns one magnitude (dB) per frequency bucket.
 * Fully unit-testable without a real mic: feed it a synthetic sine wave
 * and assert energy lands in the expected bucket.
 */

/** Hann window — tapers the edges of the sample block so the FFT doesn't see a hard cut, which otherwise smears energy across every bucket (spectral leakage). */
function hannWindow(samples: Float32Array): Float32Array {
    const n = samples.length
    const windowed = new Float32Array(n)
    for (let i = 0; i < n; i++) {
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
        windowed[i] = samples[i]! * w
    }
    return windowed
}

/** Log-spaced bucket edges between minFreqHz/maxFreqHz — equal visual weight per octave, not per Hz. */
function bucketEdges(config: VisualizerConfig): number[] {
    const { bucketCount, minFreqHz, maxFreqHz } = config
    const logMin = Math.log2(minFreqHz)
    const logMax = Math.log2(maxFreqHz)
    const edges: number[] = []
    for (let i = 0; i <= bucketCount; i++) {
        edges.push(2 ** (logMin + ((logMax - logMin) * i) / bucketCount))
    }
    return edges
}

/**
 * Runs one FFT over `samples` (must be exactly config.fftSize long — pad
 * or trim before calling) and returns config.bucketCount magnitudes in dB,
 * bucketed log-scale across [minFreqHz, maxFreqHz].
 */
export function computeBuckets(samples: Float32Array, config: VisualizerConfig): number[] {
    const { fftSize, sampleRate, bucketCount } = config
    if (samples.length !== fftSize) {
        throw err("MIC_FFT_SIZE_MISMATCH", { detail: `expected ${fftSize} samples, got ${samples.length}`, context: { expected: fftSize, actual: samples.length } })
    }

    const windowed = hannWindow(samples)
    const fft = new FFT(fftSize)
    const out = fft.createComplexArray()
    fft.realTransform(out, Array.from(windowed))
    fft.completeSpectrum(out)

    // out is interleaved [re, im, re, im, ...]; only the first half is
    // unique for a real input (the rest mirrors it) — bin i's frequency is i * sampleRate / fftSize.
    const bins = fftSize / 2
    const magnitudes = new Float32Array(bins)
    for (let i = 0; i < bins; i++) {
        const re = out[i * 2]!
        const im = out[i * 2 + 1]!
        magnitudes[i] = Math.sqrt(re * re + im * im)
    }

    const edges = bucketEdges(config)
    const buckets = new Array<number>(bucketCount).fill(0)
    const binHz = sampleRate / fftSize

    for (let b = 0; b < bucketCount; b++) {
        const loBin = Math.max(0, Math.floor(edges[b]! / binHz))
        const hiBin = Math.min(bins - 1, Math.ceil(edges[b + 1]! / binHz))
        let sum = 0
        let count = 0
        for (let i = loBin; i <= hiBin; i++) {
            sum += magnitudes[i]!
            count++
        }
        const avg = count > 0 ? sum / count : 0
        // dBFS-ish: 20*log10(magnitude). A genuinely empty bin range (avg=0)
        // would be -Infinity — floor it at a large-but-finite negative
        // instead; the adaptive floor tracker (mic/index.ts) treats this
        // the same as any other very quiet reading.
        const db = avg > 0 ? 20 * Math.log10(avg) : -120

        // Octave-tilt gain compensation: real audio carries far more energy
        // in bass than treble (spectral tilt), so without this the low
        // buckets visually dominate regardless of what's actually being
        // said. Boost grows with how many octaves this bucket's center
        // frequency sits above minFreqHz.
        const center = (edges[b]! + edges[b + 1]!) / 2
        const octavesAboveFloor = Math.max(0, Math.log2(center / config.minFreqHz))
        buckets[b] = db + octavesAboveFloor * config.gainPerOctaveDb
    }

    return buckets
}
