/**
 * The machine network's enrollment contract, shared by the daemon that signs
 * and the backend that verifies — one definition, so the two can never sign
 * and check different bytes.
 */

/** Which network a machine belongs to: installed Axon and a source build are kept apart. */
export type MachineDistribution = "production" | "development"

/**
 * What a daemon signs to enroll its key: the key, bound to the account, the
 * network and a moment. Binding the account stops a signature seen in transit
 * from enrolling someone's key into another account; the moment bounds replay.
 */
export function machineStatement(input: { userId: string; key: string; distribution: MachineDistribution; at: string }): string {
    return `axon-machine-enroll\n${input.userId}\n${input.key}\n${input.distribution}\n${input.at}`
}
