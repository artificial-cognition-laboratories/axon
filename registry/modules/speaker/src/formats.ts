/** Mechanical audio formats accepted by the speaker body. */

export type PcmFormat = {
    rate: number
    bits: 16
    channels: number
    signed: true
    littleEndian: true
}

export type AudioRef = {
    uri: string
    mime: string
    bytes?: number
}

export function parsePcm(mime: string): PcmFormat | null {
    if (!/^audio\/pcm(?:;|$)/i.test(mime)) return null

    const read = (name: string) => {
        const match = mime.match(new RegExp(`(?:^|;)\\s*${name}=(\\d+)`, "i"))
        return match ? Number(match[1]) : undefined
    }

    const rate = read("rate")
    const bits = read("bits") ?? 16
    const channels = read("ch") ?? read("channels") ?? 1
    const signed = !/(?:^|;)\s*signed=(?:false|0)(?:;|$)/i.test(mime)
    const littleEndian = !/(?:^|;)\s*endian=(?:be|big)(?:;|$)/i.test(mime)

    if (!rate || bits !== 16 || !channels || channels < 1 || channels > 2 || !signed || !littleEndian) return null
    return { rate, bits: 16, channels, signed: true, littleEndian: true }
}

export function decodeDataUri(uri: string): Uint8Array | null {
    if (!uri.startsWith("data:")) return null
    const comma = uri.indexOf(",")
    if (comma < 0) return null

    const metadata = uri.slice(5, comma)
    if (!metadata.toLowerCase().includes(";base64")) return null

    try {
        return Uint8Array.from(atob(uri.slice(comma + 1)), char => char.charCodeAt(0))
    } catch {
        return null
    }
}
