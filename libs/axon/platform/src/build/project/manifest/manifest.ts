import { Bunfig } from "./bunfig"
import { Config } from "./config"
import { Model } from "./model"
import { Env } from "./env"
import { Package } from "./package"

type ManifestOpts = {
    root: string
}

/**
 * Manifest — the project's declaration files on disk.
 *
 * Every file that records what a project IS rather than what it has installed:
 *
 *   package.json    identity, version, declared dependencies
 *   axon.config.ts  which modules and prompts are activated
 *   bunfig.toml     which scopes resolve against the Axon registry
 *   .env            the environment a deploy carries
 *
 * All four are files a HUMAN owns and reads, which is what unites them: every
 * edit is surgical and preserves the author's formatting and comments. That is
 * also the boundary — materializing node_modules is a different concern
 * entirely (it shells out to Bun and moves trees around) and lives on
 * Installer, which owns the installed tree.
 *
 * This replaced six flat files of orphan operations (dependencies, version,
 * config, bunfig, env, plus a duplicated regex escape) that between them held
 * four separate implementations of "read the project's package.json".
 */
export function Manifest(opts: ManifestOpts) {
    const root = opts.root
    const pckg = Package({ root })
    const config = Config({ root })
    const model = Model({ root })
    const bunfig = Bunfig({ root })
    const env = Env({ root })

    return {
        root: root,
        package: pckg,
        config: config,
        model: model,
        bunfig: bunfig,
        env: env,
    }
}

export type ManifestT = ReturnType<typeof Manifest>
