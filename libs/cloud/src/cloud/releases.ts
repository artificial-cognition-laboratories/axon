import type { HttpClient } from "../platform/http"

export type AxonRelease = {
    package: "@arcforge/axon"
    channel: "latest"
    version: string
}

/** Public software release discovery. */
export function Releases(opts: { http: HttpClient }) {
    return {
        axon(signal?: AbortSignal, options: { fresh?: boolean } = {}): Promise<AxonRelease> {
            const path = options.fresh ? "/api/releases/axon?fresh=1" : "/api/releases/axon"
            return opts.http.get<AxonRelease>(path, signal)
        },
    }
}

export type ReleasesHandle = ReturnType<typeof Releases>
