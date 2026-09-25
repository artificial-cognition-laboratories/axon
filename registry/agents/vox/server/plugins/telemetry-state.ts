export type VoxPhase =
    | "listening"
    | "speech detected"
    | "transcribing"
    | "thinking"
    | "speaking"
    | "interrupted"
    | "error"

export type VoxTelemetry = {
    phase: VoxPhase
    connectedAt: number
    updatedAt: number
    vad: number
    inputLevel: number
    outputLevel: number
    inputWave: number[]
    outputWave: number[]
    userTranscript: string
    assistantTranscript: string
    timings: {
        asrMs: number | null
        llmMs: number | null
        ttsMs: number | null
        totalMs: number | null
    }
    counts: {
        heardMs: number
        interruptions: number
    }
    error: string | null
}

const MAX_WAVE = 96
const listeners = new Set<(snapshot: VoxTelemetry) => void>()

const telemetry: VoxTelemetry = {
    phase: "listening",
    connectedAt: Date.now(),
    updatedAt: Date.now(),
    vad: 0,
    inputLevel: 0,
    outputLevel: 0,
    inputWave: [],
    outputWave: [],
    userTranscript: "",
    assistantTranscript: "",
    timings: { asrMs: null, llmMs: null, ttsMs: null, totalMs: null },
    counts: { heardMs: 0, interruptions: 0 },
    error: null,
}

function envelope(bytes: Uint8Array, max = 48): number[] {
    if (!bytes.length) return []
    const result: number[] = []
    const bucket = Math.max(1, Math.floor(bytes.length / max))
    for (let i = 0; i < bytes.length && result.length < max; i += bucket) {
        let peak = 0
        for (let j = i; j < Math.min(bytes.length, i + bucket); j += 2) {
            const sample = Math.abs((bytes[j] | ((bytes[j + 1] ?? 0) << 8)) << 16 >> 16) / 32768
            peak = Math.max(peak, sample)
        }
        result.push(Math.min(1, peak))
    }
    return result
}

function dataUriBytes(uri: unknown): Uint8Array | null {
    if (typeof uri !== "string" || !uri.startsWith("data:")) return null
    const comma = uri.indexOf(",")
    if (comma < 0) return null
    try {
        return Uint8Array.from(atob(uri.slice(comma + 1)), c => c.charCodeAt(0))
    } catch {
        return null
    }
}

function publish(): void {
    telemetry.updatedAt = Date.now()
    const snapshot = structuredClone(telemetry)
    for (const listener of listeners) listener(snapshot)
}

export function voxSnapshot(): VoxTelemetry {
    return structuredClone(telemetry)
}

export function voxSubscribe(listener: (snapshot: VoxTelemetry) => void): () => void {
    listeners.add(listener)
    listener(voxSnapshot())
    return () => listeners.delete(listener)
}

export function observeVoxEvent(type: string, event: any): void {
    const data = event?.data ?? event
    const now = Date.now()

    if (type === "cognet:stimulus:audio") {
        const bytes = dataUriBytes(data?.ref?.uri)
        if (bytes) {
            telemetry.inputWave = envelope(bytes)
            telemetry.inputLevel = telemetry.inputWave.reduce((a, b) => a + b, 0) / Math.max(1, telemetry.inputWave.length)
        }
        telemetry.vad = typeof data?.vad === "number" ? data.vad : telemetry.vad
        telemetry.counts.heardMs += Number(data?.durationMs ?? 0)
        // Raw audio alone is not speech; remain listening until the
        // cognet emits a transcript or explicit phase event.
    }

    if (type === "cognet:output:audio") {
        const bytes = dataUriBytes(data?.ref?.uri)
        if (bytes) {
            telemetry.outputWave = envelope(bytes)
            telemetry.outputLevel = telemetry.outputWave.reduce((a, b) => a + b, 0) / Math.max(1, telemetry.outputWave.length)
        }
        telemetry.phase = "speaking"
        telemetry.timings.ttsMs = Number.isFinite(data?.ttsMs) ? data.ttsMs : telemetry.timings.ttsMs
    }

    if (type === "cognet:output:text") {
        telemetry.assistantTranscript = String(data?.content ?? "")
        telemetry.phase = "speaking"
    }

    const text = String(data?.text ?? data?.transcript ?? "")
    if (text && (type.includes("transcript") || type.includes("asr"))) {
        telemetry.userTranscript = text
        telemetry.phase = "thinking"
    }

    if (type.includes("error") || data?.error) {
        telemetry.error = String(data?.error ?? data?.message ?? "unknown error")
        telemetry.phase = "error"
    }

    telemetry.updatedAt = now
    publish()
}

export function setVoxPhase(phase: VoxPhase): void {
    telemetry.phase = phase
    publish()
}
