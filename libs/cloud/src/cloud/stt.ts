import type { HttpClient } from "../platform/http"
import { record, str } from "../platform/parse"

type SttOpts = {
    http: HttpClient
}

type TranscribeOpts = {
    /** Container format — names the upload for the backend. Defaults to wav. */
    format?: "wav" | "webm"
    /** MIME type applied when the blob carries none. Defaults to audio/wav. */
    mimeType?: string
}

/**
 * Speech-to-text — audio in, transcript out. Billed per transcription
 * server-side; an unbillable call fails there, loudly.
 */
export function Stt(opts: SttOpts) {
    return {
        async transcribe(audio: Blob, transcribeOpts?: TranscribeOpts): Promise<{ text: string }> {
            const mimeType = transcribeOpts?.mimeType ?? "audio/wav"
            const format = transcribeOpts?.format ?? "wav"
            const typed = audio.type ? audio : new Blob([audio], { type: mimeType })

            const form = new FormData()
            form.append("audio", typed, `audio.${format}`)
            form.append("format", format)

            const raw = record(await opts.http.form("/api/user/stt/transcribe", form), "transcription")
            return { text: str(raw, "text") }
        },
    }
}

export type SttHandle = ReturnType<typeof Stt>
