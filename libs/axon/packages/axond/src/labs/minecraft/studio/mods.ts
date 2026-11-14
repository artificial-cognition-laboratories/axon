import { existsSync } from "node:fs"
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"

/**
 * The building tools the authoring client carries, pinned to an exact file:
 * WorldEdit for selecting, copying and pasting regions between worlds
 * (`//schem save` / `//schem load`), Axiom for sculpting. A body never loads
 * them — they are for whoever builds the arena, not whoever is tested in it.
 *
 * Pinned by hash, from Modrinth: a mod that updated itself under the lab would
 * be a different tool than the one an arena was built with, with nothing
 * saying so. Bumping one is a change to this table.
 */
const PINNED = [
    {
        name: "WorldEdit",
        stem: "worldedit-mod-",
        file: "worldedit-mod-7.4.2.jar",
        url: "https://cdn.modrinth.com/data/1u6JkXh5/versions/oY3E2pzA/worldedit-mod-7.4.2.jar",
        sha512: "79f206c283421e68972e7df2b7f4c393506ff450ea5e58b8f6baafd762092eef07015edcdced6a4f536904ac048d69b2a86fa2fbf74e9d159cef9d2372042a2a",
    },
    {
        name: "Axiom",
        stem: "Axiom-",
        file: "Axiom-6.1.3-for-MC1.21.11.jar",
        url: "https://cdn.modrinth.com/data/N6n5dqoA/versions/4fv8luPO/Axiom-6.1.3-for-MC1.21.11.jar",
        sha512: "84a1efcf17c34d916552dca1bed6a09eea8e377b868f1885f528a63f368846e07670bce30a3dce3875f4f06d8e81019420fd46e4a3553ad47f418d908ae73abf",
    },
] as const

/** The pinned authoring mods: downloaded once into `cache`, verified, and put into a client's mods folder. */
export function AuthorMods(opts: { cache: string }) {
    async function fetched(mod: (typeof PINNED)[number]): Promise<string> {
        const path = join(opts.cache, mod.file)
        if (existsSync(path) && sha512(await readFile(path)) === mod.sha512) return path
        await mkdir(opts.cache, { recursive: true })
        const response = await fetch(mod.url, { signal: AbortSignal.timeout(120_000) })
        if (!response.ok) throw new Error(`Could not download ${mod.name}: HTTP ${response.status} from ${mod.url}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        const actual = sha512(bytes)
        if (actual !== mod.sha512) throw new Error(`${mod.name} from ${mod.url} is not the pinned file: sha512 ${actual}`)
        const staging = `${path}.download`
        await writeFile(staging, bytes)
        await rename(staging, path)
        return path
    }

    return {
        /** Puts every pinned mod into `mods`, replacing any other version of it found there. */
        async install(mods: string): Promise<void> {
            await mkdir(mods, { recursive: true })
            const present = await readdir(mods)
            for (const mod of PINNED) {
                for (const stale of present.filter(file => file.startsWith(mod.stem) && file !== mod.file)) await rm(join(mods, stale))
                await copyFile(await fetched(mod), join(mods, mod.file))
            }
        },
    }
}

export type AuthorModsT = ReturnType<typeof AuthorMods>

function sha512(bytes: Uint8Array): string {
    return createHash("sha512").update(bytes).digest("hex")
}
