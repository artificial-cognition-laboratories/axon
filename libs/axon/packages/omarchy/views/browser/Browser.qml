import Quickshell
import Quickshell.Wayland
import QtQuick
import qs.Commons
import qs.Ui

import "../../components"
import "../../src"
import "../../src/format.js" as Format
import "pages"

/**
 * The model browser: a centred, summoned surface for finding and installing
 * local models.
 *
 * ── Why this shape ──────────────────────────────────────────────────────────
 *
 * A rail, a header, a scrolling pane — the same frame as Axon's other two
 * registry surfaces, so the three read as one product. What differs is what
 * the rail holds: here it is SCOPE, not navigation. The task is search, pick,
 * act, and all three happen in the content pane, so nothing in the rail ever
 * changes the page.
 *
 * Search lives in the header rather than the rail because it is what ninety
 * percent of a visit consists of, and a primary action you must navigate to is
 * not primary. Detail overlays the content pane alone, leaving rail and header
 * where they are — on a keyboard surface a frame that moves is a frame you
 * have to re-find.
 *
 * Summoned with `omarchy-shell shell summon arclabs.axon`, from the bar
 * dropdown, or from a Hyprland binding. Ephemeral by default; Omarchy's own
 * tiling gesture makes it a window when someone wants to live in it.
 */
