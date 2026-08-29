import { homedir } from "node:os"
import { join } from "node:path"
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
export function daemonPaths(root?: string): DaemonPaths {
    const store = process.env.NODE_ENV === "production" ? ".axon" : ".axon-dev"
    const base = root ?? process.env.AXON_DAEMON_DIR ?? join(homedir(), store, "cache", "daemon")
    return {
        root: base,
        socket: join(base, "axond.sock"),
        pid: join(base, "axond.pid"),
        log: join(base, "axond.log"),
    }
}
