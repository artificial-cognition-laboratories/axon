import { err } from "@arcforge/err"
import type { ResidenceT } from "../residence"
import type { RuntimesT } from "../runtimes"
import type { ActivityT } from "../activity"

/** Trace explicit provisioning of execution backends. */
export function Runtime(opts: { runtimes: RuntimesT; activity: ActivityT; residence: ResidenceT }) {
    return { state: opts.runtimes.state,
        install: (id: "onnx" | "llama.cpp" | "transformers") => opts.activity.run("runtime:install", id, () => opts.runtimes.install(id)),
        remove: (id: "onnx" | "llama.cpp" | "transformers") => opts.activity.run("runtime:remove", id, () => {
            if (opts.residence.current.some(model => model.runtime === id)) throw err("MODEL_IN_USE", { detail: `unload the ${id} models before removing their runtime` })
            return opts.runtimes.remove(id)
        }),
    }
}
