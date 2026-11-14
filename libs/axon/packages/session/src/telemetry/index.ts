// telemetry — the binary ring for high-rate cognet telemetry (TELEMETRY_EVENTS).
// TelemetryRing writes it; Decoder is how any reader — Fleet — gets events back.
export { TelemetryRing, TELEMETRY_MAX_BYTES, type TelemetryRingT, type TelemetryRingOpts } from "./ring"
export { Decoder, type DecoderT, type DecoderOpts } from "./decoder"
export { Encoder, type EncoderT } from "./encoder"
export type { Decoded, Envelope } from "./format"
