import QtQuick

/**
 * The machine's Axon state, as the daemon reports it.
 *
 * ── Not wired yet ───────────────────────────────────────────────────────────
 *
 * `axond` already measures nearly everything this shows — `MachineState`
 * carries capacity, live usage, a 60-deep sample ring, and the holds against
 * video memory with the agent that owns each. None of it is read here yet: the
 * daemon's control socket is the next piece of work, and this file is where it
 * lands.
 *
 * Until then `health` is "offline" and every figure stays null. NULL MEANS
 * UNREADABLE, NEVER ZERO — the same rule `MachineUsage` keeps on the daemon
 * side — so the panel says the daemon is down rather than drawing a machine
 * that looks idle.
 *
 * `mock` is the exception, and it is opt-in: it feeds the same shapes with
 * synthetic values so the views can be built and watched moving before there
 * is a transport. It never turns itself on.
 */
Item {
    id: root
    visible: false

    /** Feed synthetic data instead of waiting for a daemon. Set from settings. */
    property bool mock: false

    /**
     * The daemon link, as three distinct states.
     *
     * A boolean cannot say "starting", and the difference matters: a daemon
     * mid-launch and a daemon that failed to launch look identical to a user
     * staring at a dot, and only one of them is worth acting on. systemd
     * already distinguishes them, so collapsing them here would be throwing
     * away something we are given.
     *
     * "offline" | "starting" | "connected"
     */
    /**
     * "missing" | "offline" | "starting" | "connected"
     *
     * Four states, not three, because "Axon is not installed" and "the daemon
     * is not running" call for completely different things — one is an install
     * command, the other is `axon daemon up`. A surface that collapsed them
     * would ask a first-time visitor to start something they do not have.
     *
     * Driven by whatever owns the transport; the mock sets it directly.
     */
    property string health: mock ? "connected" : "offline"

    readonly property bool connected: health === "connected"

    /**
     * Whether there is anything to draw, regardless of the link's state.
     *
     * Views bind to THIS, not to `connected`. A reconnecting stream still has
     * the last reading in hand, and blanking a populated panel because the
     * transport is a few hundred milliseconds from reattaching is how an
     * instant reopen was made to look like a cold start. The dot reports the
     * link; the panel reports the machine.
     */
    readonly property bool hasData: capacity !== null && usage !== null

    /** One line a human can act on. Empty while connected. */
    readonly property string detail: {
        if (health === "connected") return ""
        if (health === "starting") return "Axon daemon starting"
        if (health === "missing") return "Axon is not installed"
        return "Axon daemon not running"
    }

    /** MachineCapacity — cores, ram, vram, gpu, vramSource. Null until read. */
    property var capacity: null

    /** MachineUsage — vramUsed, gpuUtil, ramAvailable, cpuUtil, load, at. Null until read. */
    property var usage: null

    /** Bytes held by live Axon holders across this machine. Null until read. */
    property var held: null

    /** The declared video-memory ceiling, or null when the card's own size is the limit. */
    property var budget: null

    /** Lifecycle status as the daemon reports it — pid, uptime, version, socket. */
    property var daemon: null

    /** Whether the daemon starts with the machine, and whether this platform can. */
    property var boot: null

    /** Hold[] — { pid, agent, role, model, bytes }. One row per resident weight. */
    property var holds: []

    /** ModelRecord[] — every weight fetched onto this disk. */
    property var cached: []

    /**
     * The daemon's switches, as it reports them.
     *
     * Read from the daemon rather than remembered here: a preference the panel
     * held its own copy of would disagree the moment someone ran
     * `axon daemon autoload off` in a terminal.
     */
    property var preferences: ({})

    /**
     * What dictation is doing, from the daemon's own stream.
     *
     * Held here like every other reading rather than polled by whoever needs
     * it: the feature has no window by design, so "is the microphone open" is
     * unanswerable unless a surface is told continuously.
     */
    property var dictation: ({})
    readonly property bool dictating: !!dictation && dictation.recording === true

    /** Whether running a model may load it first. On unless the daemon says otherwise. */
    readonly property bool autoload: preferences.autoload !== false

    /**
     * Download[] — transfers in flight, and ones that recently ended.
     *
     * Rides the state stream rather than being polled, because a download is
     * machine state: the daemon owns it, it outlives the panel that started
     * it, and a surface opened halfway through finds it already running.
     */
    property var downloads: []

    /** Just the live ones, for anything that should hide when nothing is moving. */
    readonly property var active: {
        var out = []
        for (var i = 0; i < downloads.length; i++) {
            if (downloads[i].state === "downloading") out.push(downloads[i])
        }
        return out
    }

    /** AgentRecord[] — every live agent this daemon can see. */
    property var agents: []

    /** Every agent PROJECT on this machine, running or not. See agents.installed. */
    property var installed: []

    /**
     * Who is signed in, as the daemon reads it off the store.
     *
     * `null` until the first snapshot, which is NOT the same as "signed out" —
     * a gate that treated an unknown identity as absent would flash a login
     * wall on every open before the stream answered.
     */
    property var identity: null

    /** True only once the daemon has said so. See `identity`. */
    readonly property bool signedIn: !!identity && identity.signedIn === true

    /**
     * Job[] — work delegated to an agent, newest first.
     *
     * Carried, though nothing renders it: the daemon publishes jobs and
     * `axon job` manages them, and the fleet page will launch one. Dropping
     * the field with the view would mean re-plumbing it to add the launcher.
     */
    property var jobs: []

    /**
     * What can be downloaded — the browser's search space.
     *
     * Real one comes from `models.search(query)`, which is cache-first and
     * marks every row with what this machine already has. Shape here is the
     * same `ModelRecord`, so the views never learn the difference.
     */
    property var catalogue: []

    /** MachineUsage[] — recent readings, oldest first. What the sparklines draw. */
    property var samples: []

    /**
     * Axon's own consumption over the same window as `samples`.
     *
     * One field of `MachineUsage.axon` per reading, in the units the matching
     * chart draws. Null propagates: a reading the daemon could not attribute
     * contributes null rather than zero, and `Sparkline` treats a
     * non-finite value as no data instead of a line along the floor.
     *
     * Derived rather than stored — one array, so the machine's total and our share cannot drift apart.
     */
    function axonSeries(field) {
        var out = []
        if (!samples) return out
        for (var i = 0; i < samples.length; i++) {
            var share = samples[i].axon
            out.push(share ? share[field] : null)
        }
        return out
    }

    /** Whether the daemon could attribute ANY of this window to Axon. */
    readonly property bool attributed: {
        if (!samples) return false
        for (var i = 0; i < samples.length; i++) if (samples[i].axon) return true
        return false
    }

    // ── Fleet, derived ──────────────────────────────────────────────────────
    // These live here rather than in a view because they are facts about the
    // data, and two views asking the same question must not answer it twice.

    /** Every live agent, including ones spawned by another. */
    readonly property int agentCount: agents ? agents.length : 0

    /** Agents a person started. A record with no parent is a user-owned root. */
    readonly property int rootAgentCount: {
        if (!agents) return 0
        var n = 0
        for (var i = 0; i < agents.length; i++)
            if (!agents[i].parentSessionId) n++
        return n
    }

    /** Distinct project roots in play. Contention is local, so repos are the grouping that matters. */
    readonly property int repoCount: {
        if (!agents) return 0
        var seen = {}
        var n = 0
        for (var i = 0; i < agents.length; i++) {
            var root = agents[i].projectRoot
            if (root && !seen[root]) { seen[root] = true; n++ }
        }
        return n
    }

    /**
     * Search what can be downloaded, within one capability scope.
     *
     * The daemon's `search` is cache-first and asynchronous; this stands in
     * for it synchronously against `catalogue`. When the transport lands the
     * views keep their shape and this becomes a request.
     */
    /**
     * A catalogue row, restamped against what is on this disk RIGHT NOW.
     *
     * The daemon marks rows when it answers a search, and that answer is then
     * cached — so a model downloaded afterwards kept saying `cached: false`
     * for as long as the results stayed on screen. The row never became "on
     * disk" after its own download finished, which is the one moment someone
     * is watching it.
     *
     * Matched on owner and name, because a cached specifier carries the pin
     * and inner path (`…@main/onnx/model.onnx`) while a listing names the
     * repository alone — the same comparison the daemon makes, made again
     * here because only this side knows both lists at this instant.
     */
    function local(row) {
        for (var i = 0; i < cached.length; i++) {
            var mine = cached[i]
            if (mine.owner !== row.owner || mine.name !== row.name) continue
            // Copied field by field, not spread. QML's JavaScript engine has
            // no object spread — `{...row}` is a syntax error that takes the
            // whole component down, and with it the service that owns it.
            var marked = {}
            for (var key in row) marked[key] = row[key]
            marked.runtime = mine.runtime
            marked.bytes = mine.bytes
            marked.path = mine.path
            marked.cached = true
            marked.resident = mine.resident === true
            return marked
        }
        return row
    }

    function search(query, scope) {
        var q = String(query || "").toLowerCase().trim()
        var out = []

        /*
         * Local scopes read the MACHINE, not the catalogue.
         *
         * A catalogue row records what was true when the registry answered,
         * and those rows are cached — so a weight downloaded afterwards still
         * said `cached: false` and "Downloaded" listed nothing, on a machine
         * with four models on its disk. What is on this disk arrives on the
         * stream and is always current; the catalogue describes a registry.
         */
        var pool = catalogue
        if (scope === "cached") pool = cached
        else if (scope === "resident") pool = residentModels

        for (var i = 0; i < pool.length; i++) {
            var m = pool[i]
            if (q !== "" && (m.name + " " + m.owner + " " + m.id).toLowerCase().indexOf(q) === -1) continue
            out.push(pool === catalogue ? local(m) : m)
        }
        return out
    }

    /** What is loaded, as records — the cached rows the holds point at. */
    /** Whether a specifier is loaded right now. The authority for optimistic intents. */
    function isResident(id) {
        for (var i = 0; i < cached.length; i++) {
            if (String(cached[i].id) === String(id)) return cached[i].resident === true
        }
        return false
    }

    readonly property var residentModels: {
        var out = []
        if (!cached || !holds) return out
        for (var i = 0; i < cached.length; i++) {
            for (var h = 0; h < holds.length; h++) {
                if (holds[h].model === cached[i].id) { out.push(cached[i]); break }
            }
        }
        return out
    }

    /** How many weights sit in each scope, for the query in play. The rail's counts. */
    function countFor(scope, query) {
        return search(query || "", scope).length
    }

    /**
     * Take one line of `axon daemon watch --json`.
     *
     * Replaces state wholesale rather than merging. The daemon sends a full
     * snapshot per tick, so a merge would only create the possibility of two
     * halves of the panel describing different instants.
     *
     * Returns false on anything unparseable, so the caller can decide whether
     * a bad line is a broken daemon or a stray byte — this must not quietly
     * keep the last good state while claiming to be connected.
     */
    function apply(line) {
        var snapshot
        try {
            snapshot = JSON.parse(String(line))
        } catch (e) {
            return false
        }
        if (!snapshot || typeof snapshot !== "object") return false

        /*
         * A PARTIAL frame carries one reading and nothing else.
         *
         * The daemon emits dictation on its own at ~16Hz while a recording is
         * open, because the full snapshot is 47KB and ticks twice a second —
         * which made the voice meter move in two steps per second and the
         * listening indicator appear up to half a second late. Merged rather
         * than applied: a partial has no `machine`, and treating it as a full
         * frame would blank every reading between beats.
         */
        if (!snapshot.machine) {
            if (snapshot.dictation === undefined) return false
            dictation = snapshot.dictation
            return true
        }

        var m = snapshot.machine
        capacity = m.capacity || null
        usage = m.usage || null
        held = (m.held === undefined || m.held === null) ? null : m.held
        budget = (m.budget === undefined) ? null : m.budget
        daemon = snapshot.daemon || null
        boot = snapshot.boot || null
        holds = m.holds || []
        samples = m.samples || []
        agents = snapshot.agents || []
        installed = snapshot.installed || []
        identity = snapshot.identity || null
        jobs = snapshot.jobs || []
        cached = snapshot.models ? (snapshot.models.cached || []) : []
        preferences = snapshot.preferences || ({})
        dictation = snapshot.dictation || ({})
        downloads = snapshot.models ? (snapshot.models.downloads || []) : []
        return true
    }

    /**
     * Ask the daemon for a fresh reading.
     *
     * Unwired: it must not pretend to have refreshed. When the socket lands
     * this becomes a request and `health` starts telling the truth.
     */
    function refresh() {
        if (mock) mockTick()
        // TEMP: 2026-09-01 — no transport yet. See CLAUDE.md, "Known Debt".
    }

    // ── Mock ────────────────────────────────────────────────────────────────
    // A random walk rather than a sine or a constant: the point of watching
    // this is judging whether the charts read well against data that jitters,
    // and neither of the tidier options would tell us.

    readonly property int mockWindow: 60

    Component.onCompleted: if (mock) mockStart()
    onMockChanged: mock ? mockStart() : mockStop()

    Timer {
        id: mockTimer
        interval: 2000
        repeat: true
        onTriggered: root.mockTick()
    }

    function mockStart() {
        capacity = {
            cores: 16,
            ram: 32 * 1024 * 1024 * 1024,
            vram: 24 * 1024 * 1024 * 1024,
            gpu: "NVIDIA GeForce RTX 4090",
            vramSource: "nvidia",
        }
        holds = [
            { pid: 34118, agent: "@cody/barry.mk3", role: "main", model: "hf:Qwen/Qwen2.5-Coder-7B", bytes: 6.2 * 1024 * 1024 * 1024 },
            { pid: 34118, agent: "@cody/barry.mk3", role: "asr", model: "hf:onnx-community/whisper-base.en", bytes: 0.4 * 1024 * 1024 * 1024 },
        ]
        catalogue = [
            { id: "hf:Qwen/Qwen2.5-Coder-7B", name: "Qwen2.5-Coder-7B", owner: "Qwen", source: "huggingface", runtime: "llama.cpp", capability: "chat", bytes: 4.7 * 1024 * 1024 * 1024, cached: true, resident: true, downloads: 412000, description: "Code-specialised Qwen2.5, 7B parameters." },
            { id: "hf:onnx-community/whisper-base.en", name: "whisper-base.en", owner: "onnx-community", source: "huggingface", runtime: "onnx", capability: "speech", bytes: 0.15 * 1024 * 1024 * 1024, cached: true, resident: true, downloads: 88000, description: "English speech recognition, base size." },
            { id: "ollama:qwen2.5-coder:1.5b", name: "qwen2.5-coder:1.5b", owner: "ollama", source: "ollama", runtime: "ollama", capability: "chat", bytes: 0.9 * 1024 * 1024 * 1024, cached: true, resident: false, downloads: 1200000, description: "Small coder model, fast on CPU." },
            { id: "hf:nomic-ai/nomic-embed-text-v1.5", name: "nomic-embed-text-v1.5", owner: "nomic-ai", source: "huggingface", runtime: "onnx", capability: "embedding", bytes: 0.27 * 1024 * 1024 * 1024, cached: true, resident: false, downloads: 640000, description: "Long-context text embeddings." },
            { id: "hf:onnx-community/silero-vad", name: "silero-vad", owner: "onnx-community", source: "huggingface", runtime: null, capability: "speech", bytes: null, cached: true, resident: false, downloads: 31000, description: "Voice activity detection. Ships eight ONNX files." },
            { id: "ollama:llama3.2:3b", name: "llama3.2:3b", owner: "ollama", source: "ollama", runtime: "ollama", capability: "chat", bytes: null, cached: false, resident: false, downloads: 3400000, description: "Meta Llama 3.2, 3B instruct." },
            { id: "hf:openai/whisper-large-v3", name: "whisper-large-v3", owner: "openai", source: "huggingface", runtime: null, capability: "speech", bytes: null, cached: false, resident: false, downloads: 2100000, description: "Multilingual speech recognition, large." },
            { id: "hf:BAAI/bge-reranker-v2-m3", name: "bge-reranker-v2-m3", owner: "BAAI", source: "huggingface", runtime: null, capability: "embedding", bytes: null, cached: false, resident: false, downloads: 190000, description: "Multilingual reranker." },
            { id: "hf:google/siglip-base-patch16-224", name: "siglip-base-patch16-224", owner: "google", source: "huggingface", runtime: null, capability: "vision", bytes: null, cached: false, resident: false, downloads: 520000, description: "Image-text embedding backbone." },
            { id: "ollama:llava:7b", name: "llava:7b", owner: "ollama", source: "ollama", runtime: "ollama", capability: "vision", bytes: null, cached: false, resident: false, downloads: 890000, description: "Vision-language assistant." },
        ]

        // Derived, never a second list. `cached` and the catalogue's `cached`
        // flag are the same fact, and a mock that lets them disagree teaches
        // the views to tolerate a disagreement the daemon will never produce.
        cached = catalogue.filter(function (m) { return m.cached })

        agents = [
            { pid: 34118, sessionId: "edf3365b", agentName: "@cody/barry.mk3", projectRoot: "/home/cody/git/arclabs", startedAt: new Date(Date.now() - 13 * 60000).toISOString() },
            { pid: 34220, sessionId: "a91c40de", agentName: "@cody/zero", projectRoot: "/home/cody/git/arclabs", startedAt: new Date(Date.now() - 4 * 60000).toISOString(), parentSessionId: "edf3365b" },
            { pid: 34288, sessionId: "c30ab7f1", agentName: "@cody/probe", projectRoot: "/home/cody/git/arclabs", startedAt: new Date(Date.now() - 2 * 60000).toISOString(), parentSessionId: "a91c40de" },
            { pid: 35002, sessionId: "77b1e2aa", agentName: "@cody/scout", projectRoot: "/home/cody/git/omarchy-lab", startedAt: new Date(Date.now() - 92 * 60000).toISOString() },
        ]

        samples = []
        for (var i = 0; i < mockWindow; i++) mockTick()
        mockTimer.start()
    }

    function mockStop() {
        mockTimer.stop()
    }

    /** One reading, walked from the last. */
    function mockTick() {
        var previous = samples.length ? samples[samples.length - 1] : null
        var vramTotal = capacity ? capacity.vram : 0
        var ramTotal = capacity ? capacity.ram : 0

        function walk(from, step, lo, hi) {
            var next = from + (Math.random() - 0.5) * step
            return Math.max(lo, Math.min(hi, next))
        }

        var vramUsed = previous ? walk(previous.vramUsed, vramTotal * 0.06, vramTotal * 0.25, vramTotal * 0.82)
                                : vramTotal * 0.45
        var gpuUtil = previous ? walk(previous.gpuUtil, 26, 2, 99) : 38
        var cpuUtil = previous ? walk(previous.cpuUtil, 18, 3, 96) : 24
        var ramAvailable = previous ? walk(previous.ramAvailable, ramTotal * 0.04, ramTotal * 0.2, ramTotal * 0.7)
                                    : ramTotal * 0.45

        var next = samples.slice()
        next.push({
            vramUsed: vramUsed,
            gpuUtil: gpuUtil,
            cpuUtil: cpuUtil,
            ramAvailable: ramAvailable,
            load: cpuUtil / 100 * capacity.cores,
            held: 0,
            at: Date.now(),
        })
        if (next.length > mockWindow) next.shift()
        samples = next
        usage = next[next.length - 1]

        // Axon's share tracks its holds, drifting only as weights load and
        // unload — so it walks far more slowly than the machine around it.
        var holdTotal = 0
        for (var i = 0; i < holds.length; i++) holdTotal += holds[i].bytes
        var previousHeld = next.length > 1 ? next[next.length - 2].held : holdTotal
        held = Math.min(vramUsed, walk(previousHeld, vramTotal * 0.012, holdTotal * 0.92, holdTotal))
        next[next.length - 1].held = held
        samples = next.slice()
    }
}
