import type { InventoryT } from "../inventory"
import type { ResidenceT } from "../residence"
import type { AcquisitionT } from "../acquisition"
import { MODEL_PROTOCOL, type ModelsState } from "../types"

/** Project disk, residency and transfer snapshots without duplicating their state. */
export function State(opts: { root: string; inventory: InventoryT; residence: ResidenceT; acquisition: AcquisitionT }) {
    function read(): ModelsState {
        return { root: opts.root, downloads: opts.acquisition.downloads(), resident: opts.residence.current,
            cached: opts.inventory.current.map(model => ({ ...model, resident: opts.residence.has(model.id) })) }
    }
    return { read: read, protocol: () => MODEL_PROTOCOL }
}
