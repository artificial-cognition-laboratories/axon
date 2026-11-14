import { readFileSync } from "node:fs"
import type { Source } from "../compile"
import { fail } from "./model"

export type External = { name: string; package: string; named: string; absPath: string }

/** Top-level message and enum names already supplied by annotated TS or .proto schemas. */
export function external(sources: readonly Source[]): External[] {
    return sources.flatMap(source => {
        const content = source.content ?? readFileSync(source.absPath, "utf8")
        const pkg = content.match(/^package\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;/m)?.[1]
        if (!pkg) fail(source.absPath, "legacy schema has no protobuf package")
        return [...content.matchAll(/^(?:message|enum)\s+([A-Za-z_]\w*)\s*\{/gm)].map(match => ({ name: match[1]!, package: pkg, named: source.named, absPath: source.absPath }))
    })
}
