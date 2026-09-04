import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { DaemonPaths } from "../../types/index"

/**
 * Where one user's daemon lives.
 *
 * ── Per user, not per machine ───────────────────────────────────────────────
 *
 * One daemon per user, keyed under that user's `~/.axon`. Two people sharing a
 * box get two daemons, which is right for the credential — axond holds a cloud
 * session, and a shared one would mean either a shared login or a broker
 * nobody has designed.
 *
 * The MACHINE's resources are still read across every store root (see the
 * reservation protocol), so two daemons on one box still see each other's
 * holds. Identity is per user; the GPU is not.
 *
 * ── Per DISTRIBUTION, too ───────────────────────────────────────────────────
 *
 * An installed CLI uses `~/.axon`; a source checkout uses `~/.axon-dev`. That
 * split is the platform's (see `storeRoot`), and the reason it exists there is
 * the reason it belongs here: an installed app and a source checkout must not
 * share state, or working on one silently re-points the other.
 *
 * This was hardcoded to `~/.axon` and it hid a whole class of bug. A developer
 * whose source daemon was already listening would see the INSTALLED CLI
 * connect to it and conclude the published daemon worked — when the published
 * boot path had never run. The one thing the split has to prove is precisely
 * the thing a shared socket cannot distinguish.
 *
 * Resolved from `NODE_ENV` rather than by importing the platform: the bundler
 * inlines `process.env.NODE_ENV = "production"` when it packs the CLI, so the
 * published binary answers "production" with no dependency, and axond stays a
 * leaf. It is the same signal `storeRoot` reads, not a second opinion.
 *
 * ── One daemon, not two ─────────────────────────────────────────────────────
 *
 * Distinct PATHS, not a licence to run both at once. The daemon exists to be
 * the single arbiter of this machine's GPU, and two live daemons would each
 * believe they owned it. Resource holds are still read across every store root
 * (see the reservation protocol), so whichever one is up sees every hold on
 * the box.
 *
 * `AXON_DAEMON_DIR` overrides the location — what a test points at a scratch
 * directory, and the seam that lets two daemons run side by side without
 * either believing it owns the other's socket.
 */
/**
 * Which build this is.
 *
 * One derivation, read from `NODE_ENV` for the reason above — the bundler
 * inlines it when the CLI is packed, so the published binary answers
 * "production" with no dependency on the platform. Everything in the daemon
 * that has to agree with the store about WHICH store reads this, rather than
 * repeating the comparison and drifting.
 */
export function distribution(): "production" | "development" {
    return process.env.NODE_ENV === "production" ? "production" : "development"
}

export function daemonPaths(root?: string): DaemonPaths {
    const store = distribution() === "production" ? ".axon" : ".axon-dev"
    const base = root ?? process.env.AXON_DAEMON_DIR ?? join(homedir(), store, "cache", "daemon")
    return {
        root: base,
        socket: join(base, "axond.sock"),
        pid: join(base, "axond.pid"),
        log: join(base, "axond.log"),
    }
}

/**
 * Where the `axon` CLI actually is, as an absolute path.
 *
 * ── Why Bun.which is not enough ─────────────────────────────────────────────
 *
 * Anything the DESKTOP launches — a systemd user unit, a compositor keybind —
 * gets the graphical session's PATH, not the user's shell PATH. Measured on
 * Omarchy, a Hyprland `exec` sees:
 *
 *   /usr/share/omarchy/bin:~/.local/share/mise/shims:/usr/local/sbin:
 *   /usr/local/bin:/usr/bin:~/.local/bin:...
 *
 * The CLI installs to `~/.cache/.bun/bin`, which is on none of that. So a
 * keybind naming a bare `axon` silently resolves to nothing and the keypress
 * does exactly what a typo would: no output, no error, no clue. That failure
 * has now been hit three separate ways in this codebase — the boot unit's
 * ExecStart, the same unit's interpreter, and a dictation keybind — which is
 * why the answer lives in ONE function instead of a fourth guess.
 *
 * Known locations are checked directly rather than through a shell, in the
 * order an install would have used them. Null when it genuinely is not here,
 * so a caller reports "the CLI is not installed" instead of writing a command
 * nothing can run.
 */
export function cliPath(): string | null {
    const home = homedir()

    /*
     * A source daemon names the source CLI.
     *
     * `axonl` and `axon` are deliberately different stores — a keybind wired to
     * the installed binary while a SOURCE daemon holds the microphone talks to
     * a socket under `~/.axon` that nothing is listening on. Same split
     * `daemonPaths()` keeps, for the same reason: the two halves must not
     * silently reach each other.
     */
    const binary = distribution() === "production" ? "axon" : "axonl"

    const candidates = [
        join(home, ".local", "bin", binary),
        join(home, ".cache", ".bun", "bin", binary),
        join(home, ".bun", "bin", binary),
        `/usr/local/bin/${binary}`,
        `/usr/bin/${binary}`,
    ]
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate
    }
    // Last: whatever THIS process can see. Right when the daemon was started
    // from a shell, and the reason this is not first is that it is exactly the
    // answer that varies with who launched us.
    return Bun.which(binary)
}

