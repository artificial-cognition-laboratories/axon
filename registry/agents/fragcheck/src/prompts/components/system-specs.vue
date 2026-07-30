<template>
    <h1>Known system specs</h1>
    <p>
        You already looked at this machine. These are the facts you read directly — speak
        from them without re-checking. Anything marked <code>unknown</code> couldn't be
        read; note it or probe it yourself if it matters.
    </p>
    <ul>
        <li><strong>Host</strong>: {{ host }}</li>
        <li><strong>Distro</strong>: {{ distro }}</li>
        <li><strong>Kernel</strong>: {{ kernel }}</li>
        <li><strong>CPU</strong>: {{ cpu }} ({{ cores }} threads)</li>
        <li><strong>Memory</strong>: {{ ram }} GB</li>
        <li><strong>GPU</strong>: {{ gpu }}</li>
        <li><strong>GPU driver</strong>: {{ driver }}</li>
        <li><strong>Display server</strong>: {{ session }} · desktop {{ desktop }}</li>
        <li><strong>CPU governor</strong>: {{ governor }}</li>
        <li><strong>Tooling present</strong>: {{ tooling }}</li>
    </ul>
</template>

<script setup lang="ts">
// Precompiled at boot render: gather the cheap, safe, read-only facts a
// specialist clocks at a glance, and interpolate them straight into the system
// message. The agent wakes knowing the rig with zero tool calls — the deeper,
// interpretive checks (Vulkan validity, driver currency, applying fixes) are
// left to the agent during an audit. Dynamic import() is required here: static
// imports don't bind in the render context.
const os = await import("node:os")
const { readFileSync } = await import("node:fs")
const { execSync } = await import("node:child_process")

function sh(cmd: string): string {
    try {
        return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).trim()
    } catch {
        return ""
    }
}
function read(path: string): string {
    try {
        return readFileSync(path, "utf8").trim()
    } catch {
        return ""
    }
}
const or = (v: string, fallback = "unknown") => v || fallback

const host = or(os.hostname())
const kernel = or(os.release())
const cpu = or(os.cpus()[0]?.model?.replace(/\s+/g, " ").trim() ?? "")
const cores = os.cpus().length || "unknown"
const ram = Math.round(os.totalmem() / 1e9) || "unknown"

const distro = or((read("/etc/os-release").match(/PRETTY_NAME="([^"]+)"/) ?? [])[1] ?? "")

// GPU line from lspci — take the description after the last colon.
const gpu = or(
    sh("sh -c \"lspci 2>/dev/null | grep -iE 'vga|3d|display' | head -1\"").split(":").pop()?.trim() ?? ""
)

// Loaded GPU kernel module is the honest signal of which driver is active.
const driverMod = ["nvidia", "amdgpu", "i915", "xe", "nouveau", "radeon"].find(
    m => sh(`sh -c "lsmod 2>/dev/null | grep -qw ${m} && echo y"`) === "y"
)
const nvidiaVer = driverMod === "nvidia" ? sh("nvidia-smi --query-gpu=driver_version --format=csv,noheader") : ""
const driver = or(driverMod ? `${driverMod}${nvidiaVer ? ` ${nvidiaVer}` : ""}` : "")

const session = or(process.env.XDG_SESSION_TYPE ?? "")
const desktop = or(process.env.XDG_CURRENT_DESKTOP ?? "")
const governor = or(read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"))

const tooling = or(
    ["gamemoded", "mangohud", "vulkaninfo", "steam"]
        .filter(c => sh(`command -v ${c}`))
        .join(", "),
    "none detected"
)
</script>
