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
            const absolute = resolved(opts.command)
            if (absolute === null) return false
            try {
                return readFileSync(target, "utf-8") === contents(absolute)
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

            /**
             * Resolve the binary to an absolute path before writing it.
             *
             * systemd does NOT search the user's PATH for `ExecStart`. A bare
             * `axon` is looked for in a fixed set of system directories only,
             * so a CLI installed under the user's home — which is where every
             * supported install puts it — is never found, and the unit fails
             * with 203/EXEC at every boot. It reports `enabled` throughout,
             * so nothing surfaces the failure.
             *
             * `verify` above passes regardless, because it runs in the shell
             * the user invoked, where PATH does contain the CLI. Working when
             * checked and failing when run is precisely the trap this whole
             * file was written to avoid, reached by a route its comments did
             * not anticipate.
             *
             * Resolving on every install keeps it current: the install is
             * idempotent by content, so a CLI that moves is repaired by the
             * next `daemon up` rather than left stale.
             */
            const absolute = resolved(opts.command)
            if (absolute === null) return false

            const body = contents(absolute)
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
        `Environment=PATH=${servicePath()}`,
        `ExecStart=${command.join(" ")}`,
        "Restart=on-failure",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n")
}

/**
 * A PATH the unit can actually run the CLI with.
 *
 * Resolving `axon` to an absolute path (see install()) fixed systemd not
 * searching the user's PATH — and uncovered the SAME trap one level down. The
 * CLI is a script whose shebang is `#!/usr/bin/env bun`, and a systemd user
 * service inherits a minimal PATH with no `~/.bun/bin` in it, so `env` cannot
 * find the interpreter and every start exits 127 with
 * `env: 'bun': No such file or directory`.
 *
 * It fails exactly as invisibly as its predecessor: the unit reports `enabled`,
 * `axon daemon status` works perfectly in the user's own shell, and the service
 * simply restarts forever. This machine reached 671 attempts before anyone
 * looked, having never once started the daemon the whole product assumes is
 * resident.
 *
 * So the interpreter's directory is written into the unit alongside the system
 * ones. Resolved at install time from wherever bun actually is, rather than
 * guessed: an install that moved it would otherwise reintroduce this.
 */
function servicePath(): string {
    const standard = ["/usr/local/bin", "/usr/bin", "/bin"]
    const interpreter = Bun.which("bun")
    const home = homedir()
    const candidates = [
        ...(interpreter ? [dirname(interpreter)] : []),
        // The two locations the installer uses, included even when bun is not
        // on THIS shell's PATH — the unit outlives the shell that wrote it.
        join(home, ".bun", "bin"),
        join(home, ".cache", ".bun", "bin"),
        ...standard,
    ]
    return candidates.filter((entry, index) => candidates.indexOf(entry) === index).join(":")
}

function which(binary: string): boolean {
    return run(["which", binary])
}

/**
 * The command with its binary as an absolute path, or null when it cannot be
 * found at all.
 *
 * Null rather than a guess: a unit naming a path that does not exist is the
 * silent boot failure this module exists to prevent, and `install` reporting
 * false is the honest alternative.
 */
function resolved(command: string[]): string[] | null {
    const [binary, ...rest] = command
    if (!binary) return null
    if (binary.startsWith("/")) return command

    const path = Bun.which(binary)
    return path ? [path, ...rest] : null
}

/**
 * Does this command actually reach a daemon that can serve?
 *
 * It used to swap the last word for `status` and check THAT — verifying a
 * different command from the one it was about to write. `serve` existed only
 * on the `axond` binary while the unit named `axon daemon serve`, so this
 * returned true and installed a unit that exited 1 at every start, on every
 * machine, silently, because the service reports `enabled` throughout.
 *
 * So it now asks about the REAL command: `--help` on the group, which lists
 * the verbs. Cheap, no side effects, and false exactly when the CLI cannot do
 * what the unit is about to ask of it.
 */
function verify(command: string[]): boolean {
    const [binary, ...rest] = command
    if (!binary || !which(binary)) return false
    const verb = rest[rest.length - 1]
    if (!verb) return false
    const listing = capture([binary, ...rest.slice(0, -1), "--help"])
    return listing !== null && listing.includes(verb)
}

/** A command's output, or null when it could not be run. Never throws. */
function capture(argv: string[]): string | null {
    try {
        const [command, ...args] = argv
        if (!command) return null
        const probed = spawnSync(command, args, { encoding: "utf-8" })
        if (probed.status !== 0) return null
        return `${probed.stdout ?? ""}${probed.stderr ?? ""}`
    } catch {
        return null
    }
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
