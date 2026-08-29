/**
 * Deployment target for an agent bundle.
 *
 * - `"axon"` deploys to Axon-managed infrastructure.
 * - `"self"` emits a portable bundle and Dockerfile for your own platform.
 *
 * @see https://axon.arclabs.it/docs/v2/api/config/deploy
 */
export type DeployTarget = "axon" | "self"

/**
 * The base image version — one source of truth for everything that names it.
 *
 * Three things need this string and they must never disagree: the provisioner
 * stamps it onto each deployed service's image tag, the bundler writes it into
 * a self-host Dockerfile, and the image's deploy script tags what it pushes.
 *
 * It used to live in the backend, with `packages/docker/deploy.ts` keeping a
 * copy in sync by REGEX REWRITE across two files. That is a sync that fails
 * silently: a refactor renames the constant, the regex stops matching, and the
 * two drift with nothing failing until a deployment runs an unexpected runtime.
 *
 * Here rather than in `@axon/docker` because the BUNDLER needs it, and
 * `@axon/docker` depends on `@arcforge/platform` — importing it back would be
 * a cycle. Types is the package everything already depends on and which
 * depends on nothing.
 */
export const AXON_BASE_VERSION = "0.3.6"

/**
 * Where the base image is pulled from.
 *
 * PUBLIC, deliberately: a user self-hosting an agent runs this image directly
 * (`docker run -v $PWD:/agent axon/base:<version>`), so an image they cannot
 * pull makes self-hosting impossible rather than merely awkward.
 */
export const AXON_BASE_IMAGE = "axon/base"

/** The reference a Dockerfile or `docker run` should use. Pinned, never floating. */
export function axonBaseRef(version: string = AXON_BASE_VERSION): string {
    return `${AXON_BASE_IMAGE}:${version}`
}

/** Autoscaling bounds for managed deployments. */
export type ScalingConfig = {
    /** Minimum running instances. Defaults to `0`, allowing scale-to-zero. */
    min?: number
    /** Maximum running instances. Defaults to `3`. */
    max?: number // 1
}

/** Container runtime customization for deployed agents. */
export type RuntimeConfig = {
    /**
     * System packages to add to the container via apk (Alpine base).
     * e.g. ["git", "ripgrep"]
     */
    packages?: string[]
}


/**
 * Deployment configuration used by `axon agent deploy` and bundle commands.
 *
 * ```ts
 * export default defineAgent({
 *     deploy: {
 *         target: "axon",
 *         runtime: { packages: ["git", "ripgrep"] },
 *         scaling: { min: 0, max: 2 },
 *     },
 * })
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/deploy
 * @see https://axon.arclabs.it/docs/v2/api/config/deploy
 */
export type DeployConfig = {
    /**
     * "axon"  — Axon-managed infra. Used by `axon agent deploy`.
     * "self"  — produce .agent/ bundle + Dockerfile only. Used by `axon agent bundle`.
     * Default: "axon"
     */
    target?: DeployTarget
    runtime?: RuntimeConfig
    scaling?: ScalingConfig
}
