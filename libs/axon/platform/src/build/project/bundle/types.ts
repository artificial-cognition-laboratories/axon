/**
 * The publishable artifact records — what a bundle writes to image.json and
 * what publish/deploy read back to identify what they are uploading.
 */

import type { AssetReport } from "./assets"

export type AgentImage = {
    kind: "agent"
    agentId: string
    version: string
    public: boolean
    axonVersion: string
    builtAt: string
    /** From package.json — same source as ModuleImage. */
    description?: string
    connections?: Record<string, unknown>
}

export type ModuleImage = {
    kind: "module"
    moduleId: string
    version: string
    public: boolean
    builtAt: string
    description?: string
}

/**
 * Cognets, benches and prompts: published as source, no build step, no
 * per-kind metadata beyond the package identity. They share one image shape
 * because there is genuinely nothing kind-specific to record.
 */
export type SourceImage = {
    kind: "cognet" | "bench" | "prompt"
    name: string
    version: string
    public: boolean
    builtAt: string
    description?: string
    /**
     * The kernel ABI this cognet targets, lifted out of cognet.config.ts so
     * publish can record it on the version row. Cognets only — nothing else
     * declares a kernel contract.
     */
    abi?: string
}

export type BundleImage = AgentImage | ModuleImage | SourceImage

/** What a kind's bundler returns. Internal to the module — callers get a BundleArtifact. */
export type BundleResult = {
    image: BundleImage
    tarball: string
    /**
     * README assets that were packaged. Source-published kinds only — an agent's
     * bundle is a deploy image nobody reads a README from.
     */
    assets?: AssetReport[]
    /**
     * Absolute path to `assets.tar.gz`, absent when the project has no assets.
     * A SEPARATE upload from `tarball`, so docs media stays off the install path.
     */
    assetsTarball?: string
}

/**
 * The identity every kind's image carries, however it spells its name field.
 * Callers register against this and nothing else.
 */
export type BundleIdentity = {
    name: string
    version: string
    public: boolean
    description?: string
}

/**
 * A completed bundle: what it is, where it was written, what to upload.
 *
 * These three travel together deliberately. `dir` is only meaningful because
 * the build that filled it has run — exposing it separately from the build
 * made that ordering load-bearing and invisible, and a caller that got it
 * wrong uploaded a stale tarball with no error.
 */
export type BundleArtifact = {
    /**
     * The full image record as written to image.json. Kind-specific — narrow
     * it on `image.kind` to reach agentId/axonVersion/abi. Callers that only
     * need to register the artifact should use `identity` instead.
     */
    image: BundleImage
    /** The image's registrable fields, normalised across kinds. */
    identity: BundleIdentity
    /** The bundle directory — what publish/deploy upload from. */
    dir: string
    /** Absolute path to source.tar.gz inside `dir` — CODE ONLY. */
    tarball: string
    /**
     * README assets packaged for this version, for the CLI's publish report.
     * Empty for kinds that do not carry assets.
     */
    assets: AssetReport[]
    /**
     * Absolute path to `assets.tar.gz` inside `dir`, or null when there are no
     * assets. Uploaded as its own publish part and unpacked server-side; it is
     * deliberately NOT inside `tarball`, so `axon install` never fetches docs
     * media (that cost was 99% of one extension's payload).
     */
    assetsTarball: string | null
}
