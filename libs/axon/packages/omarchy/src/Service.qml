import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland

import "../components"
import "../views/voice"

/**
 * The daemon link, shared by every view in this plugin.
 *
 * ── Why a service ───────────────────────────────────────────────────────────
 *
 * The bar widget and the browser are separate entry points that cannot see
 * each other. Each owning its own `Machine` meant two transports, two copies
 * of the same state, and a browser that could not read the plugin's settings
 * because only bar widgets are handed them. One service, mounted at startup,
 * is the single answer to "what is Axon doing here".
 *
 * ── Why it shells out ───────────────────────────────────────────────────────
 *
 * The daemon speaks HTTP over a unix socket; Quickshell's `Socket` speaks raw
 * bytes and would need HTTP framing hand-written to reach it. `axon daemon
 * watch --json` is the supported interface, emits one JSON object per tick,
 * and `SplitParser` consumes exactly that shape — so the transport is a pipe
 * and a line parser rather than a protocol implementation.
 *
 * Through an interactive shell because the Axon installer puts its bin
 * directory on `~/.bashrc` and `~/.zshrc` only: `axon` does not exist on the
 * graphical session's PATH, which is what this process inherits.
 *
 * ── Why the stream is reference counted ─────────────────────────────────────
 *
 * A running watch holds the daemon at its two-second cadence, which costs an
 * `nvidia-smi` every two seconds for as long as it lives. Nobody should pay
 * that for a panel they closed, so the stream runs only while a surface is
 * open and a cheap status poll answers "is it up" the rest of the time.
 */
