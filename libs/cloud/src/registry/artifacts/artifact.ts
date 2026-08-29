import type { HttpClient } from "../../platform/http"
import { bool, num, record, rows, str, strOrNull } from "../../platform/parse"
import type { ArtifactAsset, ArtifactKind, ArtifactRecord, ArtifactStats, ArtifactUpdate, ArtifactVersion, Dependency, Dependent } from "./types"
import type { ActivityRange } from "../registry"

type ArtifactOpts = {
    id: string
    http: HttpClient
    runtime: "node" | "browser"
    /**
     * Known only when the handle came from a kind-bound view
     * (`of("agent").artifact(id)`) or from `Agents`. Undefined when addressed
     * generically, where the kind is whatever the row turns out to be — the
     * backend enforces the per-kind rules either way; this only lets the
     * client fail earlier when it already knows.
     */
    kind?: ArtifactKind
}

export function parseArtifactRecord(data: Record<string, unknown>): ArtifactRecord {
    return {
        artifactId: typeof data.artifactId === "string" ? data.artifactId : str(data, "id"),
        kind: str(data, "kind") as ArtifactKind,
        name: str(data, "name"),
        description: strOrNull(data, "description"),
        readme: strOrNull(data, "readme"),
        private: data.private === true,
        latestVersion: strOrNull(data, "latest_version") ?? strOrNull(data, "latestVersion"),
        starsCount: typeof data.starsCount === "number" ? data.starsCount : 0,
        installsCount: typeof data.installsCount === "number" ? data.installsCount : 0,
        ownerUsername: strOrNull(data, "ownerUsername"),
        orgSlug: strOrNull(data, "orgSlug"),
        createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
        deprecatedAt: typeof data.deprecatedAt === "string" ? data.deprecatedAt : null,
        deprecationMessage: typeof data.deprecationMessage === "string" ? data.deprecationMessage : null,
    }
}

/**
 * One artifact in the registry — record, versions, publishing, social.
 * Identical for all five kinds: deployment is not here, because only agents
 * deploy and that lives on the agent handle.
 *
 * `id` addresses the artifact by uuid OR by its full scoped name
 * ("@axon/obsidian"). The name is the artifact's public address — it is what
 * the URL shows and what `axon install` takes — so every verb below works
 * from either. The backend tells them apart by the leading "@".
 */
