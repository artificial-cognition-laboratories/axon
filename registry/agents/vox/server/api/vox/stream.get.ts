import { voxSubscribe } from "../../plugins/telemetry-state"

export default defineEventHandler(event => {
    const stream = createEventStream(event)
    let closed = false
    let unsubscribe = () => {}

    function close(): void {
        if (closed) return
        closed = true
        unsubscribe()
    }

    unsubscribe = voxSubscribe(snapshot => {
        if (closed) return
        stream.push(JSON.stringify(snapshot)).catch(close)
    })
    stream.onClosed(close)
    return stream.send().catch(close)
})
