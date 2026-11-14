import { join } from "node:path"
import { ModelStore } from "@arcforge/platform/build/project"
import { Adapters, type AdaptersT } from "./adapter"
import { Catalog, type CatalogT } from "./catalog"
import { LlamaAdapter } from "./llama"
import { OnnxAdapter } from "./onnx"
import { TransformersAdapter } from "./transformers"
import { Runtimes, type RuntimesT } from "./runtimes"
import { Inventory } from "./inventory"
import { Residence } from "./residence"
import { Acquisition } from "./acquisition"
import { Discovery } from "./discovery"
import { Activity } from "./activity"
import { Runtime } from "./runtime"
import { State } from "./state"
import type { MachineT } from "../machine"

export type ModelsOpts = {
    /**
     * Admission and residency — the machine's, not this domain's.
     *
     * A load is a claim on video memory, and the thing that owns the GPU
     * decides whether it fits. Models owning its own accounting would be the
     * second answer to "how full is the card", which is precisely the failure
     * the daemon exists to prevent.
     */
    machine: MachineT
    /** Override the weight cache. Tests point this at a scratch dir. */
    root?: string
    /** Which runtimes this daemon can execute with. Injected so a test can supply a fake. */
    adapters?: AdaptersT
    /** Optional local runtime environments. Defaults to the Axon-owned store. */
    runtimes?: RuntimesT
    /** What can be downloaded. Injected so a test never depends on Hugging Face. */
    catalog?: CatalogT
    /**
     * Whether `run` may load a weight that is not resident. Defaults to true.
     *
     * A thunk, not a value: it is a stored preference that can change while
     * the daemon runs, and a boolean captured at construction would hold
     * whatever was true at boot for the life of the process.
     */
    autoload?: () => boolean
}

export type { SearchInput } from "./discovery"

/** Compose acquisition, discovery, inventory and inference around one store and one machine. */
export function Models(opts: ModelsOpts) {
    const store = ModelStore(opts.root !== undefined ? { root: opts.root } : {})
    const runtimes = opts.runtimes ?? Runtimes()
    const adapters = opts.adapters ?? Adapters([TransformersAdapter(runtimes), OnnxAdapter(runtimes), LlamaAdapter(runtimes)])
    const catalog = opts.catalog ?? Catalog()
    const activity = Activity({ path: join(store.root, "events.jsonl") })
    const inventory = Inventory({ store: store, adapters: adapters })
    const residence = Residence({ inventory: inventory, adapters: adapters, machine: opts.machine, activity: activity, autoload: opts.autoload })
    const acquisition = Acquisition({ store: store, catalog: catalog, inventory: inventory, residence: residence, activity: activity })
    const discovery = Discovery({ catalog: catalog, machine: opts.machine, inventory: inventory, residence: residence })
    const runtime = Runtime({ runtimes: runtimes, activity: activity, residence: residence })
    const state = State({ root: store.root, inventory: inventory, residence: residence, acquisition: acquisition })
    return {
        adapters: adapters, catalog: catalog,
        protocol: state.protocol,
        search: discovery.search, more: discovery.more, hasMore: discovery.hasMore, at: discovery.at, searchFresh: discovery.searchFresh,
        state: state.read, refresh: inventory.refresh, local: inventory.local,
        runtimes: runtime.state, installRuntime: runtime.install, removeRuntime: runtime.remove,
        inspect: acquisition.inspect, fetch: acquisition.fetch, download: acquisition.download, remove: acquisition.remove,
        downloads: acquisition.downloads, cancelDownload: acquisition.cancelDownload, dismissDownload: acquisition.dismissDownload,
        load: residence.load, pin: residence.pin, unload: residence.unload,
        run: residence.run, stream: residence.stream, dispose: residence.dispose,
    }
}
export type ModelsT = ReturnType<typeof Models>
