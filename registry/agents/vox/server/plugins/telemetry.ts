import { observeVoxEvent } from "./telemetry-state"

export default defineAxonPlugin(axon => {
    const eventTypes = [
        "cognet:stimulus:audio",
        "cognet:output:audio",
        "cognet:output:text",
        "cognet:transcript",
        "cognet:asr",
        "cognet:error",
    ]

    for (const type of eventTypes) {
        axon.on(type, event => observeVoxEvent(type, event))
    }
})
