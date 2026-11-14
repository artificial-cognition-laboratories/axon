/**
 * Bridges something that cannot yield — a wake, or a mind answering a
 * request — to the caller's async iterator.
 * push() during execution, close() on clean stop, fail() rethrows at the
 * consumer.
 */
export function Channel<T>() {
    const buffer: T[] = []
    let notify: (() => void) | null = null
    let done = false
    let failed = false
    let failure: unknown = null

    function wakeConsumer() {
        notify?.()
        notify = null
    }

    return {
        push(value: T) {
            buffer.push(value)
            wakeConsumer()
        },
        close() {
            done = true
            wakeConsumer()
        },
        fail(cause: unknown) {
            failed = true
            failure = cause
            done = true
            wakeConsumer()
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<T> {
            while (true) {
                while (buffer.length > 0) yield buffer.shift()!
                if (done) {
                    if (failed) throw failure
                    return
                }
                await new Promise<void>((resolve) => { notify = resolve })
            }
        },
    }
}
