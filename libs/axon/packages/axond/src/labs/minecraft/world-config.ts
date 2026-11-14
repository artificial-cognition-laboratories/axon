import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { InstallT } from "./install"
import type { WorldsT } from "./worlds"

/** The dedicated server's properties for one managed world. */
export function WorldConfig(opts: { install: InstallT; worlds: WorldsT }) {
    return {
        /** `level`, when given, is the folder to open instead of the lab's own copy of `name` — a run's copy of it. */
        async write(input: { name: string; port: number; players: number; level?: string }): Promise<void> {
            await mkdir(opts.install.worlds, { recursive: true })
            const difficulty = await opts.worlds.difficulty(input.name)
            const text = [
                "# Managed by the Axon Minecraft lab. Edit through the daemon, not while the server is running.",
                "server-ip=127.0.0.1",
                `server-port=${input.port}`,
                `max-players=${input.players}`,
                `level-name=${input.level ? relative(opts.install.server, input.level) : `worlds/${input.name}`}`,
                "spawn-protection=0",
                /*
                 * New worlds default to peaceful: nothing hunts the body. The lab is where a mind learns
                 * to see and to move, and a body killed every half minute keeps
                 * starting its reckoning, and its map, over (measured: three deaths
                 * to zombies in ninety seconds, on easy). Danger is a scenario to
                 * choose, not the ground every look stands on. Once chosen, the
                 * per-world setting survives server restarts.
                 */
                `difficulty=${difficulty}`,
                /*
                 * Offline, deliberately.
                 *
                 * A managed body is a client with a name, not a licensed account.
                 * Online mode would mean one Mojang account per simultaneously
                 * embodied agent, and launching a body would displace the person's
                 * own session on the same account. Offline, `--username` IS the
                 * identity and its UUID derives from it, which is also what lets
                 * `Lease.identity` mean the same thing it means in Terraria.
                 *
                 * The exposure — anyone may claim any name — is bounded by
                 * `server-ip=127.0.0.1` above: nothing off this machine can reach it.
                 */
                "online-mode=false",
                /*
                 * No signed profile required, which offline mode forces.
                 *
                 * A secure profile is a key pair Mojang issues to a signed-in
                 * account, used to sign chat. A managed body has no account, so it
                 * has no key — and with the default `true` the server accepts the
                 * connection and then drops it: measured as
                 * "body-4 (...) lost connection: Disconnected", with the client
                 * logging a 401 from `getKeyPair` and nothing naming the cause.
                 *
                 * Turning it off is the honest consequence of offline mode, not a
                 * workaround: there is no authority to sign against on a loopback
                 * server with no accounts.
                 */
                "enforce-secure-profile=false",
                "enable-rcon=false",
                "motd=Axon Minecraft Lab",
                "white-list=false",
            ].join("\n") + "\n"
            await writeFile(join(opts.install.server, "server.properties"), text)
        },
    }
}

export type WorldConfigT = ReturnType<typeof WorldConfig>