export function Artifact(opts: ArtifactOpts) {
    const base = `/api/artifacts/${encodeURIComponent(opts.id)}`

    return {
        id: opts.id,

        async get(): Promise<ArtifactRecord> {
            return parseArtifactRecord(record(await opts.http.get(base), "artifact"))
        },

        /**
         * Upload a new version from a bundle path (directory or .tar.gz).
         * Version comes from the bundle's package.json unless overridden.
         * The backend 409s on duplicate versions — bump before republishing.
         *
         * `requireImage` demands an image.json beside the tarball. An agent
         * bundle is only deployable with its build manifest, so the deploy
         * path asks for it and fails here with "run `axon build` first" rather
         * than server-side, after the upload has crossed the wire.
         */
        async publish(input: { path: string; version?: string; requireImage?: boolean }): Promise<{ version: string }> {
            if (opts.runtime === "browser") {
                throw new Error("artifact.publish() is not available when AxonCloud({ runtime: \"browser\" })")
            }
            // An AGENT bundle is only deployable with its build manifest, so
            // image.json is required whenever we know we are publishing one.
            // Carried by the kind rather than by the call site: every agent
            // publish needs it, and a caller that had to remember would
            // eventually not — which is how the agent-specific check was lost
            // when these surfaces were parallel implementations.
            const requireImage = input.requireImage ?? opts.kind === "agent"

            // Imported HERE, not at module scope. `Bundle` reads the local
            // filesystem, so a static import puts `node:fs/promises` in the
            // browser's module graph for every consumer of this file — and
            // publishing is the one operation a browser never performs.
            // Deferring it keeps the rest of the artifact surface isomorphic,
            // the same way bundle.ts already defers its own Node imports.
            const { Bundle } = await import("./bundle")

            const bundle = await Bundle(input.path, {
                ...(input.version !== undefined ? { version: input.version } : {}),
                ...(requireImage ? { requireImage: true } : {}),
            })

            const form = new FormData()
            form.append("source", new Blob([new Uint8Array(bundle.tarball)], { type: "application/gzip" }), bundle.tarballName)
            form.append("version", bundle.version)
            form.append("config", bundle.config)
            // README assets as their own part, so `source` stays code-only and
            // installing an artifact never pulls docs media. One request, so a
            // version can never exist with only half of its assets stored.
            if (bundle.assets !== null) {
                form.append("assets", new Blob([new Uint8Array(bundle.assets)], { type: "application/gzip" }), "assets.tar.gz")
            }
            if (bundle.manifest !== null) form.append("manifest", bundle.manifest)
            if (bundle.abi !== null) form.append("abi", bundle.abi)

            await opts.http.form(`${base}/publish`, form)
            return { version: bundle.version }
        },

        async versions(): Promise<ArtifactVersion[]> {
            const raw = record(await opts.http.get(`${base}/versions`), "versions response")
            return rows(raw.versions, "versions").map(row => ({
                id: str(row, "id"),
                version: str(row, "version"),
                publishedAt: str(row, "created_at"),
                installs: num(row, "installs_count"),
                manifest: strOrNull(row, "manifest"),
                assets: parseAssets(row.assets),
            }))
        },

        /**
         * Public artifacts whose LATEST version depends on this one.
         *
         * The registry's "used by" list — every entry is a relationship
         * declared in a published package.json rather than anything a user
         * curated, which is what makes it both trustworthy and dense.
         */
        async dependents(limit?: number): Promise<{ total: number; items: Dependent[] }> {
            const query = limit ? `?limit=${limit}` : ""
            const raw = record(await opts.http.get(`${base}/dependents${query}`), "dependents")
            return {
                total: num(raw, "total"),
                items: rows(raw.dependents, "dependents").map(row => ({
                    artifactId: str(row, "artifactId"),
                    kind: str(row, "kind") as ArtifactKind,
                    name: str(row, "name"),
                    description: strOrNull(row, "description"),
                    starsCount: num(row, "starsCount"),
                    latestVersion: strOrNull(row, "latestVersion"),
                    range: str(row, "range"),
                    ownerUsername: strOrNull(row, "ownerUsername"),
                    orgSlug: strOrNull(row, "orgSlug"),
                })),
            }
        },

        /** What one published version depends on — registry artifacts and npm packages alike. */
        async dependencies(version: string): Promise<Dependency[]> {
            const raw = record(
                await opts.http.get(`${base}/versions/${encodeURIComponent(version)}/dependencies`),
                "dependencies",
            )
            return rows(raw.dependencies, "dependencies").map(row => ({
                name: str(row, "name"),
                range: str(row, "range"),
                kind: str(row, "kind") as Dependency["kind"],
                class: str(row, "class") as Dependency["class"],
                registryKind: strOrNull(row, "registryKind") as ArtifactKind | null,
                linkable: row.linkable === true,
            }))
        },

        /** A short-lived signed URL for one version's source tarball — what the source explorer downloads. */
        async downloadUrl(version: string): Promise<string> {
            const raw = record(await opts.http.get(`${base}/versions/${encodeURIComponent(version)}/download`), "download response")
            return str(raw, "downloadUrl")
        },

        async stats(range?: ActivityRange): Promise<ArtifactStats> {
            const query = range ? `?range=${range}` : ""
            const raw = record(await opts.http.get(`${base}/stats${query}`), "stats")
            return {
                installsTotal: num(raw, "installs_total"),
                starsTotal: num(raw, "stars_total"),
                starredByMe: bool(raw, "starred_by_me"),
                daily: rows(raw.daily, "daily").map(day => ({
                    date: str(day, "date"),
                    installs: num(day, "installs"),
                    stars: num(day, "stars"),
                })),
            }
        },

        async star(): Promise<void> {
            await opts.http.post(`${base}/star`, {})
        },

        async unstar(): Promise<void> {
            await opts.http.delete(`${base}/star`)
        },

        /** Owner-editable fields: description, private, deprecation. private:true is the current kill switch — there is no unpublish. */
        async update(input: ArtifactUpdate): Promise<void> {
            const { deprecationMessage, ...fields } = input
            await opts.http.patch(base, {
                ...fields,
                ...(deprecationMessage !== undefined ? { deprecation_message: deprecationMessage } : {}),
            })
        },
    }
}

export type ArtifactHandle = ReturnType<typeof Artifact>

/**
 * The asset manifest off a version row, or null.
 *
 * NULL is preserved rather than normalised to `[]` — a version published before
 * assets were recorded genuinely has no manifest, which is a different fact from
 * having published none, and the site renders the two differently.
 *
 * Malformed entries are dropped rather than throwing: this is a display concern,
 * and one bad row must not cost the whole version list. A dropped asset is a
 * missing thumbnail; a throw is a page that will not load.
 */
function parseAssets(value: unknown): ArtifactAsset[] | null {
    if (value === null || value === undefined) return null
    if (!Array.isArray(value)) return null

    return value.flatMap(entry => {
        if (!entry || typeof entry !== "object") return []
        const asset = entry as Record<string, unknown>
        if (typeof asset.path !== "string" || !asset.path) return []
        return [{
            path: asset.path,
            bytes: typeof asset.bytes === "number" ? asset.bytes : 0,
            contentType: typeof asset.contentType === "string" ? asset.contentType : "application/octet-stream",
        }]
    })
}
