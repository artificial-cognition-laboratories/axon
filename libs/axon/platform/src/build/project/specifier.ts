import { err } from "@arcforge/err"

/**
 * "@axon/telegram@1.2.0" → { name: "@axon/telegram", version: "1.2.0" }
 *
 * Only scoped names are valid as NAMES — the registry refuses to publish
 * anything else — so the leading "@" is always the scope, never a version
 * marker. A bare uuid is also accepted, because it addresses the same artifact
 * through the same backend lookup; what stays refused is an unscoped name,
 * which can never resolve.
 *
 * Shared by Installer (which installs a specifier) and Registry (which clones
 * or forks one). Both name the same thing: a published registry artifact,
 * optionally pinned. Registry used to carry its own copy that silently
 * tolerated an unscoped name and then asked the backend to resolve something
 * that cannot exist.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseSpecifier(specifier: string): { name: string; version: string | undefined } {
    // A bare artifact id is a valid address, not a specifier: the registry
    // resolves by uuid OR scoped name (see the backend's artifacts `get`), and
    // `axon clone <id>` is how the dashboard's copy-id button is meant to be
    // used. It carries no version — a uuid names the artifact, never a release
    // — so it passes through unparsed rather than being split on its hyphens.
    if (UUID.test(specifier)) return { name: specifier, version: undefined }

    if (!specifier.startsWith("@")) {
        throw err("MODULE_SPECIFIER_INVALID", {
            detail: `"${specifier}" is not a scoped module name — expected @scope/name`,
            context: { specifier: specifier },
        })
    }

    const at = specifier.indexOf("@", 1)
    if (at === -1) return { name: specifier, version: undefined }

    return {
        name: specifier.slice(0, at),
        version: specifier.slice(at + 1) || undefined,
    }
}
