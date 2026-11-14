/**
 * Whether an entry is for a client on `channel`: addressed to it, or to no
 * one. An entry addressed to another channel is another conversation — the
 * telegram user's reply, a voice speaking to itself — and not this client's
 * to show.
 *
 * The ONE rule: every client that hears a mind (a request, a connection,
 * `axon -p`) answers it the same way, or two of them disagree about what the
 * agent said.
 */
export function addressedTo(data: unknown, channel: string): boolean {
    if (!data || typeof data !== "object" || !("channel" in data)) return true
    const to = data.channel
    return typeof to !== "string" || to === "" || to === channel
}
