import { execFileSync } from "node:child_process"

export type SpeakerDevice = {
    id: string
    name: string
    isDefault: boolean
}

/**
 * Best-effort device discovery. The system default remains a valid result
 * even when a platform does not expose a portable enumeration API.
 */
function command(name: string, args: string[]): string | null {
    try {
        return execFileSync(name, args, {
            encoding: "utf8",
            timeout: 2_000,
            stdio: ["ignore", "pipe", "ignore"],
        })
    } catch {
        return null
    }
}

export function listDevices(): SpeakerDevice[] {
    if (process.platform === "linux") {
        const pactl = command("pactl", ["-f", "json", "list", "sinks"])
        if (pactl) {
            try {
                const parsed = JSON.parse(pactl) as {
                    sinks?: Array<{ name?: string; description?: string; "state"?: string }>
                }
                return (parsed.sinks ?? []).map((sink, index) => ({
                    id: sink.name ?? String(index),
                    name: sink.description ?? sink.name ?? `Output ${index + 1}`,
                    isDefault: false,
                }))
            } catch {
                // Fall through to ALSA enumeration.
            }
        }

        const text = command("aplay", ["-L"])
        if (text) {
            return text
                .split("\n")
                .map(line => line.match(/^([A-Za-z0-9_.:-]+)$/)?.[1])
                .filter((id): id is string => Boolean(id))
                .map((id, index) => ({ id, name: id, isDefault: index === 0 }))
        }
    }

    if (process.platform === "darwin") {
        const text = command("system_profiler", ["SPAudioDataType"])
        if (text) {
            return text
                .split("\n")
                .map(line => line.match(/^\s{8}(.+):$/)?.[1])
                .filter((name): name is string => Boolean(name))
                .map((name, index) => ({ id: name, name, isDefault: index === 0 }))
        }
    }

    if (process.platform === "win32") {
        const text = command("powershell", [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_SoundDevice | Select-Object -ExpandProperty Name",
        ])
        if (text) {
            return text
                .split("\n")
                .map(line => line.trim())
                .filter(Boolean)
                .map((name, index) => ({ id: name, name, isDefault: index === 0 }))
        }
    }

    return []
}

export function resolveDevice(selector = "auto"): SpeakerDevice | null {
    if (selector === "auto" || selector === "default") {
        return { id: "default", name: "system default", isDefault: true }
    }

    const devices = listDevices()
    const exact = devices.find(device => device.id === selector)
    if (exact) return exact

    const needle = selector.toLowerCase()
    return devices.find(device => device.name.toLowerCase().includes(needle)) ?? null
}