Item {
    id: root

    property var shell: null
    property var manifest: null

    /** The state every view binds to. */
    property alias machine: state

    /** Synthetic data instead of a daemon. Set by a view from plugin settings. */
    property bool mock: false

    /**
     * Answer "Axon is not here" even when it is. Set from plugin settings.
     *
     * The install funnel is the one flow that cannot be reached on a machine
     * that already passed through it, and it is the flow that matters most —
     * so the only way to review it is to be able to ask for it. A declared
     * setting, defaulted off and described in the manifest, rather than a
     * commented-out line someone has to remember to restore.
     *
     * It RELEASES ITSELF the moment an install reports success, so what gets
     * exercised is the whole path — offer, progress, the probe finding the
     * binary, the gate clearing — and not just the first screen. Holding it
     * past that point would turn the honest ending into the "installed but
     * not on PATH" failure and test a lie.
     */
    property bool pretendMissing: false

    /**
     * Drop the pretence and let the probe answer truthfully again.
     *
     * Called by `Install` when the script exits clean. Named for what it does
     * to this object rather than for who calls it: nothing else should need
     * it, but if something does, this is what it means.
     */
    function stopPretending() {
        if (!pretendMissing) return
        pretendMissing = false
        recheck()
    }

    Machine {
        id: state
        mock: root.mock
    }

    /**
     * The listening indicator, mounted on the SERVICE.
     *
     * It has to appear without anyone summoning it, and the service is the only
     * part of this plugin that is always loaded — a visualiser in the on-demand
     * overlay could only be seen by someone who had already opened the panel to
     * look for it, which is the opposite of the problem it solves.
     *
     * Its own window is invisible and intangible until the microphone opens, so
     * mounting it always costs nothing.
     */
    Voice {
        machine: state
        placement: root.voicePlacement
        scale: root.voiceScale
        accent: "#0094d2"
    }

    /**
     * How the listening indicator is shown. Read from the daemon's preferences
     * like every other setting, so the panel and a terminal cannot disagree.
     *
     * Defaults chosen rather than absent: "bottom" is where a status pill
     * belongs on most desktops, and a person who has never opened Settings
     * should still be able to see that dictation is listening.
     */
    readonly property string voicePlacement: {
        var p = state.preferences ? state.preferences["dictation.indicator"] : undefined
        return (p === "top" || p === "center" || p === "bottom" || p === "off") ? p : "bottom"
    }

    readonly property real voiceScale: {
        var s = state.preferences ? state.preferences["dictation.indicatorScale"] : undefined
        var n = parseFloat(s)
        return (isFinite(n) && n >= 0.5 && n <= 2.0) ? n : 1.0
    }

    /**
     * The install funnel, shared the same way the daemon link is.
     *
     * Every entry point renders the same `stage`, so an install started from
     * the bar panel is visibly running in the model browser too.
     */
    property alias install: installer

    Install {
        id: installer
        service: root
        source: root.installerSource
    }

    /** Development override for where the install script is fetched from. */
    property string installerSource: ""

    // Turning the pretence on has to reach the views, and `installed` is only
    // recomputed when the probe exits — so ask it again rather than waiting
    // for something else to.
    onPretendMissingChanged: recheck()

    // ── Interest ────────────────────────────────────────────────────────────

    property int consumers: 0

    /**
     * Open the live stream while a surface needs it. Returns nothing; the
     * caller pairs this with `release()` on close.
     *
     * A count rather than a flag: the bar panel and the browser can be open at
     * once, and the first to close must not stop the other's stream.
     */
    function acquire() {
        consumers++
    }

    function release() {
        consumers = Math.max(0, consumers - 1)
    }

    readonly property bool wanted: consumers > 0 && !root.mock

    /**
     * Closing a panel does not stop the stream immediately.
     *
     * Reattaching costs a process, and someone flicking between the dropdown
     * and the browser — or reopening a few seconds later — would pay it every
     * time and watch a populated panel go amber. The cadence it holds costs a
     * few percent of a core, which is worth spending for half a minute rather
     * than making every reopen feel cold.
     */
    Timer {
        id: linger
        interval: 30000
        repeat: false
        onTriggered: if (!root.wanted) root.stopWatch()
    }

    onWantedChanged: {
        if (wanted) {
            linger.stop()
            startWatch()
        } else {
            linger.restart()
        }
    }

    // ── Is Axon here at all ─────────────────────────────────────────────────

    Process {
        id: detect
        /*
         * Where the CLI actually lives, without asking a login shell.
         *
         * The Axon installer adds its bin directory to ~/.bashrc and ~/.zshrc
         * only, so `axon` is absent from the graphical session's PATH and the
         * obvious probe is `bash -ic command -v axon`. Measured at shell
         * startup that took 1.5 SECONDS — rc files being sourced while every
         * other plugin is loading — and the whole plugin was serialised behind
         * it: nothing could stream, prefetch, or draw until it returned.
         *
         * So the known install locations are tested directly with `sh`, which
         * sources nothing. The interactive shell survives only as the last
         * resort, for an install none of these cover, and by then it is off
         * the path that decides whether the first open feels instant.
         */
        /*
         * `axonl` is preferred where it exists, and its EXISTENCE is the
         * opt-in.
         *
         * It is the source build against the development store — a name that
         * is only on a machine someone linked a checkout onto. So finding it
         * means a developer put it there, and pointing the panel at the build
         * they are editing is what they wanted; nobody else has it and nothing
         * changes for them. That also removes the `commandPrefix` override as
         * the only way to drive a source daemon, which was a setting people
         * had to know existed.
         *
         * The two never share state: `axonl` pins NODE_ENV=development, so it
         * reads ~/.axon-dev for both the profile store and the daemon socket
         * while `axon` reads ~/.axon. Whichever this resolves to, the panel
         * talks to that one's daemon and no other.
         */
        command: ["sh", "-c",
            'for n in axonl axon; do'
            + ' for p in "$HOME/.bun/bin/$n" "$HOME/.cache/.bun/bin/$n" "$HOME/.local/bin/$n"'
            + ' /usr/local/bin/$n /usr/bin/$n; do [ -x "$p" ] && printf \'%s\\n\' "$p" && exit 0; done;'
            + ' command -v "$n" 2>/dev/null && exit 0; done;'
            + ' bash -ic "command -v axon" 2>/dev/null']
        running: true
        stdout: StdioCollector {
            waitForEnd: true
            /*
             * The LAST non-empty line, not the whole buffer.
             *
             * This process runs more than once now — `recheck()` re-arms it
             * while an install is in flight — and a collector that carried
             * anything over between runs would hand us two paths glued
             * together. Taking the last line is correct either way.
             */
            onStreamFinished: {
                var lines = String(text).trim().split("\n")
                root.axonPath = lines[lines.length - 1].trim()
            }
        }
        onExited: function (code) {
            root.installed = !root.pretendMissing && code === 0 && root.axonPath !== ""
            if (!root.installed) state.health = "missing"
            else if (state.health === "missing") state.health = "offline"
            // Nothing could run until the binary was located, so anything
            // queued while detecting starts now.
            root.drain()
            if (root.installed) {
                root.prefetch()
                // An install that landed while a panel was open should bring
                // the stream up on its own, rather than waiting for the user
                // to close and reopen the thing they are already looking at.
                if (root.wanted) root.startWatch()
            }
        }
    }

    /**
     * Ask again whether Axon is on this machine.
     *
     * The probe answers once at startup, which was enough while the binary
     * could only appear between shell sessions. It can now appear WHILE the
     * panel is open — that is the whole install flow — and a funnel that ends
     * on "installed, but the panel still says no" is worse than no funnel.
     *
     * Cheap (five `test -x` under `sh`, no shell startup) and guarded against
     * overlapping itself, so polling it every second or two is fine.
     */
    function recheck() {
        if (!detect.running) detect.running = true
    }

    /** Absolute path to the CLI, resolved once. Empty until `detect` answers. */
    property string axonPath: ""

    /**
     * Whether the resolved CLI is the source build.
     *
     * Display only, so a panel driving a checkout can say so — two daemons
     * with two stores look identical from the outside, and "why is my job not
     * there" is the question that follows.
     */
    readonly property bool sourceBuild: axonPath.indexOf("axonl") !== -1

    /** Whether an `axon` binary can be found. Null until the first probe answers. */
    property var installed: null

    /**
     * A daemon verb as an argv, with no shell in the way.
     *
     * The development override still goes through one, because it is a command
     * line rather than a binary. Everything else execs directly.
     */
    /**
     * PATH the CLI needs, prepended before it is exec'd.
     *
     * `axon` is a `#!/usr/bin/env bun` script, so finding the BINARY is not
     * enough — its interpreter has to be findable too, and the Axon installer
     * puts bun on PATH through `~/.bashrc` and `~/.zshrc` only. A graphical
     * session inherits neither, so `bash -c <abs path> daemon …` resolved the
     * script and then died with `env: 'bun': No such file or directory`.
     *
     * The old code hid this behind `bash -ic`, whose rc files supplied bun by
     * accident — at the cost of an interactive shell printing job-control
     * warnings into every reply. Naming the directories outright is both
     * faster and honest about what is actually required.
     */
    readonly property string binPath:
        '"$HOME/.bun/bin:$HOME/.cache/.bun/bin:$HOME/.local/bin:$PATH"'

    function argvFor(verb) {
        // The override is an arbitrary command line — it may name `bun`, or
        // anything else the user's shell knows about — so it still pays for an
        // interactive shell.
        if (commandOverride !== "") return ["bash", "-ic", commandOverride + " " + verb + " --json"]
        return ["bash", "-c",
            "export PATH=" + binPath + "; exec " + JSON.stringify(axonPath) + " daemon " + verb + " --json"]
    }

    /**
     * The same, for a verb carrying arguments that came from a PERSON.
     *
     * `argvFor` builds a shell command line, which is fine for the ids and
     * enum values this panel generates and NOT fine for free text: a prompt
     * containing a backtick or `$(…)` would be executed by the shell that was
     * only ever meant to find the binary. Here the arguments are separate argv
     * entries and no shell parses them.
     *
     * The development override still needs one, because it is a command line
     * rather than a path — so it keeps `bash -ic` and the caller must not send
     * untrusted text through a panel that has one set. Every real install
     * takes the direct branch.
     */
    function argvForArgs(verb, args) {
        if (commandOverride !== "") {
            var quoted = args.map(function (a) { return "'" + String(a).replace(/'/g, "'\\''") + "'" })
            return ["bash", "-ic", commandOverride + " " + verb + " " + quoted.join(" ") + " --json"]
        }
        /*
         * A shell is needed for PATH, and the arguments must never reach it.
         *
         * `$0` and `"$@"` are the resolution: the script body contains no
         * interpolated user text, and bash hands the operands to `exec`
         * verbatim — so a prompt carrying a backtick or `$(…)` is an argument,
         * never a command.
         */
        return ["bash", "-c",
                "export PATH=" + binPath + "; exec \"$0\" daemon \"$@\"",
                axonPath, verb].concat(args).concat(["--json"])
    }

    /**
     * The same, for a TOP-LEVEL verb rather than a `daemon` subcommand.
     *
     * `init` is `axon init <name>`, not `axon daemon init` — routing it
     * through the daemon builder produced "Unknown daemon subcommand: init".
     * Separate rather than a flag, because which of the two a verb belongs to
     * is a fact about the CLI, and a boolean at the call site invites getting
     * it wrong silently.
     */
    function argvForTop(verb, args) {
        if (commandOverride !== "") {
            var quoted = args.map(function (a) { return "'" + String(a).replace(/'/g, "'\\''") + "'" })
            return ["bash", "-ic", commandOverride.replace(/ daemon$/, "") + " " + verb + " " + quoted.join(" ")]
        }
        return ["bash", "-c",
                "export PATH=" + binPath + "; exec \"$0\" \"$@\"",
                axonPath, verb].concat(args)
    }

    // ── Cheap liveness, while nothing is streaming ──────────────────────────

    Process {
        id: statusProbe
        command: root.axonPath !== "" || root.commandOverride !== ""
            ? root.argvFor("status") : ["true"]
        stdout: StdioCollector {
            waitForEnd: true
            onStreamFinished: {
                if (root.wanted) return
                try {
                    var status = JSON.parse(String(text))
                    state.health = status && status.running ? "connected" : "offline"
                } catch (e) {
                    state.health = "offline"
                }
            }
        }
    }

    Timer {
        // Only while nothing is streaming — the stream is a better answer than
        // this whenever it is running.
        running: root.installed === true && !root.wanted && !root.mock
        interval: 15000
        repeat: true
        triggeredOnStart: true
        onTriggered: if (!statusProbe.running) statusProbe.running = true
    }

    // ── Commands ────────────────────────────────────────────────────────────
    //
    // Mutations are fire-and-run; the stream reports what happened. Nothing
    // here applies an optimistic change, because the daemon is the authority
    // on what is cached and what is held — a panel that drew the result it
    // hoped for would be wrong for the two seconds that matter most.

    /** The last command that failed, for a surface to show. Cleared on the next success. */
    property string lastError: ""

    /** True while a mutation is running, so a control can say it is working. */
    readonly property bool working: runner.running || pending.length > 0

    property var pending: []

    /**
     * Run one daemon verb. Queued, because a single reusable process cannot
     * serve two at once and dropping the second would lose a user's click.
     */
    function run(argv) {
        // Cleared on dispatch, not on success: an error left standing while a
        // new command runs describes the previous one, which is the wrong
        // thing to be reading when the current one fails differently.
        lastError = ""
        pending = pending.concat([argv])
        drain()
    }

    /**
     * The same queue, for a verb whose arguments came from a PERSON.
     *
     * `run()` builds a shell command line, which is right for the ids and enum
     * values this panel generates and wrong for anything typed: `JSON.stringify`
     * quotes a value but does not escape `$` or a backtick, so `$(…)` inside
     * those quotes is still run by the bash that was only ever meant to find
     * the binary. Queued as an argv array instead, and dispatched through
     * `argvForArgs`, where no shell ever parses the operands.
     */
    function runArgs(verb, args) {
        lastError = ""
        pending = pending.concat([{ verb: verb, args: args }])
        drain()
    }

    function drain() {
        if (runner.running || pending.length === 0) return
        // Nothing can run before the binary is located; `detect` drains again.
        if (root.axonPath === "" && root.commandOverride === "") return
        var next = pending[0]
        pending = pending.slice(1)
        // A string is a shell command line this panel composed; an object
        // carries operands that must not reach a shell. See runArgs().
        runner.command = typeof next === "string"
            ? argvFor(next)
            : argvForArgs(next.verb, next.args)
        runner.running = true
    }

    Process {
        id: runner
        running: false
        stdout: StdioCollector { waitForEnd: true }
        stderr: StdioCollector { waitForEnd: true }
        onExited: function (code) {
            if (code === 0) {
                root.lastError = ""
            } else {
                // Reported, never swallowed: a delete that silently did
                // nothing is worse than one that says why.
                root.lastError = meaningful(String(stderr.text || "")) || ("command failed (" + code + ")")
                console.warn("arclabs.axon: daemon command failed:", root.lastError)
            }
            root.drain()
        }
    }

    /** Declare the video-memory ceiling. `clear` removes the declaration. */
    function setBudget(value) { run("budget " + value) }

    /** Arrange, or stop, the daemon starting with the machine. */
    function setBoot(on) { run("boot " + (on ? "on" : "off")) }

    /** Whether running a model may load it first. */
    function setAutoload(on) { run("autoload " + (on ? "on" : "off")) }

    /**
     * Any named preference, by key.
     *
     * One setter rather than one per setting — the panel names the key and the
     * daemon stores it. `setBudget` and `setAutoload` keep their own verbs
     * because the daemon INTERPRETS those (a ceiling the admission check reads,
     * a switch the run path obeys); everything dictation stores is a choice the
     * daemon only hands back.
     */
    function setPreference(key, value) {
        runArgs("preference", [String(key), String(value)])
    }

    /**
     * Register the stored dictation chord with the compositor.
     *
     * Called after the chord or the mode changes. Separate from the write
     * because the daemon owns the compositor binding and the panel owns
     * neither — a setting is stored, and then the thing that can act on it is
     * asked to. The daemon does the same at every start, so this is what makes
     * the change take effect NOW rather than at next login.
     */
    function bindDictation() { run("dictate bind") }

    /**
     * Search the catalogue and hand the results to `Machine`.
     *
     * Its own process rather than the command queue: a search is a READ whose
     * answer is wanted, while the queue exists for mutations whose result
     * arrives on the stream. Sharing one runner would also make a slow search
     * hold up a delete.
     *
     * The daemon is cache-first, so a repeated query answers off disk and only
     * a cold one waits on the network — which is why this can be driven
     * straight from typing without a debounce fighting it.
     */
    function searchCatalogue(query, capability) {
        var q = String(query || "")
        var cap = String(capability || "")
        // Local scopes are answered from what is already here; capability is a
        // question for the registry, so it belongs in the key and the request.
        if (cap === "all" || cap === "cached" || cap === "resident") cap = ""
        /*
         * The key carries EVERY input to the answer.
         *
         * Sort and the fits filter change what comes back, so a key that
         * ignored them would serve a relevance-ordered page for a
         * stars-ordered query — the cache silently answering a different
         * question from the one asked.
         */
        var k = (cap !== "" ? cap + ":" : "") + sort + ":" + (fitsOnly ? "fits:" : "") + q
        pendingQuery = q
        pendingCapability = cap

        // Answer from memory FIRST, always. The daemon's own cache replies in
        // about a millisecond, but reaching it costs a process — and a panel
        // that spawns one before it can draw anything is a panel that takes
        // half a second to open however fast the answer is. Holding the last
        // answer here is what makes a reopen, and a repeated query, instant.
        if (catalogueCache[k] !== undefined) state.catalogue = catalogueCache[k]

        if (catalogProcess.running) return
        catalogProcess.command = argvFor("catalog " + JSON.stringify(q)
            + (cap !== "" ? " --capability " + cap : "")
            + (sort !== "relevance" ? " --sort " + sort : "")
            + (fitsOnly ? " --fits" : ""))
        inFlightQuery = q
        inFlightCapability = cap
        catalogProcess.running = true
    }

    property string pendingCapability: ""
    property string inFlightCapability: ""

    /** query → results, for as long as the shell lives. */
    property var catalogueCache: ({})

    // ── Model detail ────────────────────────────────────────────────────────
    //
    // A listing is deliberately thin — forty rows each carrying a README would
    // be a slow search to make one detail page fast — so the card, the weight
    // list and the download count are asked for once, when something is
    // selected, and kept.

    /** id → full detail record. */
    property var detailCache: ({})
    property string detailWanted: ""

    /** The detail for `id`, or null while it is still being fetched. */
    function detailFor(id) {
        return detailCache[String(id)] !== undefined ? detailCache[String(id)] : null
    }

    function loadDetail(id) {
        var key = String(id || "")
        if (key === "" || detailCache[key] !== undefined) return
        detailWanted = key
        if (detailProcess.running) return
        detailProcess.command = argvFor("model " + JSON.stringify(key))
        detailInFlight = key
        detailProcess.running = true
    }

    property string detailInFlight: ""
    readonly property bool loadingDetail: detailProcess.running

    Process {
        id: detailProcess
        running: false
        stdout: StdioCollector {
            waitForEnd: true
            onStreamFinished: {
                try {
                    var parsed = JSON.parse(String(text))
                    if (parsed && parsed.id) {
                        var next = {}
                        for (var k in root.detailCache) next[k] = root.detailCache[k]
                        next[root.detailInFlight] = parsed
                        root.detailCache = next
                    }
                } catch (e) {
                    console.warn("arclabs.axon: model detail reply was not JSON")
                }
            }
        }
        onExited: {
            if (root.detailWanted !== root.detailInFlight) root.loadDetail(root.detailWanted)
        }
    }

    /**
     * Warm the empty query before anyone opens anything.
     *
     * The browser opens on an empty query, so that one answer decides whether
     * the first impression is instant or a spinner. Fetched once the binary is
     * located, while nothing is on screen and nobody is waiting.
     */
    function prefetch() {
        if (catalogueCache[""] !== undefined) return
        searchCatalogue("", "")
    }

    property string pendingQuery: ""
    property string inFlightQuery: ""
    /** True while a query is outstanding, so a surface can say "searching". */
    readonly property bool searching: catalogProcess.running

    Process {
        id: catalogProcess
        running: false
        stdout: StdioCollector {
            waitForEnd: true
            onStreamFinished: {
                try {
                    var parsed = JSON.parse(String(text))
                    if (parsed && parsed.models) {
                        // Keyed by the query that was in flight, not the one
                        // being typed now — otherwise a slow reply files itself
                        // under a later query and answers it wrongly forever.
                        var next = {}
                        for (var k in root.catalogueCache) next[k] = root.catalogueCache[k]
                        // The SAME key shape searchCatalogue built. Two
                        // spellings of one key means every reply files itself
                        // where no read will look for it, and the cache never
                        // hits.
                        var key = (root.inFlightCapability !== "" ? root.inFlightCapability + ":" : "")
                            + root.sort + ":" + (root.fitsOnly ? "fits:" : "") + root.inFlightQuery
                        next[key] = parsed.models
                        root.catalogueCache = next
                        // Paging is the daemon's answer, not a guess from the
                        // row count: a full page is not proof another exists.
                        root.hasMore = parsed.more === true
                        root.loadingMore = false
                        if (root.inFlightQuery === root.pendingQuery
                            && root.inFlightCapability === root.pendingCapability) {
                            state.catalogue = parsed.models
                        }
                    }
                } catch (e) {
                    console.warn("arclabs.axon: catalog reply was not JSON")
                }
            }
        }
        onExited: {
            root.loadingMore = false
            // Someone kept typing while this was out. Run the latest, not the
            // one that happened to be in flight — otherwise the results shown
            // are for a query the person has already moved past.
            if (root.pendingQuery !== root.inFlightQuery || root.pendingCapability !== root.inFlightCapability)
                root.searchCatalogue(root.pendingQuery, root.pendingCapability)
        }
    }

    /** Fetch a weight to this machine. `file` names it inside a multi-weight repository. */
    function fetchModel(id, file) {
        run("fetch " + JSON.stringify(id) + (file ? " " + JSON.stringify(file) : ""))
    }

    /** Delete a cached weight. Unloads it first, daemon-side. */
    function removeModel(id) { run("remove " + JSON.stringify(id)) }

    // ── Catalogue paging and ordering ───────────────────────────────────────

    /**
     * How results are ordered, and whether they are filtered to what fits.
     *
     * Held here rather than on the surface for the same reason the scope is:
     * the overlay is destroyed between opens, and a sort someone chose should
     * survive that. Both are read by `searchCatalogue` when it builds a query.
     */
    property string sort: "relevance"
    property bool fitsOnly: false

    /**
     * A COLD search — one with nothing cached to show while it runs.
     *
     * Distinct from `searching`, which is true for every query including ones
     * answered instantly off disk. Only a cold one deserves a spinner: showing
     * one for a warm query makes an instant answer look slow.
     */
    readonly property bool searchingCold: searching && state.catalogue.length === 0

    /** More pages exist for the current query. */
    property bool hasMore: false
    property bool loadingMore: false

    /**
     * Fetch the next page, appending rather than replacing.
     *
     * Guarded on `loadingMore` because the trigger is a scroll position, which
     * fires continuously while someone is at the bottom — without it, one
     * flick at the end of the list queues a dozen identical requests.
     */
    function loadMore() {
        if (loadingMore || !hasMore) return
        loadingMore = true
        run("catalog --more")
    }

    // ── Handoffs ────────────────────────────────────────────────────────────
    //
    // The panel exists to hand off. These two verbs are how, and they live on
    // the service because it is what already knows where the CLI is — a row or
    // a header building its own command line would be a second opinion about
    // the environment, and there were about to be two of them.

    /**
     * Open a terminal ON an agent — the single most important verb here.
     *
     * `omarchy-launch-tui` is the wrapper the desktop uses for exactly this: a
     * real window with the right app-id, styled as Omarchy styles its own.
     *
     * PATH is exported because the compositor hands the child the graphical
     * session's environment, which has neither `axon` nor the `bun` its shebang
     * needs. The window is held open ONLY on a non-zero exit — a refusal
     * otherwise flashes a terminal and vanishes with the reason unread, while a
     * session someone quits should close as they expect.
     */
    signal handedOff()

    function openTerminal(ref) {
        /*
         * The panel gets out of the way.
         *
         * Opening a terminal is the whole point of this surface, and leaving
         * an overlay on top of the window it just spawned means the person has
         * to dismiss us before they can use what they asked for. Announced
         * rather than done here: the service does not own a window, so it says
         * a handoff happened and whichever surface is open closes itself.
         */
        handedOff()
        var binary = axonPath !== "" ? axonPath : "axon"
        Quickshell.execDetached([
            "omarchy-launch-tui", "--app-id=org.omarchy.axon",
            "bash", "-lc",
            'export PATH="$HOME/.bun/bin:$HOME/.cache/.bun/bin:$HOME/.local/bin:$PATH"; '
                + JSON.stringify(binary) + " " + JSON.stringify(String(ref)) + " -a"
                + '; code=$?; if [ "$code" -ne 0 ]; then echo; '
                + 'read -rsn1 -p "axon exited with $code — press any key to close"; fi',
        ])
    }

    /**
     * An agent's source, in the EDITOR — never the file manager.
     *
     * `xdg-open` on a directory opens a file browser, which is not what "open
     * the agent" means to anyone who writes one. `omarchy-launch-editor`
     * resolves whatever the person chose in Omarchy's own defaults.
     *
     * Takes a path so it can open one FILE as well as the project — the agent
     * detail view links `axon.config.ts` and `src/boot.vue` directly.
     */
    function openEditor(path) {
        if (!path || String(path) === "") return
        Quickshell.execDetached(["omarchy-launch-editor", String(path)])
    }

    // ── The Oma window ──────────────────────────────────────────────────────

    /**
     * Hide the agent when you click away from it.
     *
     * A summoned window that stays after you have moved on is one you have to
     * dismiss twice — once by looking elsewhere and once by remembering the
     * keybind. Hyprland has no rule for "hide a special workspace on focus
     * loss", so the only way to get it is to watch focus, and the service is
     * the one part of this plugin that is always loaded.
     *
     * `hyprctl` rather than `Hyprland.dispatch()`: this compositor parses
     * dispatchers as Lua now, which that binding does not speak — the same
     * discovery the workspaces plugin documents beside its own shell-out.
     *
     * Deliberately NOT a focus grab. Grabbing would make every click outside
     * belong to us, including the one that was meant for the window
     * underneath; watching means the click lands where it was aimed and the
     * agent gets out of the way afterwards.
     */
    readonly property string omaAppId: "org.omarchy.axon.oma"

    Connections {
        target: Hyprland
        function onActiveToplevelChanged() { root.hideOmaIfUnfocused() }
        function onFocusedWorkspaceChanged() { root.hideOmaIfUnfocused() }
    }

    function hideOmaIfUnfocused() {
        var active = Hyprland.activeToplevel
        // No active window at all is a transient state between focus changes,
        // not a click elsewhere. Acting on it would hide the window in the gap
        // between summoning it and it taking focus.
        if (!active) return
        if (String(active.lastIpcObject ? active.lastIpcObject["class"] : "") === omaAppId) return

        // Only when it is actually showing. Toggling blind would SUMMON it on
        // every unrelated focus change, which is the exact opposite behaviour.
        omaVisible.running = true
    }

    /**
     * Ask the compositor whether the workspace is up, and hide it if so.
     *
     * A read before the toggle, because `toggle_special` is symmetric: firing
     * it without knowing the current state is as likely to show the window as
     * to hide it.
     */
    Process {
        id: omaVisible
        running: false
        command: ["sh", "-c",
            "hyprctl monitors -j | grep -q '\"special:oma\"' && "
            + "hyprctl eval 'hl.dispatch(hl.dsp.workspace.toggle_special(\"oma\"))'"]
    }

    // ── Where you were ──────────────────────────────────────────────────────
    //
    // Held on the SERVICE, not the surface, because the overlay is destroyed
    // between opens. A person who was looking at Fleet and reopens the panel
    // should still be looking at Fleet — the alternative is a window that
    // forgets, which reads as a different window each time.

    /** "models" or "agents" — which half of the product was last open. */
    property string lastSection: "models"

    /**
     * The last scope within each section, keyed by section.
     *
     * Per section rather than one value: the two halves have disjoint scopes,
     * and a single memory would restore "audio" onto the agents page, where it
     * means nothing. Storing the pair is what makes the rail and the top bar
     * agree — the bug they disagreed over was this being absent entirely.
     */
    property var lastScope: ({ models: "server", agents: "fleet" })

    /** The remembered scope for a section, or its index page. */
    function scopeFor(section) {
        var name = String(section)
        var remembered = lastScope ? lastScope[name] : undefined
        if (typeof remembered === "string" && remembered !== "") return remembered
        return name === "agents" ? "fleet" : "server"
    }

    function rememberScope(section, scope) {
        var next = {}
        for (var key in lastScope) next[key] = lastScope[key]
        next[String(section)] = String(scope)
        lastScope = next
    }

    // ── Optimistic intent ───────────────────────────────────────────────────
    //
    // The daemon is the authority on what is loaded and what is downloading,
    // and its answer arrives on the next stream tick — up to half a second
    // after a click. A row that waited for it looked inert at exactly the
    // moment someone was checking whether their click registered.
    //
    // So a click records an INTENT, the row renders it immediately, and the
    // daemon's own state supersedes it as soon as it disagrees. Nothing is
    // ever left claiming a state the daemon did not reach: `reconcile` clears
    // an intent the moment reality matches it, and `intentTtl` clears one that
    // reality never reached, so a failed load reverts rather than sticking.

    /** model id -> { verb, at }. Empty when nothing is pending. */
    property var intents: ({})

    /** How long an unfulfilled intent is believed. Beyond this the daemon wins. */
    readonly property int intentTtl: 8000

    function intend(id, verb) {
        var next = {}
        for (var key in intents) next[key] = intents[key]
        next[String(id)] = { verb: String(verb), at: Date.now() }
        intents = next
    }

    function forget(id) {
        var next = {}
        for (var key in intents) if (key !== String(id)) next[key] = intents[key]
        intents = next
    }

    /** What a row should show for `id`, or "" when the daemon's own state stands. */
    function intentAt(id) {
        var held = intents ? intents[String(id)] : undefined
        if (!held) return ""
        if (Date.now() - held.at > intentTtl) return ""
        return held.verb
    }

    /**
     * Drop intents the daemon has caught up with.
     *
     * Called on every tick. Comparing against the daemon's own view is what
     * keeps this from being a second source of truth: an intent only ever
     * survives until the thing it predicted is observably true or false.
     */
    function reconcile() {
        if (!intents) return
        var changed = false
        var next = {}
        for (var key in intents) {
            var held = intents[key]
            var resident = state.isResident ? state.isResident(key) : false
            var settled = (held.verb === "load" && resident) || (held.verb === "unload" && !resident)
            if (settled || Date.now() - held.at > intentTtl) { changed = true; continue }
            next[key] = held
        }
        if (changed) intents = next
    }

    /** True while a download for `id` is in flight, as the daemon reports it. */
    function transferring(id) {
        if (!state || !state.downloads) return false
        for (var i = 0; i < state.downloads.length; i++) {
            var d = state.downloads[i]
            if (d.state !== "downloading") continue
            if (String(d.model).indexOf(String(id)) === 0 || String(id).indexOf(String(d.model)) === 0) return true
        }
        return false
    }

    /** Stop a transfer that is in flight. */
    function cancelDownload(id) { run("cancelDownload " + JSON.stringify(id)) }

    // ── Scaffolding ─────────────────────────────────────────────────────────

    /** The agent currently being scaffolded, or "". Drives the row's spinner. */
    property string creating: ""
    /** Why the last scaffold failed, or "". */
    property string createError: ""

    /**
     * Create an agent, without opening a terminal.
     *
     * It used to launch `axon init` in a visible window, on the reasoning that
     * installing modules and resolving a cognet is worth watching. In practice
     * it is not: a terminal appearing, scrolling, and demanding a keypress to
     * close is a bigger interruption than the thing it reports, and it takes
     * focus away from the panel the person is still using.
     *
     * So it runs behind the panel and the ROW reports it — which is the same
     * rule the download rows already follow. The cost is that progress is a
     * spinner rather than a log, and the compensation is that failure is
     * surfaced rather than flashed: `createError` holds whatever it said.
     */
    function createAgent(name) {
        if (creating !== "") return
        creating = String(name)
        createError = ""
        createProcess.command = argvForTop("init", [String(name)])
        createProcess.running = true
    }

    Process {
        id: createProcess
        running: false
        stdout: StdioCollector { waitForEnd: true }
        stderr: StdioCollector { waitForEnd: true }
        onExited: function (code) {
            if (code !== 0) {
                // Reported, never swallowed. A scaffold that refused has
                // something to say, and with no terminal this is the only
                // place left to say it.
                root.createError = meaningful(String(stderr.text || ""))
                    || ("axon init exited with " + code)
            }
            root.creating = ""
        }
    }

    /** Stop a running agent. The daemon owns the process; this only asks. */
    function stopAgent(sessionId) { run("stopAgent " + JSON.stringify(sessionId)) }

    /** Load a cached weight by hand, held for the person until they release it. */
    function loadModel(id) { intend(id, "load"); run("pin " + JSON.stringify(id)) }

    /** Release a loaded weight without deleting it. */
    function unloadModel(id) { intend(id, "unload"); run("unload " + JSON.stringify(id)) }

    // ── Inference ───────────────────────────────────────────────────────────
    //
    // Its own process, not the command queue. The queue is for mutations whose
    // result arrives on the state stream; a run is a READ whose answer is the
    // entire point, and it can take seconds — sharing the queue would make one
    // slow generation hold up every load and delete behind it.

    /** The model the last run was against, so a late reply can be matched to it. */
    property string runningModel: ""
    /** True while an inference is out. One at a time, visibly. */
    readonly property bool inferring: inferProcess.running

    /** Emitted with the raw result, or with `error` set when it failed. */
    signal inferred(string model, string text, string error)

    /**
     * Run one inference against a weight that is already resident.
     *
     * Does NOT load first. That is the daemon's rule and the panel must not
     * quietly work around it: an implicit load is a memory claim the person
     * did not make, so a cold model is reported as cold and loading stays a
     * decision they take.
     */
    function runModel(model, input) {
        if (inferProcess.running) return
        runningModel = String(model)
        inferBuffer = ""
        inferError = ""
        inferProcess.command = argvForArgs("run", [String(model), "-p", String(input)])
        inferProcess.running = true
    }

    property string inferBuffer: ""
    property string inferError: ""

    Process {
        id: inferProcess
        running: false
        stdout: StdioCollector {
            waitForEnd: true
            onStreamFinished: root.inferBuffer = String(text)
        }
        stderr: StdioCollector {
            waitForEnd: true
            onStreamFinished: root.inferError = String(text)
        }
        onExited: function (code) {
            /*
             * The reason for a failure is on STDOUT, not stderr.
             *
             * `--json` means "one result object on stdout", and that holds for
             * `{ ok: false, code, message }` exactly as it does for a success.
             * Reading stderr on failure found nothing and reported "exited
             * with code 1" — the panel throwing away the only sentence that
             * said what went wrong.
             *
             * stderr is still the fallback, for a process that died before it
             * could state a result at all.
             */
            if (code !== 0) {
                var reason = root.inferError.trim()
                try {
                    var failure = JSON.parse(root.inferBuffer.trim())
                    if (failure && failure.message) reason = String(failure.message)
                } catch (e) { /* not JSON — keep stderr */ }
                root.inferred(root.runningModel, "", reason || ("exited with code " + code))
                return
            }
            // `--json` wraps the result so a transcript, a vector and a
            // completion all arrive intact. A body that does not parse is
            // reported as-is rather than discarded — the CLI printing
            // something unexpected is worth seeing, not swallowing.
            var body = root.inferBuffer.trim()
            var text = body
            try {
                var parsed = JSON.parse(body)
                if (parsed && parsed.result !== undefined) {
                    text = typeof parsed.result === "string"
                        ? parsed.result
                        : JSON.stringify(parsed.result, null, 2)
                }
            } catch (e) { /* not JSON — show what came back */ }
            root.inferred(root.runningModel, text, "")
        }
    }

    // ── The stream ──────────────────────────────────────────────────────────

    /**
     * What produces the stream. Empty means the installed CLI.
     *
     * Overridable so a source checkout can be pointed at without a published
     * binary — the published CLI is what a user has, and a developer working
     * on the daemon has neither the same version nor the same path. It arrives
     * through plugin settings rather than the environment because the shell
     * does not inherit the systemd user environment, so an env var set after
     * login never reaches it.
     *
     * `exec` so the shell replaces itself: a lingering bash between here and
     * the daemon would survive the kill that stops the watch.
     */
    property string watchOverride: ""

    /** What runs daemon verbs. Empty means the installed CLI. See `watchOverride`. */
    property string commandOverride: ""

    readonly property string commandPrefix:
        commandOverride !== "" ? commandOverride : "axon daemon"

    /**
     * What produces the state stream.
     *
     * The RESOLVED binary, not a bare `axon`. The bare name went through an
     * interactive shell and found whatever was on the user's PATH — which on a
     * developer's machine is the installed CLI, while every verb was going to
     * the source build beside it. The panel then watched one daemon's state
     * and wrote to another's, and the two stores never share anything.
     */
    readonly property string watchCommand:
        watchOverride !== ""
            ? watchOverride
            : "export PATH=" + binPath + "; exec " + JSON.stringify(axonPath) + " daemon watch --json"

    Process {
        id: watcher
        // Non-interactive: the override is still a command line and needs a
        // shell, but the resolved path supplies its own PATH and must not pay
        // for rc files — an interactive bash with no terminal prints
        // job-control warnings, and those landed in the panel as output.
        command: root.watchOverride !== ""
            ? ["bash", "-ic", root.watchCommand]
            : ["bash", "-c", root.watchCommand]
        running: false

        stdout: SplitParser {
            splitMarker: "\n"
            onRead: function (line) {
                if (String(line).trim() === "") return
                if (state.apply(line)) {
                    state.health = "connected"
                    root.backoffMs = 1000
                    // Every snapshot is a chance for an intent to have landed.
                    root.reconcile()
                }
            }
        }

        onExited: function (code) {
            // Only a restart if something still wants the stream. A watch that
            // ended because the last panel closed is not a failure.
            if (!root.wanted) {
                state.health = root.installed === false ? "missing" : "offline"
                return
            }
            state.health = "offline"
            restart.interval = root.backoffMs
            // Capped, and doubling: a daemon that cannot start must not be
            // respawned in a tight loop for as long as a panel stays open.
            root.backoffMs = Math.min(root.backoffMs * 2, 30000)
            restart.start()
        }
    }

    /** Delay before the next respawn, doubling on each failure. */
    property int backoffMs: 1000

    Timer {
        id: restart
        repeat: false
        onTriggered: if (root.wanted) root.startWatch()
    }

    function startWatch() {
        if (root.installed === false) {
            state.health = "missing"
            return
        }
        if (watcher.running) return
        state.health = "starting"
        watcher.running = true
    }

    function stopWatch() {
        restart.stop()
        if (watcher.running) watcher.running = false
    }

    Component.onDestruction: stopWatch()
}
