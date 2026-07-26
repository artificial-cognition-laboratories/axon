/**
 * Raw Telegram Bot API client.
 *
 * No dependencies — thin fetch wrapper over the Bot API REST interface.
 * All methods throw on API errors. Never swallows.
 *
 * https://core.telegram.org/bots/api
 */

let _token: string | null = null

export function token(): string {
    if (!_token) {
        const t = process.env.TELEGRAM_BOT_TOKEN
        if (!t) throw new Error(
            "TELEGRAM_BOT_TOKEN is not set.\n" +
            "Create a bot with @BotFather on Telegram and add the token to your .env."
        )
        _token = t
    }
    return _token
}

export function resetClient(): void {
    _token = null
}

const BASE = "https://api.telegram.org"

export async function api<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = `${BASE}/bot${token()}/${method}`

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
    })

    const json = await res.json() as { ok: boolean; result?: T; description?: string; error_code?: number }

    if (!json.ok) {
        throw new Error(`Telegram API error [${method}]: ${json.description ?? "unknown"} (code ${json.error_code ?? res.status})`)
    }

    return json.result as T
}

/** Upload a file as multipart/form-data. Used for sendDocument, sendPhoto etc. */
export async function apiUpload<T = unknown>(method: string, fields: Record<string, string>, file: { name: string; data: Uint8Array; mimeType: string }): Promise<T> {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    form.append("document", new Blob([file.data], { type: file.mimeType }), file.name)

    const res = await fetch(`${BASE}/bot${token()}/${method}`, { method: "POST", body: form })
    const json = await res.json() as { ok: boolean; result?: T; description?: string; error_code?: number }

    if (!json.ok) {
        throw new Error(`Telegram API error [${method}]: ${json.description ?? "unknown"} (code ${json.error_code ?? res.status})`)
    }

    return json.result as T
}
