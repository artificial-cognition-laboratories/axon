import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui

import "../../../components"
import "../../../src/format.js" as Format

/**
 * The daemon's own settings.
 *
 * ── Only what the daemon actually honours ───────────────────────────────────
 *
 * Fleet's settings pane sketches five controls; two of them exist here, and the
 * other three are deliberately absent rather than stored and ignored:
 *
 *   Port / remote connections — the daemon speaks over a unix socket, and its
 *     own design says filesystem permissions ARE the access control. A TCP
 *     port is a different security posture, not a checkbox, and it wants a
 *     bind address and a decision rather than a toggle.
 *
 *   Idle timeout — unloading a model after a quiet period IS an eviction
 *     policy, and `machine.ts` states the position plainly: refuse, never
 *     evict, "until there is a policy worth defending". Shipping a slider
 *     would decide that by accident.
 *
 *   Just-in-time loading — `run()` refuses a weight that is not resident on
 *     purpose. Loading on first request changes when admission happens, which
 *     is a runtime behaviour rather than a preference.
 *
 * A setting that does nothing is worse than a missing one: it reads as broken
 * exactly once, and as untrustworthy from then on.
 */
Flickable {
    id: root

    property var machine: null
    property var service: null

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    readonly property color dim: Qt.darker(foreground, 1.55)

    readonly property var daemon: machine ? machine.daemon : null
    readonly property var capacity: machine ? machine.capacity : null
    readonly property bool running: !!daemon && daemon.running === true

    /*
     * ── Optimistic switches ─────────────────────────────────────────────────
     *
     * Every setting here is written to the daemon and read back off its state
     * stream, which is the right architecture — the panel is a display, and a
     * control holding its own copy would show the value it hoped for after a
     * write that failed.
     *
     * The cost is that a stream ticks twice a second, so a toggle sat visibly
     * un-flipped for up to half a second after being clicked. That reads as a
     * click that did not register, and the second click undoes the first.
     *
     * So a click is remembered and shown IMMEDIATELY, and the memory is
     * discarded the moment the daemon reports the same value. It never
     * outlives the daemon's answer: a write that fails reverts on the next
     * tick, visibly, rather than leaving a switch lying about what is stored.
     */
    property var wished: ({})

    function wish(key, value) {
        var next = {}
        for (var k in wished) next[k] = wished[k]
        next[key] = value
        wished = next
    }

    /** The daemon's value, unless a click is still outrunning it. */
    function switched(key, actual) {
        var hoped = wished[key]
        if (hoped === undefined) return actual
        if (hoped === actual) {
            // Reality caught up. Drop the wish so the daemon is the only
            // source again — leaving it would make this a second one.
            Qt.callLater(function () {
                var next = {}
                for (var k in wished) if (k !== key) next[k] = wished[k]
                wished = next
            })
            return actual
        }
        return hoped
    }

    /** Which tab is showing. View state, not something the daemon owns. */
    property string tab: "server"

    readonly property var preferences: machine && machine.preferences ? machine.preferences : ({})

    /** What the daemon reports about dictation, including why it cannot run. */
    readonly property var dictation: machine && machine.dictation ? machine.dictation : ({})

    /**
     * The one line that says why nothing happens when you press the key.
     *
     * Order is fix-this-first, and the daemon comes before everything: with no
     * daemon there is nothing to hold the microphone between the two keypresses
     * a recording spans, so every other diagnosis is premature. `lastError` is
     * last because it describes the most recent COMMAND rather than the state —
     * useful, but only once the obvious things are right.
     */
    readonly property string trouble: {
        if (!running) return "axond is not running — dictation needs it to hold the microphone between keypresses. Start it with `axon daemon up`."
        if (dictation.blocked) return String(dictation.blocked)
        if (dictationHotkey === "") return "No shortcut is bound yet."
        if (service && service.lastError !== "") return String(service.lastError)
        return ""
    }

    /*
     * Read straight off the daemon's preferences, never mirrored into local
     * state. A control that held its own copy would show the value it hoped
     * for after a write that failed — the same rule the model rows follow.
     */
    readonly property string dictationHotkey: typeof preferences["dictation.hotkey"] === "string"
        ? preferences["dictation.hotkey"] : ""
    readonly property string dictationMode: typeof preferences["dictation.mode"] === "string"
        ? preferences["dictation.mode"] : "hold"
    /** Where the listening indicator sits, and how big. Defaults match Voice.qml. */
    readonly property string indicatorPlacement: {
        var p = preferences["dictation.indicator"]
        return (p === "top" || p === "center" || p === "bottom" || p === "off") ? p : "bottom"
    }
    readonly property string indicatorScale: {
        var s = preferences["dictation.indicatorScale"]
        return (s === "0.75" || s === "1" || s === "1.4") ? s : "1"
    }

    readonly property string dictationModel: typeof preferences["dictation.model"] === "string"
        ? preferences["dictation.model"] : (speechModels.length > 0 ? String(speechModels[0].value) : "")

    /**
     * Models on this machine that can actually TRANSCRIBE.
     *
     * Filtered on direction — audio in, text out — never on `capability`.
     * "speech" is a browsing shelf and it holds both halves of the task, so
     * capability filtering offered Kokoro (text-to-speech) as a dictation
     * engine: a shortcut bound to a guaranteed failure.
     *
     * A model whose direction was never recorded is NOT offered. Empty
     * modalities mean "nobody wrote this down", and the whole point of this
     * list is that everything in it is known to work — a weight downloaded
     * before the daemon kept this has to be re-fetched to be trusted, which is
     * the honest trade against silently listing it and hoping.
     */
    readonly property var speechModels: {
        var out = []
        if (!machine || !machine.cached) return out
        for (var i = 0; i < machine.cached.length; i++) {
            var m = machine.cached[i]
            var takes = m["in"] || []
            var gives = m["out"] || []
            if (takes.indexOf("audio") === -1 || gives.indexOf("text") === -1) continue
            out.push({ value: String(m.id), label: String(m.name || m.id) })
        }
        return out
    }

    function setPreference(key, value) {
        if (service) service.setPreference(key, value)
    }

    /**
     * Store a dictation setting AND make it take effect.
     *
     * The chord and the mode both change what the compositor should be bound
     * to, so writing one without re-binding leaves the panel showing a
     * shortcut that does nothing until the next daemon start — a setting that
     * appears to have been accepted and has not.
     */
    function setBinding(key, value) {
        if (!service) return
        service.setPreference(key, value)
        service.bindDictation()
    }

    contentWidth: width
    contentHeight: page.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    interactive: contentHeight > height
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    function duration(seconds) {
        if (!seconds || seconds < 0) return "—"
        if (seconds < 60) return Math.round(seconds) + "s"
        if (seconds < 3600) return Math.round(seconds / 60) + "m"
        if (seconds < 86400) return (seconds / 3600).toFixed(1) + "h"
        return (seconds / 86400).toFixed(1) + "d"
    }

    Column {
        id: page
        /*
         * One readable measure, centred — the same 575 every page here uses.
         *
         * The pane is as wide as the window and this content is prose,
         * settings rows and a text box, all of which get harder to read
         * the wider they run. 575 is the number these pages were tuned to
         * by eye; the rail and the card around them can grow without this
         * following, which is the point of pinning it.
         */
        anchors.horizontalCenter: parent.horizontalCenter
        width: Math.min(parent.width, Style.space(575))
        spacing: 0

        // Breathing room above the title — the pane's top edge is the
        // window's, and a heading hard against it reads as clipped.
        Item { width: 1; height: Style.space(10) }

        // ── Header ──────────────────────────────────────────────────────────
        //
        // The same shape the agent page uses: identity, one line of context,
        // then the strip. Two pages that both open from the rail should be
        // read the same way.
        Item {
            width: parent.width
            height: heading.implicitHeight

            Column {
                id: heading
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                spacing: Style.space(3)

                Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: "Settings"
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.subtitle
                    font.bold: true
                    elide: Text.ElideRight
                }

                Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: root.running
                        ? ("axond running" + (root.daemon && root.daemon.version ? " · v" + root.daemon.version : ""))
                        : "axond stopped"
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                }
            }
        }

        Item { width: 1; height: Style.space(14) }

        TabStrip {
            width: parent.width
            tabs: [
                { value: "server", label: "Server" },
                { value: "transcription", label: "Transcription" },
            ]
            value: root.tab
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onSelected: function (v) { root.tab = v }
        }

        // ── Server ──────────────────────────────────────────────────────────
        Column {
        width: parent.width
        visible: root.tab === "server"
        spacing: Style.space(6)

        // ── Daemon ──────────────────────────────────────────────────────────
        SettingsSection {
            width: parent.width
            title: "Daemon"
            description: "The machine-wide process that owns local inference, scheduling and shared resources."
            foreground: root.foreground
            fontFamily: root.fontFamily
        }

        SettingsRow {
            width: parent.width
            label: "Status"
            description: "whether axond is accepting work"
            value: root.running ? "running" : "stopped"
            valueColor: root.running ? "#3fb96b" : "#e05252"
            foreground: root.foreground
            fontFamily: root.fontFamily
        }

        SettingsRow {
            width: parent.width
            label: "Endpoint"
            description: "a unix socket, so filesystem permissions are the access control"
            value: root.daemon && root.daemon.socket ? Format.basename(root.daemon.socket) : "—"
            foreground: root.foreground
            fontFamily: root.fontFamily
        }

        SettingsRow {
            width: parent.width
            label: "Uptime"
            value: root.daemon ? root.duration(root.daemon.uptime) : "—"
            foreground: root.foreground
            fontFamily: root.fontFamily
        }

        SettingsRow {
            width: parent.width
            label: "Version"
            value: root.daemon && root.daemon.version ? "v" + root.daemon.version : "—"
            foreground: root.foreground
            fontFamily: root.fontFamily
        }

        // ── Memory ──────────────────────────────────────────────────────────
        SettingsSection {
            width: parent.width
            title: "Memory"
            description: "A declared ceiling wins over the detected hardware — which is what makes local inference usable on a machine that is also running something else."
            foreground: root.foreground
            fontFamily: root.fontFamily
        }

        Item {
            width: parent.width
            implicitHeight: budgetLabel.implicitHeight + slider.implicitHeight + Style.space(22)

            Text {
                id: budgetLabel
                anchors.left: parent.left
                anchors.top: parent.top
                textFormat: Text.PlainText
                text: "VRAM budget"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
            }

            Text {
                anchors.right: parent.right
                anchors.baseline: budgetLabel.baseline
                textFormat: Text.PlainText
                text: {
                    if (!root.capacity || !root.capacity.vram) return "no measurable ceiling"
                    if (!root.machine || root.machine.budget === null || root.machine.budget === undefined)
                        return Format.bytes(root.capacity.vram) + "  (the card)"
                    return Format.bytes(root.machine.budget) + "  of " + Format.bytes(root.capacity.vram)
                }
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }

            PanelSlider {
                id: slider
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: budgetLabel.bottom
                anchors.topMargin: Style.space(12)
                enabled: !!root.capacity && !!root.capacity.vram
                minimum: 0
                maximum: 1
                step: 0.05
                // Shown as a share of the card, because that is how the choice
                // is actually made — "half of it", not "5,637,144,576 bytes".
                value: root.capacity && root.capacity.vram && root.machine
                    && root.machine.budget !== null && root.machine.budget !== undefined
                    ? root.machine.budget / root.capacity.vram
                    : 1

                onDraggingChanged: {
                    if (dragging || !root.service || !root.capacity || !root.capacity.vram) return
                    // Written on release, not on every frame of a drag: each
                    // one is a process, and a slider that spawned twenty would
                    // be a slider that fought back.
                    root.service.setBudget(value >= 0.99
                        ? "clear"
                        : String(Math.floor(root.capacity.vram * value)))
                }
            }
        }

        // ── Lifecycle ───────────────────────────────────────────────────────
        SettingsSection {
            width: parent.width
            title: "Lifecycle"
            foreground: root.foreground
            fontFamily: root.fontFamily
        }

        Toggle {
            width: parent.width
            label: "Load models on demand"
            description: "Sending a model an input loads it into memory first. Turn this off to keep "
                + "admission an explicit act — nothing enters video memory unless you load it yourself."
            checked: root.switched("autoload", !!root.machine && root.machine.autoload)
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onClicked: {
                root.wish("autoload", !checked)
                if (root.service) root.service.setAutoload(!checked)
            }
        }

        Toggle {
            width: parent.width
            label: "Start with this machine"
            description: root.machine && root.machine.boot && root.machine.boot.supported === false
                ? "not supported on this platform"
                : "Run the daemon at login, so agents and their models are ready before anything asks."
            checked: root.switched("boot",
                !!root.machine && !!root.machine.boot && root.machine.boot.installed === true)
            enabled: !!root.machine && !!root.machine.boot && root.machine.boot.supported !== false
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            // `clicked`, not `toggled`: Omarchy's Toggle reports the gesture
            // and leaves `checked` to the owner, so the state stays the
            // daemon's answer rather than the control's guess.
            onClicked: {
                root.wish("boot", !checked)
                if (root.service) root.service.setBoot(!checked)
            }
        }

        Item { width: 1; height: Style.space(16) }
        }

        // ── Transcription ───────────────────────────────────────────────────
        //
        // Dictation is the one capability here that has no surface: a
        // keybinding, a model, and text appearing wherever the cursor already
        // is. That is exactly why its settings live in a panel — there is
        // nowhere else for them to be, and it is the shape of the whole
        // product's claim that local models are an OS capability rather than
        // an app.
        Column {
            width: parent.width
            visible: root.tab === "transcription"
            spacing: Style.space(6)

            SettingsSection {
                width: parent.width
                title: "Dictation"
                description: "Hold or press a key, speak, and the transcript is typed where your cursor is. The model runs on this machine — nothing is sent anywhere."
                foreground: root.foreground
                fontFamily: root.fontFamily
            }

            Item {
                width: parent.width
                implicitHeight: Math.max(hotkeyLabels.implicitHeight, hotkey.implicitHeight) + Style.space(12)

                Column {
                    id: hotkeyLabels
                    anchors.left: parent.left
                    anchors.right: hotkey.left
                    anchors.rightMargin: Style.space(16)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(1)

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: "Shortcut"
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                    }

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: "Click, then press the combination. Escape cancels, Backspace clears."
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }
                }

                HotkeyField {
                    id: hotkey
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    value: root.dictationHotkey
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onBound: function (chord) { root.setBinding("dictation.hotkey", chord) }
                    onCleared: root.setBinding("dictation.hotkey", "")
                }
            }

            Item {
                width: parent.width
                implicitHeight: Math.max(modeLabels.implicitHeight, mode.implicitHeight) + Style.space(12)

                Column {
                    id: modeLabels
                    anchors.left: parent.left
                    anchors.right: mode.left
                    anchors.rightMargin: Style.space(16)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(1)

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: "Capture"
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                    }

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: "Hold suits a sentence; toggle suits a paragraph."
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }
                }

                Dropdown {
                    id: mode
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    options: [
                        { value: "hold", label: "Hold to talk" },
                        { value: "toggle", label: "Toggle" },
                    ]
                    value: root.dictationMode
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onSelected: function (v) { root.setBinding("dictation.mode", v) }
                }
            }

            Item {
                width: parent.width
                implicitHeight: Math.max(engineLabels.implicitHeight, engine.implicitHeight) + Style.space(12)

                Column {
                    id: engineLabels
                    anchors.left: parent.left
                    anchors.right: engine.left
                    anchors.rightMargin: Style.space(16)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(1)

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: "Model"
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                    }

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        // Named, not measured: how fast a model transcribes
                        // depends on the machine, and a figure invented here
                        // would be wrong on most of them.
                        text: "Larger models are more accurate and slower to start."
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }
                }

                Dropdown {
                    id: engine
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    options: root.speechModels
                    value: root.dictationModel
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onSelected: function (v) { root.setPreference("dictation.model", v) }
                }
            }

            SettingsSection {
                width: parent.width
                title: "While listening"
                description: "Dictation has no window by design — you speak and the words appear where your cursor is. This is the one thing on screen that says the microphone is open."
                foreground: root.foreground
                fontFamily: root.fontFamily
            }

            Item {
                width: parent.width
                implicitHeight: Math.max(placeLabels.implicitHeight, place.implicitHeight) + Style.space(12)

                Column {
                    id: placeLabels
                    anchors.left: parent.left
                    anchors.right: place.left
                    anchors.rightMargin: Style.space(16)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(1)

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: "Indicator"
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                    }

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: "A level meter showing what the microphone hears. It takes no focus and no clicks."
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }
                }

                Dropdown {
                    id: place
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    options: [
                        { value: "bottom", label: "Bottom" },
                        { value: "center", label: "Centre" },
                        { value: "top", label: "Top" },
                        { value: "off", label: "Hidden" },
                    ]
                    value: root.indicatorPlacement
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onSelected: function (v) { root.setPreference("dictation.indicator", v) }
                }
            }

            Item {
                width: parent.width
                implicitHeight: Math.max(sizeLabels.implicitHeight, size.implicitHeight) + Style.space(12)

                Column {
                    id: sizeLabels
                    anchors.left: parent.left
                    anchors.right: size.left
                    anchors.rightMargin: Style.space(16)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(1)

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: "Size"
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                    }

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: "How large the meter is drawn."
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }
                }

                Dropdown {
                    id: size
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    options: [
                        { value: "0.75", label: "Small" },
                        { value: "1", label: "Normal" },
                        { value: "1.4", label: "Large" },
                    ]
                    value: root.indicatorScale
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onSelected: function (v) { root.setPreference("dictation.indicatorScale", v) }
                }
            }

            SettingsRow {
                width: parent.width
                label: "Status"
                description: "Whether a keypress would do anything right now."
                value: root.dictation.recording === true
                    ? "listening"
                    : (root.trouble === "" ? "ready" : "not ready")
                valueColor: root.dictation.recording === true
                    ? "#e05252"
                    : (root.trouble === "" ? "#3fb96b" : root.dim)
                foreground: root.foreground
                fontFamily: root.fontFamily
            }

            /*
             * Says what is wrong rather than looking ready.
             *
             * The whole feature is invisible by design, so a silent failure has
             * NOTHING to show for it — a person presses the key, speaks, and
             * watches an unchanged screen. This is the only place that can
             * explain it, so it names the first thing standing in the way
             * rather than a generic "not configured".
             */
            EmptyState {
                width: parent.width
                visible: root.trouble !== ""
                text: root.trouble
                foreground: root.foreground
            }

            Item { width: 1; height: Style.space(16) }
        }
    }
}
