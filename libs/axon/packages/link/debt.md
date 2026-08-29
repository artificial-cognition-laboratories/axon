
## [ ] Stream transport has no real backpressure to the producer
**Severity:** high
**Description:**
`socket.test.ts` ("reaches the producer with backpressure when the consumer stalls")
appears to assert backpressure but does not. Its fixture caps production at 2000 chunks
and it samples after a fixed 250ms, so the assertion passes because the fixture ran out
of work inside the window — not because the producer was slowed. Removing the cap and
waiting for production to settle shows it never settles: measured at 26,569 chunks of
64KB (~1.7GB) buffered with the consumer stalled and no sign of stopping. A model
producing faster than a consumer reads will therefore buffer its entire output in memory,
which is precisely the failure the test was written to prevent. The test was also the
suite's only flake (~1 in 3 under parallel load), because the 250ms window races the
producer on a busy machine. Fix belongs in the transport (honour the sink's backpressure
signal through the async iterator), after which the test can assert that production
settles rather than that it is merely slow.
**References:**
- libs/axon/packages/link/tests/integration/link/socket.test.ts — the test and its note
- libs/axon/packages/link/src/socket.ts — the stream path that should propagate backpressure
