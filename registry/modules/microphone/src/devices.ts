/**
 * devices — what can be recorded from, and which one `auto` means.
 *
 * THE POINT OF `auto`. A user installs this module and starts talking; they
 * should not have to learn ALSA's addressing scheme to be heard. So the
 * module resolves a device itself, and the only thing it owes the user in
 * return is to SAY which one it picked — `auto` is only trustworthy when it
 * is legible after the fact.
 *
 * `default` is preferred over any specific card because the desktop already
 * has an answer: on a modern Linux system it routes through PipeWire or
 * PulseAudio to whatever the user chose in their sound settings. Picking a
 * card ourselves would silently override a decision the user already made,
 * which is exactly the kind of "helpful" a body has no business being.
 */

export type CaptureDevice = {
    /** ALSA device string — "default", "hw:1,0". */
    id: string
    /** Human name, so a log line says something a user recognises. */
    name: string
}

/**
 * Hardware capture devices, from `arecord -l`.
 *
 * Parsed rather than taken from `-L` (the PCM list) because that one is
 * mostly plugin aliases — `lavrate`, `speexrate`, `upmix` — which are not
 * devices anyone means. `-l` is the actual sound cards.
 */
export async function listDevices(): Promise<CaptureDevice[]> {
    if (!Bun.which("arecord")) return []

    const proc = Bun.spawn(["arecord", "-l"], { stdout: "pipe", stderr: "pipe" })
    const text = await new Response(proc.stdout).text()
    await proc.exited

    const devices: CaptureDevice[] = []
    for (const line of text.split("\n")) {
        // "card 1: Device [USB PnP Audio Device], device 0: USB Audio [USB Audio]"
        const match = /^card (\d+): \S+ \[([^\]]+)\], device (\d+):/.exec(line.trim())
        if (!match) continue
        devices.push({
            id: `hw:${match[1]},${match[3]}`,
            name: match[2]!,
        })
    }
    return devices
}

/**
 * Whether a device can actually be opened.
 *
 * Enumeration is not availability: a card can be listed and busy, or listed
 * and routed elsewhere. A one-second probe is cheap next to discovering at
 * runtime that the chosen mic yields silence forever.
 */
export async function canOpen(device: string, rate: number): Promise<boolean> {
    if (!Bun.which("arecord")) return false

    const proc = Bun.spawn(
        ["arecord", "-D", device, "-d", "1", "-f", "S16_LE", "-r", String(rate), "-c", "1", "-t", "raw"],
        { stdout: "ignore", stderr: "ignore" },
    )
    // A device that opens produces bytes immediately; one that cannot fails
    // fast. The timeout guards against a driver that hangs rather than
    // returning, which would otherwise stall boot.
    const timeout = new Promise<number>(resolve => setTimeout(() => { proc.kill(); resolve(1) }, 2000))
    const code = await Promise.race([proc.exited, timeout])
    return code === 0
}

/**
 * Resolve a configured selector to a real device.
 *
 *   "auto"    — the system default, then the first card that opens
 *   "default" — the system default, and nothing else
 *   "hw:1,0"  — exactly this, and fail loudly if it will not open
 *
 * Returns null when nothing can be opened, which is an ordinary state on a
 * machine with no microphone. The caller reports it and the agent runs
 * without hearing — an honest partial body, never a boot failure.
 */
export async function resolveDevice(selector: string, rate: number): Promise<CaptureDevice | null> {
    if (selector !== "auto") {
        const known = (await listDevices()).find(device => device.id === selector)
        return { id: selector, name: known?.name ?? selector }
    }

    // The desktop's own choice first — it already routes to whatever the
    // user selected in their sound settings.
    if (await canOpen("default", rate)) {
        const devices = await listDevices()
        return {
            id: "default",
            // Named for what it routes to when that is knowable, so the log
            // line means something. One card means no ambiguity to report.
            name: devices.length === 1 ? `default → ${devices[0]!.name}` : "default",
        }
    }

    // No routing daemon, or it refused. Fall back to real hardware, in the
    // order the kernel enumerated it.
    for (const device of await listDevices()) {
        if (await canOpen(device.id, rate)) return device
    }

    return null
}
