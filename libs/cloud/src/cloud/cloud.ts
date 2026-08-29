import type { HttpClient } from "../platform/http"
import { Agents } from "./agents"
import { Stt } from "./stt"
import { Engine } from "./engine"
import { Releases } from "./releases"

type CloudOpts = {
    http: HttpClient
}

/** Platform services — managed inference, speech-to-text, deployed-agent attach. */
export function Cloud(opts: CloudOpts) {
    const engine = Engine({ http: opts.http })
    const stt = Stt({ http: opts.http })
    const releases = Releases({ http: opts.http })
    const agents = Agents({ http: opts.http })

    return {
        engine: engine,
        stt: stt,
        releases: releases,
        agents: agents,
    }
}

export type CloudHandle = ReturnType<typeof Cloud>
