/** Parse a "key=value" line into a pair. */
export function parseLine(line: string): { key: string; value: string } {
    const [key, value] = line.split("=")
    return { key, value }
}
