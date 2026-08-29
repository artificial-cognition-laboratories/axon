/**
 * The six things the registry publishes. One shared namespace, one treatment.
 *
 * A VALUE as well as a type, because callers need to iterate every kind — the
 * catalogue queries one per kind so a long tail is not buried behind a popular
 * one. Each of those used to spell the list out, and a hand-written copy is a
 * published kind the UI silently never asks for, which reads as the artifact
 * having failed to publish.
 */
export const ARTIFACT_KINDS = ["agent", "module", "cognet", "bench", "prompt", "extension"] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/**
 * One artifact that depends on another — an entry in the "used by" list.
 *
 * Always the dependent's LATEST version: a package that dropped this
 * dependency three releases ago is not a current dependent, and counting
 * every historical version would list the same artifact repeatedly.
 */
export type Dependent = {
    artifactId: string
    kind: ArtifactKind
    /** The full scoped name — its address. */
    name: string
    description: string | null
    starsCount: number
    latestVersion: string | null
    /** The range this dependent declares against the target, e.g. "^0.1.4". */
    range: string
    ownerUsername: string | null
    orgSlug: string | null
}

/**
 * Which population a dependency belongs to.
 *
 * A package.json mixes three different kinds of fact in one object, and they
 * mean very different things:
 *
 *   framework — Axon itself (`@arcforge/*`). Every artifact depends on it, so
 *               it carries no ecosystem signal and is shown as a version badge
 *               rather than a dependency row.
 *   registry  — another published artifact. THE ecosystem edge: linkable in
 *               both directions, and the only class that feeds "used by".
 *   npm       — an ordinary package. Real and worth listing, but it is this
 *               artifact's own implementation detail.
 *
 * Derived by the backend from the edge, never stored — the boundary is policy.
 */
export type DependencyClass = "framework" | "registry" | "npm"

/** One entry in a version's dependency list. */
export type Dependency = {
    /** As written in package.json — "@axon/discord", "h3". */
    name: string
    range: string
    kind: "runtime" | "peer" | "optional"
    class: DependencyClass
    /** The target's artifact kind, when this is a linkable registry artifact. */
    registryKind: ArtifactKind | null
    /**
     * Whether this resolves to a public registry artifact, and therefore
     * whether the UI should link it. False for ordinary npm packages and for
     * private artifacts, whose existence is not public.
     */
    linkable: boolean
}

export type ArtifactRecord = {
    artifactId: string
    kind: ArtifactKind
    name: string
    description: string | null
    /**
     * Long-form README markdown. The detail page's whole body — it was
     * missing from this type and from parseArtifactRecord() while
     * `/api/artifacts/:id` returned it all along, so every consumer read
     * `undefined` and rendered an empty page.
     */
    readme: string | null
    private: boolean
    latestVersion: string | null
    starsCount: number
    /**
     * Lifetime installs. Unlike starsCount this is not a column on the
     * artifact row — the list endpoints roll it up from the metric log per
     * page, so it is 0 on any response that didn't ask for it.
     */
    installsCount: number
    /** Set for a user-owned artifact; null when owned by an org. */
    ownerUsername: string | null
    /** Set for an org-owned artifact; null when owned by a user. */
    orgSlug: string | null
    createdAt: string
    /** Deprecation is a signal, never a break — installs keep resolving. Null when not deprecated. */
    deprecatedAt: string | null
    deprecationMessage: string | null
}

/** One README asset stored with a published version. */
export type ArtifactAsset = {
    /** Relative to the version's assets/ prefix — joins onto the serving route. */
    path: string
    /** Bytes as stored, after CLI-side compression. */
    bytes: number
    contentType: string
}

export type ArtifactVersion = {
    id: string
    version: string
    publishedAt: string
    installs: number
    /** The rendered declaration string from `axon prepare` — null on publishes that predate it. */
    manifest: string | null
    /**
     * README assets published with this version, or null on publishes that
     * predate the manifest being recorded.
     *
     * `[]` and `null` are different answers: the first says there are none, the
     * second says we do not know. A consumer showing an assets folder must not
     * claim an older version shipped nothing.
     */
    assets: ArtifactAsset[] | null
}

export type ArtifactStats = {
    installsTotal: number
    starsTotal: number
    starredByMe: boolean
    daily: Array<{ date: string; installs: number; stars: number }>
}

export type ResolvedArtifact = {
    artifactId: string
    kind: ArtifactKind
    name: string
    version: string
    downloadUrl: string
}

/** Owner-editable fields. package.json drives visibility at publish time. */
export type ArtifactUpdate = {
    private?: boolean
    description?: string | null
    /** true stamps deprecatedAt; false clears it and the message. */
    deprecated?: boolean
    deprecationMessage?: string | null
}
