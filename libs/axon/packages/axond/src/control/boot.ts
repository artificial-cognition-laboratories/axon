import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"

type BootOpts = {
    /**
     * The command a boot unit runs.
     *
     * `axon daemon serve` rather than the daemon's own binary, deliberately: a
     * unit naming a source `.ts` path breaks the moment the published CLI is
     * installed, and one naming a versioned path breaks on every upgrade. The
     * CLI is the stable name for "whatever axond currently is".
     */
    command: string[]
    /** Override the unit's location. Tests point this at a scratch dir. */
    root?: string
}

/** Where a unit lives, and what it is called on this platform. */
export type BootUnit = {
    /** Absolute path of the file installed. */
    path: string
    /** True when this platform has an init system we know how to write for. */
    supported: boolean
}

/**
 * Boot — make the daemon start with the machine.
 *
 * ── Why this is silent ──────────────────────────────────────────────────────
 *
 * The daemon is meant to be invisible. A person running an agent should not
 * have to know a supervisor exists, let alone arrange for it to be running —
 * so the first `up` installs the unit and nothing announces it.
 *
 * That is a strong default, and it is bounded by two things: the unit lives
 * entirely in the user's own home (no root, no system-wide state), and
 * `disable()` removes it completely. Silent install with no way out would not
 * be defensible; this is.
 *
 * ── Rewritten, never merely present ─────────────────────────────────────────
 *
 * `install` writes whenever the CONTENT differs, not only when the file is
 * absent. A unit pointing at a binary that has moved is worse than no unit at
 * all: it fails at boot, silently, and the daemon a person believes is running
 * is not — which is exactly the failure this exists to prevent.
 *
 * ── Unsupported is reported, never faked ────────────────────────────────────
 *
 * A machine with no init system we can write for gets `supported: false` and
 * no file. Pretending otherwise would tell a caller boot-start is arranged
 * when nothing will happen.
 */
export function Boot(opts: BootOpts) {
    const target = unitPath(opts.root)

    return {
        /** Where the unit lives, and whether this platform is supported at all. */
        unit(): BootUnit {
            return { path: target, supported: supported() }
        },

        /** True when a unit is installed and names the current command. */
        installed(): boolean {
            if (!supported() || !existsSync(target)) return false
            try {
                return readFileSync(target, "utf-8") === contents(opts.command)
            } catch {
                return false
            }
        },

        /**
         * Install or repair the boot unit. Returns false where unsupported.
         *
         * Idempotent by CONTENT: a unit already naming this command is left
         * alone, and one naming a stale path is rewritten. Enabling is a
         * separate step the init system may refuse — a session with no user
         * bus, a container — and that refusal is not fatal: the file is
         * correct and will take effect on a machine that has one.
         */
        install(): boolean {
            if (!supported()) return false

            /**
             * Refuse to install a unit whose command does not work.
             *
             * A unit is only ever exercised at boot, by systemd, with nobody
             * watching — so one naming a CLI too old to know `daemon serve`
             * fails silently and the daemon a person believes starts with
             * their machine does not. Verifying once, here, is the difference
             * between that and an honest false.
             *
             * Checked with `--help` rather than by running it: `serve` does
             * not return, and the question is whether the verb EXISTS.
             */
            if (!verify(opts.command)) return false

            const body = contents(opts.command)
            mkdirSync(dirname(target), { recursive: true })

            // Written only when it differs, so an install on every `up` does
            // not rewrite a file the init system is watching.
            if (!existsSync(target) || readFileSync(target, "utf-8") !== body) {
                writeFileSync(target, body, "utf-8")
            }

            enable()
            return true
        },

        /**
         * Remove the boot unit.
         *
         * The way out that makes a silent install defensible. Best-effort on
         * the init system's side: the FILE going is what stops it starting,
         * and a `disable` that failed because nothing was enabled is not an
         * error worth reporting.
         */
        disable(): void {
            if (!supported()) return
            run(["systemctl", "--user", "disable", "--now", UNIT_NAME])
            rmSync(target, { force: true })
        },
    }

    /** Ask the init system to honour the unit. Failure is tolerated — see install(). */
    function enable(): void {
        run(["systemctl", "--user", "daemon-reload"])
        run(["systemctl", "--user", "enable", UNIT_NAME])
    }
}

export type BootT = ReturnType<typeof Boot>

/**
 * The unit's name. Stable across versions, because the file IS the identity —
 * a rename would orphan every unit already installed.
 */
const UNIT_NAME = "axond.service"

/** Only systemd for now. macOS and Windows report unsupported rather than pretending. */
function supported(): boolean {
    return platform() === "linux" && which("systemctl")
}

function unitPath(root?: string): string {
    const base = root
        ?? process.env.XDG_CONFIG_HOME
        ?? join(homedir(), ".config")
    return join(base, "systemd", "user", UNIT_NAME)
}

/**
 * The unit file.
 *
 * `Restart=on-failure` rather than `always`: a daemon that exits cleanly was
 * told to, and restarting it would make `axon daemon down` a thing that does
 * not work. `default.target` is the user-session equivalent of "at login".
 */
function contents(command: string[]): string {
    return [
        "[Unit]",
        "Description=Axon daemon — machine-wide agent and resource supervisor",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=${command.join(" ")}`,
        "Restart=on-failure",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n")
}

function which(binary: string): boolean {
    return run(["which", binary])
}

/**
 * Does this command actually reach a daemon that can serve?
 *
 * `axon daemon status` is the cheapest verb that fails on a CLI predating the
 * group — it exits non-zero with "Unknown command: daemon" — and succeeds
 * whether or not a daemon happens to be running.
 */
function verify(command: string[]): boolean {
    const [binary, ...rest] = command
    if (!binary || !which(binary)) return false
    return run([binary, ...rest.slice(0, -1), "status"])
}

/** Run a command, reporting only whether it succeeded. Never throws. */
function run(argv: string[]): boolean {
    try {
        const [command, ...args] = argv
        return spawnSync(command!, args, { stdio: "ignore" }).status === 0
    } catch {
        return false
    }
}
