import { err } from "@arcforge/err"
import type { AxesHandle } from "./axes"
import type { Domain, Metric } from "./types"

/**
 * Domains, derived from the axes that declare them.
 *
 * Derived rather than declared separately because a domain with no axes is a
 * group nothing is compared within, and an axis naming a domain that does not
 * exist is a typo the type system cannot catch. Making the axes the source
 * removes both states.
 *
 * `euclidean` is the default because values are bounded to [0,1] and magnitude
 * is usually the signal — "mildly wary" and "terrified" must not compare as
 * identical. Cosine is opt-in, for domains where only the shape of a profile
 * matters (a big fast thing and a small fast thing are alike in FORM).
 */
export function Domains(opts: {
    axes: AxesHandle
    overrides?: Readonly<Record<string, Partial<Omit<Domain, "name">>>>
}) {
    const axes = opts.axes
    const overrides = opts.overrides ?? {}

    const indices = new Map<string, number[]>()
    for (let i = 0; i < axes.length; i++) {
        const name = axes.at(i).domain
        const group = indices.get(name)
        if (group) group.push(i)
        else indices.set(name, [i])
    }

    const table = new Map<string, Domain>()
    for (const name of indices.keys()) {
        const override = overrides[name] ?? {}
        table.set(name, {
            name: name,
            weight: override.weight ?? 1,
            metric: override.metric ?? "euclidean",
        })
    }

    return {
        names(): string[] {
            return [...table.keys()]
        },

        get(name: string): Domain {
            const domain = table.get(name)
            if (!domain) throw err("LOCUS_DOMAIN_UNKNOWN", { detail: `this space declares no domain "${name}"`, context: { domain: name } })
            return domain
        },

        /** Column indices belonging to a domain, in table order. */
        axesOf(name: string): readonly number[] {
            const group = indices.get(name)
            if (!group) throw err("LOCUS_DOMAIN_UNKNOWN", { detail: `this space declares no domain "${name}"`, context: { domain: name } })
            return group
        },

        all(): Domain[] {
            return [...table.values()]
        },
    }
}

export type DomainsHandle = ReturnType<typeof Domains>
export type { Metric }
