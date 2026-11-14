import { home } from "../../../src/home"
import { Decoder, type Decoded } from "../../../src/telemetry"

/** Every event a session's telemetry ring holds, oldest first. */
export async function ring(root: string, sessionId: string): Promise<Decoded[]> {
    const events: Decoded[] = []
    for (const segment of home.data.telemetry.existing(root, sessionId)) {
        const bytes = await home.data.telemetry.read(segment.file)
        const { events: found, used } = Decoder({ numbers: "array" }).decode(bytes)
        if (used !== bytes.length) throw new Error(`${segment.file}: ${bytes.length - used} bytes did not decode`)
        events.push(...found)
    }
    return events
}
