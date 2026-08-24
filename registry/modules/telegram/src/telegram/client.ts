/**
 * Raw Telegram Bot API transport.
 *
 * Owns one concern: turning a Bot API method call into a result or a loud
 * error. Knows nothing about stimuli, channels, or the agent.
 *
 * https://core.telegram.org/bots/api
 */

export type TelegramClientOpts = {
    /** Bot token from @BotFather. */
    token: string
}

export type TelegramClientT = ReturnType<typeof TelegramClient>

const BASE = "https://api.telegram.org"

export function TelegramClient(opts: TelegramClientOpts) {
    const base = `${BASE}/bot${opts.token}`

    /** Unwrap the Bot API's { ok, result } envelope, throwing on ok:false. */
    function unwrap<T>(json: TelegramResponse<T>, method: string, status: number): T {
        if (!json.ok) {
            throw new Error(
                `Telegram API error [${method}]: ${json.description ?? "unknown"} (code ${json.error_code ?? status})`,
            )
        }
        return json.result as T
    }

    return {
        /** Call a Bot API method with a JSON body. */
        async call<T = unknown>(method: string, params: Record<string, unknown> = {}, init?: { signal?: AbortSignal }): Promise<T> {
            const res = await fetch(`${base}/${method}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
                ...(init?.signal ? { signal: init.signal } : {}),
            })
            return unwrap(await res.json() as TelegramResponse<T>, method, res.status)
        },

        /**
         * Call a Bot API method with one attached file (multipart).
         *
         * `field` is the Bot API's parameter name for the upload and differs
         * per method — `document` for sendDocument, `photo` for sendPhoto.
         */
        async upload<T = unknown>(
            method: string,
            field: string,
            fields: Record<string, string>,
            file: { name: string; data: Uint8Array; mimeType: string },
        ): Promise<T> {
            const form = new FormData()
            for (const [key, value] of Object.entries(fields)) form.append(key, value)
            form.append(field, new Blob([file.data as BlobPart], { type: file.mimeType }), file.name)

            const res = await fetch(`${base}/${method}`, { method: "POST", body: form })
            return unwrap(await res.json() as TelegramResponse<T>, method, res.status)
        },
    }
}

type TelegramResponse<T> = {
    ok: boolean
    result?: T
    description?: string
    error_code?: number
}