/**
 * The directories a desktop-launched Axon needs on PATH.
 *
 * The CLI is a script with a `#!/usr/bin/env bun` shebang, so finding the CLI
 * is only half the problem — the INTERPRETER has to be findable too, and a
 * graphical session's PATH contains neither. Resolving the binary and stopping
 * there produces `env: 'bun': No such file or directory`, which is what a
 * systemd unit and a Hyprland keybind both hit.
 */
export function runtimePath(): string {
    const home = homedir()
    const interpreter = Bun.which("bun")
    const candidates = [
        ...(interpreter ? [dirname(interpreter)] : []),
        join(home, ".bun", "bin"),
        join(home, ".cache", ".bun", "bin"),
        join(home, ".local", "bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ]
    return candidates.filter((entry, index) => candidates.indexOf(entry) === index).join(":")
}

/**
 * A command line the DESKTOP can actually run — the one answer to a trap this
 * codebase has now hit four separate ways.
 *
 * Every one of these was the same bug wearing different clothes:
 *
 *   1. `ExecStart=axon daemon serve` — systemd does not search the user's
 *      PATH, so a CLI under `$HOME` was never found (203/EXEC).
 *   2. The same unit with an absolute path — found the CLI, then failed with
 *      `env: 'bun': No such file or directory`, because the shebang's
 *      interpreter is not on a service's PATH either. 671 restarts.
 *   3. A dictation keybind naming a bare `axon` — a Hyprland exec gets the
 *      graphical session's PATH, which has no `~/.cache/.bun/bin`. Silent: a
 *      keypress did exactly what a typo does.
 *   4. The same keybind with an absolute path — found the CLI, and hit (2)
 *      again through the shebang.
 *
 * The pattern is that "it works when I check it" is worthless here: every
 * check runs in the user's shell, and nothing the desktop launches has that
 * shell's environment. So this builds the whole line — PATH exported, binary
 * resolved, operands appended — and every desktop entry point uses it rather
 * than assembling its own and rediscovering the same two failures.
 *
 * Returns null when the CLI genuinely is not installed, so a caller reports
 * that instead of writing a command nothing can run.
 */
/**
 * A shell line that calls the daemon DIRECTLY, with no CLI in the way.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A dictation keypress was costing 650ms, and none of it was the work: the
 * verb is "write one line to a socket", and it was loading a 25MB CLI bundle
 * to do it. Measured, the built binary is no faster than the source one —
 * `axon --version` is ~650ms either way — so this was not a development
 * artifact, it was what every user paid on every press, twice per dictation.
 *
 * The daemon speaks HTTP over its unix socket, so `curl --unix-socket` IS the
 * protocol, not a workaround. Measured at 5ms against the live daemon: 130x,
 * for less code than the thing it replaces.
 *
 * ── Why curl ────────────────────────────────────────────────────────────────
 *
 * It is a small C binary that starts in about two milliseconds and is already
 * a hard dependency of Axon — the installer is a `curl | sh`. Shipping a
 * purpose-built minimal client would have meant a new entrypoint in the bundle,
 * a new bin, and a new thing to keep on PATH, to arrive at the same 5ms.
 *
 * The cost is that a keypress reports nothing when it fails. That is acceptable
 * here and only here: a keypress has no console to fail into, and the panel's
 * own trouble line is what explains a daemon that is not running.
 */
export function socketCommand(path: readonly string[], arg?: unknown): string {
    const body = JSON.stringify(arg === undefined ? { path: path } : { path: path, arg: arg })
    const { socket } = daemonPaths()
    return `curl -s -o /dev/null --unix-socket '${socket}' `
        + `-X POST -H 'Content-Type: application/json' `
        + `-d '${body.replace(/'/g, "'\\''")}' http://localhost/`
}

export function desktopCommand(args: readonly string[]): string | null {
    const binary = cliPath()
    if (binary === null) return null
    // A SHELL FRAGMENT, not a wrapped command: every caller already runs this
    // through a shell (systemd via ExecStart, Hyprland via exec_cmd), and
    // adding an outer `sh -c '...'` here only created a quoting problem —
    // the operands' own quotes terminated it. The caller owns the quoting for
    // whatever syntax it is embedding into; this owns the environment.
    return `export PATH=${runtimePath()}; exec ${binary} ${args.join(" ")}`
}
