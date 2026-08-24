import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * devices — what can be captured from, and which one `auto` means.
 *
 * HARDER THAN AUDIO, and worth saying why. ALSA has `default`: the OS
 * already routes a microphone, so a mic module can defer to a decision the
 * user made in their sound settings. V4L2 has no equivalent — there is no
 * `/dev/video-default` — so `auto` here must genuinely choose, and choosing
 * badly is easy:
 *
 *   /dev/video0  HD Pro Webcam C920   ← the camera
 *   /dev/video1  HD Pro Webcam C920   ← its metadata node, opens fine,
 *                                       yields no frames, same name
 *
 * "First /dev/video*" picks correctly here and picks a metadata node on any
 * machine whose enumeration differs. So existence is not enough: a device
 * is a camera only if it REPORTS A CAPTURE FORMAT, which is what probing
 * establishes and what sysfs does not expose.
 */

const V4L = "/sys/class/video4linux"

export type CameraDevice = {
    /** Device path — "/dev/video0". */
    path: string
    /** Human name from the driver — "HD Pro Webcam C920". */
    name: string
}

function read(path: string): string | null {
    try {
        return readFileSync(path, "utf-8").trim()
    } catch {
        return null
    }
}

/**
 * Every video4linux node, in enumeration order.
 *
 * Includes metadata and output nodes — this is enumeration, not
 * qualification. `probe()` is what decides whether a node is a camera.
 */
export function listNodes(): CameraDevice[] {
    if (!existsSync(V4L)) return []

    return readdirSync(V4L)
        .filter(entry => /^video\d+$/.test(entry))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
        .map(entry => ({
            path: `/dev/${entry}`,
            name: read(join(V4L, entry, "name")) ?? entry,
        }))
        .filter(device => existsSync(device.path))
}

/**
 * Whether a node can actually deliver video.
 *
 * Asks the device to list its formats: a capture device reports at least
 * one, a metadata or output node reports none. Cheap, and it does not open
 * a stream — which matters because v4l2 access is EXCLUSIVE, and probing by
 * grabbing a frame would fight whatever is already using the camera.
 */
export async function probe(path: string): Promise<boolean> {
    if (!Bun.which("ffmpeg")) return false

    const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-f", "v4l2", "-list_formats", "all", "-i", path], {
        stdout: "ignore",
        stderr: "pipe",
    })

    // A driver can hang rather than answer; boot must not wait on it.
    const timeout = new Promise<string>(resolve => setTimeout(() => { proc.kill(); resolve("") }, 4000))
    const text = await Promise.race([new Response(proc.stderr).text(), timeout])

    // ffmpeg prints formats to stderr and then exits non-zero (it was given
    // no output), so the listing itself is the signal rather than the code.
    return /\b(Raw|Compressed)\s*:/.test(text)
}

/**
 * Resolve a configured selector to a real device.
 *
 *   "auto"          — the first node that reports a capture format
 *   "C920"          — by NAME, case-insensitive substring
 *   "/dev/video2"   — exactly this path
 *
 * Name matching is the form worth reaching for. `/dev/video0` is an
 * accident of enumeration order and moves when devices are replugged or the
 * machine reboots; "C920" is what the camera calls itself and does not. The
 * same reasoning that makes a screen `DP-2` rather than a pixel rectangle.
 *
 * Returns null when nothing qualifies, which is ordinary on a machine with
 * no camera — the caller reports it and the agent runs without sight.
 */
export async function resolveDevice(selector: string): Promise<CameraDevice | null> {
    const nodes = listNodes()
    if (nodes.length === 0) return null

    if (selector !== "auto") {
        // An explicit path is taken at its word: the user named a device,
        // and refusing it because a probe disagreed would be the module
        // overruling someone who knows their own hardware.
        if (selector.startsWith("/dev/")) {
            const known = nodes.find(node => node.path === selector)
            return { path: selector, name: known?.name ?? selector }
        }

        const needle = selector.toLowerCase()
        const matches = nodes.filter(node => node.name.toLowerCase().includes(needle))
        // Several nodes share one camera's name (capture + metadata), so a
        // name match still has to find the one that captures.
        for (const match of matches) {
            if (await probe(match.path)) return match
        }
        return null
    }

    for (const node of nodes) {
        if (await probe(node.path)) return node
    }
    return null
}
