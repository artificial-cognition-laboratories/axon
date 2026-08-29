
/**
 * Deployment target for an agent bundle.
 *
 * - `"axon"` deploys to Axon-managed infrastructure.
 * - `"self"` emits a portable bundle and Dockerfile for your own platform.
 *
 * @see https://axon.arclabs.it/docs/v2/api/config/deploy
 */
export type DeployTarget = "axon" | "self"

/** Autoscaling bounds for managed deployments. */
export type ScalingConfig = {
    /** Minimum running instances. Defaults to `0`, allowing scale-to-zero. */
    min?: number
    /** Maximum running instances. Defaults to `3`. */
    max?: number
}

/** Container runtime customization for deployed agents. */
export type RuntimeConfig = {
    /**
     * System packages to add to the container via apk (Alpine base).
     * e.g. ["git", "ripgrep"]
     */
    packages?: string[]
}

/** Managed cron schedule connected to an agent inbox route. */
export type ScheduleEntry = {
    /** Unique name for this schedule. Used as the inbox route: /_axon/inbox/{name} */
    name: string
    /** Standard cron expression. e.g. "0 9 * * *" for 9am UTC daily. */
    cron: string
    /** Timezone for cron evaluation. Defaults to "UTC". */
    timezone?: string
}

/** External connections provisioned for an agent. */
export type ConnectionsConfig = {
    /** Axon-managed cron schedules. Platform provisions Cloud Scheduler jobs. */
    schedule?: ScheduleEntry[]
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