Item {
    id: root

    property var shell: null
    property var manifest: null
    property bool opened: false

    readonly property color background: Color.menu.background
    readonly property color foreground: Color.menu.text
    readonly property color border: Color.menu.border
    readonly property color scrim: Color.menu.scrim
    readonly property color brand: "#0094d2"
    readonly property string fontFamily: Style.font.menuFamily
    readonly property color dim: Qt.darker(foreground, 1.55)

    property string query: ""
    /**
     * Where the rail is. Restored from the service, which outlives this window.
     *
     * Defaults to the machine rather than the registry: the first question on
     * opening this is far more often "what do I have" than "what exists", and
     * search is one click away either side.
     */
    /*
     * Remembered PER SECTION.
     *
     * One shared `lastScope` meant reopening on Agents restored a scope that
     * only exists under Models — the rail had nothing to highlight and the
     * pane rendered the model list under the agents header. The two sections
     * have disjoint scopes, so the memory has to be disjoint too.
     */
    property string scope: service ? service.scopeFor(section) : "server"

    /** How the list is ordered, and whether it hides what will not run here. */
    property string sort: "relevance"

    /**
     * Show only what this machine can actually run. ON by default.
     *
     * Two things stop a model running: no adapter for its format, and no room
     * in video memory. Both are "it will not work here", so they are one
     * switch rather than two — a person deciding what to download is asking a
     * single question.
     *
     * Defaulted on because unfiltered is mostly noise. Measured against the
     * live registry, the top two hundred by downloads is 12-37% runnable per
     * scope; the rest are PyTorch checkpoints with no local runtime, and the
     * failure only becomes visible after a gigabyte has been downloaded.
     */
    property bool fitsOnly: true
    property int cursor: 0
    /** The record being examined, or null while browsing. */
    property var detail: null

    // The daemon answers the QUERY; the scope filter is local, because
    // narrowing an answer you already have must not cost a round trip.
    /**
     * Filtered here, on every keystroke, against what is already in hand.
     *
     * The remote search runs behind this and replaces the pool when it lands,
     * but it must never be what a keystroke waits on: reaching the daemon
     * costs a process, so binding the list to the reply meant results changing
     * about a second after someone stopped typing. Narrowing the rows we
     * already have is free and happens per character; the network only ever
     * widens the pool afterwards.
     *
     * It also owes nothing to the daemon link — a browser that blanked while
     * the stream reattached would be hiding results it already has.
     */
    readonly property bool onSettings: scope === "settings"
    readonly property bool onServer: scope === "server"
    readonly property bool onFleet: scope === "fleet"
    /** The agent detail page replaces the fleet list rather than sitting beside it. */
    readonly property bool onAgent: onFleet && !!openAgent

    /**
     * Which agent is OPEN. Empty means the fleet list.
     *
     * A selection, not a filter. It used to narrow the fleet list in place,
     * which meant the rail could pick an agent and the page still showed a
     * list of one — so the two things a person wants from an agent (see what
     * it is, run it) had no home. Now it opens the detail page.
     */
    property string selectedAgent: ""

    /** The installed project behind `selectedAgent`, or null while nothing is open. */
    readonly property var openAgent: {
        if (selectedAgent === "" || !daemon || !daemon.installed) return null
        for (var i = 0; i < daemon.installed.length; i++) {
            var p = daemon.installed[i]
            if (String(p.name) === selectedAgent || String(p.ref) === selectedAgent) return p
        }
        return null
    }

    /** Its live instance, when one is running — matched on the unscoped name. */
    readonly property var openInstance: {
        if (!openAgent || !daemon || !daemon.agents) return null
        var bare = String(openAgent.name)
        for (var i = 0; i < daemon.agents.length; i++) {
            var a = daemon.agents[i]
            if (a.parentSessionId) continue
            if (String(a.agentName).replace(/^@[^/]+\//, "") === bare) return a
        }
        return null
    }
    readonly property bool onAbout: scope === "about"

    /** A pinned destination replaces the catalogue rather than narrowing it. */
    readonly property bool onPage: onSettings || onServer || onFleet || onAbout

    readonly property var results: root.daemon && !onPage ? root.daemon.search(query, scope) : []



    /**
     * The ceiling, and how much of it is spent.
     *
     * Falls back to the card's own size when nothing is declared, because that
     * IS the ceiling then — reporting "no budget" would be true and useless.
     */
    /**
     * The ceiling actually in force: a declaration if there is one, the card
     * otherwise. Read once and used by both the header and the rail's foot —
     * the two disagreed, showing the same held figure against the budget in
     * one place and the card in the other, which made the number look wrong in
     * whichever you read second.
     */
    readonly property var ceiling: {
        if (!daemon || !daemon.capacity) return null
        return daemon.budget !== undefined && daemon.budget !== null
            ? daemon.budget : daemon.capacity.vram
    }

    readonly property bool declaredBudget: !!daemon && daemon.budget !== undefined && daemon.budget !== null

    readonly property string budgetLabel: {
        if (!daemon || !daemon.hasData || ceiling === null) return ""
        return "Budget  " + Format.bytes(daemon.held) + " / " + Format.bytes(ceiling)
            + (declaredBudget ? "" : "  (card)")
    }

    /**
     * Step the ceiling through the fractions people actually pick, then off.
     *
     * A cycle rather than a slider: the header has room for a readout and this
     * makes it a control without becoming a settings panel. The daemon refuses
     * anything nonsensical, and the stream reports whatever it accepted, so
     * nothing here has to guess whether the change took.
     */
    function cycleBudget() {
        if (!service || !daemon || !daemon.capacity || !daemon.capacity.vram) return
        var vram = daemon.capacity.vram
        var steps = [0.5, 0.75, 0.9]
        var current = daemon.budget
        if (current === undefined || current === null) return service.setBudget(Math.floor(vram * steps[0]))

        for (var i = 0; i < steps.length; i++) {
            if (current < Math.floor(vram * steps[i]) - 1) return service.setBudget(Math.floor(vram * steps[i]))
        }
        service.setBudget("clear")
    }

    /**
     * Named by MODALITY, not by task.
     *
     * "Chat", "Speech" and "Vision" are what a model does with what it is
     * given; "Language", "Audio" and "Image" are what it is given. The second
     * set separates more cleanly because it answers the question someone
     * actually arrives with — I have audio, what can read it — and because a
     * transcriber and a synthesiser are both "speech" while being opposite
     * jobs. The daemon's own vocabulary is unchanged: these are labels over
     * the same capability values, and renaming a taxonomy the records carry
     * would be a much larger change for a much smaller gain.
     *
     * "Downloaded" and "Loaded" have left this list — they are two groups of
     * one page now, not two ways to filter a registry. See Server.
     */
    /**
     * The rail's agent shelf: the five most recently used.
     *
     * Five, not all of them: this is a shortcut to what you were just in, and
     * a rail that grows without bound stops being navigation. The full list is
     * the Fleet page, which is one click above.
     */
    readonly property var agentScopes: {
        var out = [{ section: "AGENTS" }]
        var all = daemon && daemon.installed ? daemon.installed : []
        for (var i = 0; i < all.length && i < 5; i++) {
            // The DECLARED name, which is what the CLI takes and what the row
            // shows. A rail saying `zeno` beside a list saying `@axon/zeno`
            // reads as two different things.
            out.push({ value: "agent:" + all[i].name, label: all[i].ref || all[i].name })
        }
        return out
    }

    readonly property var scopes: section === "agents" ? agentScopes : [
        { section: "DISCOVER" },
        { value: "all", label: "All" },
        { value: "chat", label: "Language" },
        { value: "speech", label: "Audio" },
        { value: "vision", label: "Image" },
        { value: "embedding", label: "Embedding" },
    ]

    /**
     * Which half of the machine this window is showing.
     *
     * "models" and "agents" are two subjects over ONE chrome — same rail, same
     * search, same page skeleton — because they are two views of the same box
     * and learning one should teach the other. Switching is a top-bar choice
     * rather than a second window, so the panel stays one thing you open.
     */
    property string section: service ? service.lastSection : "models"
    onSectionChanged: {
        if (service) service.lastSection = section
        detail = null
        /*
         * A top-bar click lands on the section's INDEX, not where you last
         * were in it.
         *
         * Models and Agents are the names of the two halves, and the thing
         * they name is Server and Fleet — the page that answers "what is on
         * this machine". Restoring a scope here made clicking "Models" land on
         * a filtered registry search, which is a place you navigate TO, never
         * the front door.
         *
         * Where you were is still remembered; it is restored on OPEN, which is
         * a different intention from switching halves.
         */
        scope = section === "agents" ? "fleet" : "server"
        selectedAgent = ""
    }

    /** The machine sits above the scopes, because it is where a visit starts. */
    readonly property var leading: section === "agents"
        ? [ { value: "fleet", label: "Fleet" } ]
        : [ { value: "server", label: "Server" } ]

    /**
     * The shared daemon link, INJECTED BY THE SHELL.
     *
     * `shell.qml` hands a panel or overlay the matching service singleton when
     * its plugin declares one — "plugins that pair a panel UI with a service
     * entry read shared state off `service`". So this must be writable and
     * must be named exactly this: a `readonly` version of it makes the shell's
     * assignment throw and the surface loads with no daemon at all.
     *
     * Same service the bar widget reads, so the two surfaces cannot disagree
     * about the machine and only one transport runs. It is also what closed
     * the settings gap: an overlay is never handed the plugin's settings, so
     * the bar widget pushes them to the service and this reads them from there.
     */
    property var service: null

    /*
     * Close when the service hands off to a terminal or an editor.
     *
     * A Connections block rather than a property binding: this is an EVENT,
     * and the surface reacts to it once rather than tracking a state.
     */
    Connections {
        target: root.service
        function onHandedOff() { root.close() }
    }

    readonly property var daemon: service ? service.machine : null

    /** Axon is not on this machine. Everything in this window depends on it. */
    readonly property bool missing: !!daemon && daemon.health === "missing"

    /**
     * Open, optionally straight onto one model.
     *
     * The payload carries a specifier when something else sent us here — the
     * bar dropdown lists what is on this machine and every row is a way in, so
     * clicking one has to arrive at that model rather than at a search box the
     * person then has to retype into.
     */
    function open(payloadJson) {
        if (!opened && service) service.acquire()
        opened = true
        query = ""
        cursor = 0
        /*
         * Reopen where you were, coherently.
         *
         * `scope` was forced to "all" here while `section` was restored from
         * the service, so the two disagreed on every open: the rail showed a
         * models scope while the top bar said Agents. Restoring the scope that
         * BELONGS to the restored section is what makes the window feel like
         * one thing you left and came back to.
         */
        scope = service ? service.scopeFor(section) : (section === "agents" ? "fleet" : "server")
        selectedAgent = ""

        var wanted = null
        try {
            var parsed = JSON.parse(payloadJson || "{}")
            if (parsed && typeof parsed.model === "string") wanted = parsed.model
        } catch (e) { /* a bare token, or nothing. Neither names a model. */ }

        detail = wanted ? { id: wanted, name: wanted, owner: "", source: wanted.indexOf("ollama:") === 0 ? "ollama" : "huggingface",
                            capability: "other", runtime: null, bytes: null, cached: false, resident: false } : null
        if (wanted && service) service.loadDetail(wanted)
        else Qt.callLater(function () { search.take() })
    }

    function close() {
        if (opened && service) service.release()
        opened = false
        detail = null
    }

    /**
     * Scaffold a new agent, named from the rail.
     *
     * Headless — the service runs it and reports on the row. It used to open a
     * terminal, which took focus away from the panel someone was still using
     * and demanded a keypress to dismiss, for a process whose only interesting
     * outcome is whether it worked.
     */
    function createAgent(name) {
        if (service) service.createAgent(name)
    }

    Component.onDestruction: if (opened && service) service.release()

    /** Esc unwinds one layer at a time: detail first, then the surface. */
    function back() {
        if (detail) detail = null
        else close()
    }

    function move(delta) {
        if (results.length === 0) return
        cursor = Math.max(0, Math.min(results.length - 1, cursor + delta))
    }

    function activate() {
        if (cursor >= 0 && cursor < results.length) detail = results[cursor]
    }

    onQueryChanged: {
        cursor = 0
        if (service) service.searchCatalogue(query, scope)
    }



    // The catalogue is a remote answer, so an empty query on open still needs
    // one — otherwise the panel opens on nothing until the first keystroke.
    onOpenedChanged: if (opened && service) service.searchCatalogue(query, scope)
    // A capability is a different question for the registry, not a filter over
    // the same answer — so changing it asks again. One handler, because QML
    // keeps only the last binding for a signal and a second silently wins.
    onScopeChanged: {
        cursor = 0
        // Written back on every change, so closing and reopening lands where
        // you left rather than where the window happens to start. Merged into
        // this handler rather than declared beside it — QML takes one handler
        // per signal, and a second silently replaces the first.
        if (service) service.rememberScope(section, scope)
        if (service && !onPage) service.searchCatalogue(query, scope, true)
    }

    // Ordering and the fit filter are applied by the daemon, where the
    // machine's ceiling is known — so changing either is a new question, not a
    // re-sort of an answer already in hand.
    onSortChanged: if (service) { service.sort = sort; service.searchCatalogue(query, scope, true) }
    onFitsOnlyChanged: if (service) { service.fitsOnly = fitsOnly; service.searchCatalogue(query, scope, true) }

    PanelWindow {
        id: panel
        visible: root.opened
        anchors { top: true; bottom: true; left: true; right: true }
        color: "transparent"
        WlrLayershell.namespace: "arclabs-axon-browser"
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
        exclusionMode: ExclusionMode.Ignore

        Rectangle {
            anchors.fill: parent
            color: root.scrim
        }

        MouseArea {
            anchors.fill: parent
            onClicked: root.close()
        }

        BorderSurface {
            id: card
            anchors.centerIn: parent
            width: Math.min(Style.space(1000), panel.width - Style.gapsOut * 2)
            height: Math.min(Style.space(620), panel.height - Style.gapsOut * 2)
            color: root.background
            borderSpec: Border.surfaceSpec("menu", "border", root.border, Math.max(1, Style.space(2)))
            radius: Style.cornerRadius

            // Swallow the dismissing click behind the card.
            MouseArea { anchors.fill: parent }

            InstallGate {
                anchors.fill: parent
                anchors.margins: Math.max(1, Style.space(2))
                visible: root.missing
                install: root.service ? root.service.install : null
                foreground: root.foreground
                accent: root.brand
                background: root.background
                fontFamily: root.fontFamily
                z: 10
            }

            FocusScope {
                id: keys
                anchors.fill: parent
                focus: root.opened

                Keys.onEscapePressed: root.back()

                Column {
                    anchors.fill: parent
                    anchors.margins: Style.spacing.panelPadding
                    spacing: Style.space(10)

                    // ── Header: search, and the claim ───────────────────────
                    Item {
                        width: parent.width
                        height: search.implicitHeight

                        SearchField {
                            id: search
                            anchors.left: parent.left
                            anchors.right: nav.left
                            anchors.rightMargin: Style.space(16)
                            anchors.verticalCenter: parent.verticalCenter
                            foreground: root.foreground
                            accent: root.brand
                            fontFamily: root.fontFamily
                            onTextChanged: root.query = text
                            onMoved: function (d) { root.move(d) }
                            onAccepted: root.activate()
                        }

                        // The header is navigation, not a second settings surface.
                        // Budget controls remain available in Settings.
                        Row {
                            id: nav
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            /*
                             * The gap BETWEEN groups, not between items.
                             *
                             * Two things sit here and they are different
                             * kinds: what this window is, and where else to
                             * go. Even spacing made them read as one row of
                             * three unrelated controls — so the icons are
                             * tight enough to read as a pair and the label
                             * stands apart from them.
                             */
                            spacing: Style.space(20)

                            /*
                             * What this view IS.
                             *
                             * Not a link to documentation: a header should
                             * name where you are before it offers to take you
                             * elsewhere, and this whole window is the model
                             * manager. It becomes the switch between Axon's
                             * views once there is more than one to switch to,
                             * which is why it reads as a destination rather
                             * than a title.
                             */
                            /*
                             * The two halves of the machine, as a switch.
                             *
                             * It read "Models" as a label; now it names both
                             * and the current one carries the brand. A person
                             * who never clicks it still learns that Agents
                             * exists, which is the whole reason the model
                             * manager is worth building.
                             */
                            Row {
                                anchors.verticalCenter: parent.verticalCenter
                                spacing: Style.space(12)

                                Repeater {
                                    model: [
                                        { value: "models", label: "Models" },
                                        { value: "agents", label: "Agents" },
                                    ]

                                    Text {
                                        required property var modelData
                                        textFormat: Text.PlainText
                                        text: String(modelData.label)
                                        color: root.section === String(modelData.value)
                                            ? root.brand
                                            : (sectionHover.hovered ? root.foreground : root.dim)
                                        font.family: root.fontFamily
                                        font.pixelSize: Style.font.caption

                                        HoverHandler { id: sectionHover; cursorShape: Qt.PointingHandCursor }
                                        TapHandler { onTapped: root.section = String(parent.modelData.value) }
                                    }
                                }
                            }

                            Row {
                                anchors.verticalCenter: parent.verticalCenter
                                spacing: Style.space(2)

                                IconButton {
                                    iconSource: Qt.resolvedUrl("../../assets/discord.svg")
                                    externalUrl: "https://discord.gg/jkw5AgFXRw"
                                    foreground: root.foreground
                                    accent: root.brand
                                    fontFamily: root.fontFamily
                                }

                                IconButton {
                                    iconSource: Qt.resolvedUrl("../../assets/github.svg")
                                    externalUrl: "https://github.com/artificial-cognition-laboratories/axon"
                                    foreground: root.foreground
                                    accent: root.brand
                                    fontFamily: root.fontFamily
                                }
                            }
                        }
                    }

                    Rectangle {
                        width: parent.width
                        height: 1
                        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
                    }

                    // ── Rail + content ──────────────────────────────────────
                    Item {
                        width: parent.width
                        height: parent.height - y

                        Sidebar {
                            id: rail
                            width: Style.space(180)
                            height: parent.height
                            scopes: root.scopes
                            leading: root.leading
                            /*
                             * A field where a new agent would go, on the
                             * agents side only. Models are not something you
                             * create, so offering it there would be a control
                             * that cannot do anything.
                             */
                            composer: root.section === "agents"
                                ? { value: "agent", placeholder: "new agent…" }
                                : null
                            onComposed: function (name) { root.createAgent(name) }
                            busy: !!root.service && root.service.creating !== ""
                            trouble: root.service ? root.service.createError : ""
                            /*
                             * The OPEN agent wins the highlight over "Fleet".
                             *
                             * Both are true — an open agent is still the fleet
                             * section — but the rail marks where you are, and
                             * where you are is the agent. Highlighting Fleet
                             * while looking at one agent made the shelf entry
                             * look like it had not registered the click.
                             */
                            value: root.selectedAgent !== "" ? "agent:" + root.selectedAgent : root.scope
                            foreground: root.foreground
                            accent: root.brand
                            fontFamily: root.fontFamily
                            // No "(budget)" qualifier. It was there to say
                            // which denominator this is, and the header and the
                            // Settings page both now show that outright — so it
                            // only ever overflowed the rail.
                            footprintPrimary: root.daemon && root.daemon.hasData && root.ceiling !== null
                                ? Format.bytes(root.daemon.held) + " of " + Format.bytes(root.ceiling) + " held"
                                : ""
                            footprintSecondary: root.daemon && root.daemon.hasData
                                ? (root.daemon.cached.length + " weights cached") : ""
                            /*
                             * Docs and Settings, and deliberately nothing that
                             * USES a model.
                             *
                             * An "Interact" chat page sat here and was cut: the
                             * terminal owns the conversation, and a panel that
                             * can chat removes every reason to open one. It was
                             * not a weak page, it was a hole in the funnel this
                             * whole surface exists to be.
                             */
                            pinned: [
                                { value: "about", label: "Docs" },
                                { value: "settings", label: "Settings" },
                            ]
                            onSelected: function (v) {
                                // Any rail choice leaves the detail page.
                                // Picking a scope is asking to see a LIST, so
                                // staying on one model while the list changed
                                // underneath left the rail looking inert — the
                                // selection moved and nothing else did.
                                root.detail = null
                                /*
                                 * An `agent:` scope is a SELECTION, not a
                                 * filter — the rail's shelf picks which agent
                                 * the page is about, where every other scope
                                 * narrows a list. Routed here so the pages
                                 * below never learn the prefix.
                                 */
                                if (String(v).indexOf("agent:") === 0) {
                                    root.selectedAgent = String(v).slice("agent:".length)
                                    root.scope = "fleet"
                                    return
                                }
                                root.selectedAgent = ""
                                root.scope = v
                                // Server keeps the field focused: it narrows
                                // the two groups on that page, which is what
                                // makes find-then-load one motion.
                                if (!root.onPage || root.onServer) search.take()
                            }
                        }

                        Rectangle {
                            id: split
                            x: rail.width + Style.space(10)
                            width: 1
                            height: parent.height
                            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
                        }

                        Item {
                            x: split.x + Style.space(14)
                            width: parent.width - x
                            height: parent.height

                            About {
                                anchors.fill: parent
                                visible: root.onAbout
                                foreground: root.foreground
                                accent: root.brand
                                fontFamily: root.fontFamily
                            }
                                Settings {
                                anchors.fill: parent
                                visible: root.onSettings
                                machine: root.daemon
                                service: root.service
                                foreground: root.foreground
                                accent: root.brand
                                fontFamily: root.fontFamily
                            }

                            /*
                             * The wall, on the agents side only.
                             *
                             * Gated on the daemon having ANSWERED, not on the
                             * absence of an identity: the stream fills a moment
                             * after the window opens, and treating "not yet
                             * known" as "signed out" would flash a login wall
                             * on every open.
                             */
                            LoginGate {
                                anchors.fill: parent
                                anchors.margins: Math.max(1, Style.space(2))
                                visible: root.section === "agents"
                                    && !!root.daemon && !!root.daemon.identity
                                    && !root.daemon.signedIn
                                axonPath: root.service ? root.service.axonPath : ""
                                foreground: root.foreground
                                accent: root.brand
                                background: root.background
                                fontFamily: root.fontFamily
                                z: 20
                            }

                            Agent {
                                anchors.fill: parent
                                visible: root.onAgent
                                project: root.openAgent
                                instance: root.openInstance
                                machine: root.daemon
                                service: root.service
                                foreground: root.foreground
                                accent: root.brand
                                fontFamily: root.fontFamily
                                onDismissed: root.selectedAgent = ""
                            }

                            Fleet {
                                anchors.fill: parent
                                visible: root.onFleet && !root.onAgent
                                machine: root.daemon
                                service: root.service
                                term: root.query
                                foreground: root.foreground
                                accent: root.brand
                                fontFamily: root.fontFamily
                                onOpened: function (agent) { root.selectedAgent = agent }
                            }

                            Server {
                                anchors.fill: parent
                                visible: root.onServer
                                machine: root.daemon
                                service: root.service
                                term: root.query
                                foreground: root.foreground
                                accent: root.brand
                                fontFamily: root.fontFamily
                                onPicked: function (record) { root.detail = record }
                            }

                            Discover {
                                anchors.fill: parent
                                visible: !root.detail && !root.onPage
                                results: root.results
                                cursor: root.cursor
                                service: root.service
                                term: root.query
                                sort: root.sort
                                fitsOnly: root.fitsOnly
                                onSortChanged2: function (next) { root.sort = next }
                                onFitsToggled: root.fitsOnly = !root.fitsOnly
                                machine: root.daemon
                                foreground: root.foreground
                                accent: root.brand
                                fontFamily: root.fontFamily
                                onPicked: function (i) { root.cursor = i; root.activate() }
                            }

                            Detail {
                                anchors.fill: parent
                                visible: !!root.detail && !root.onPage
                                record: root.detail
                                machine: root.daemon
                                service: root.service
                                foreground: root.foreground
                                accent: root.brand
                                fontFamily: root.fontFamily
                                onDismissed: root.back()
                            }
                        }
                    }
                }
            }
        }
    }
}
