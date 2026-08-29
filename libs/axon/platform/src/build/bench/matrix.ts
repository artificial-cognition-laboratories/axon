import type { BenchAxis, BenchCoordinate } from "@arcforge/types"

function coordinateId(axes: BenchCoordinate["axes"]): string {
    return axes.length === 0 ? "default" : axes.map(item => `${item.key}=${item.valueId}`).join(";")
}

/** Pure Cartesian expansion. Single values remain present as pinned controls. */
export function Matrix() {
    return {
        build(axes: BenchAxis[]): BenchCoordinate[] {
            let coordinates: BenchCoordinate["axes"][] = [[]]
            for (const axis of axes) {
                coordinates = coordinates.flatMap(existing => axis.values.map(value => [
                    ...existing,
                    { key: axis.key, valueId: value.id },
                ]))
            }
            return coordinates.map(selected => ({ id: coordinateId(selected), axes: selected }))
        },
    }
}

export type MatrixT = ReturnType<typeof Matrix>
