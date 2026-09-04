import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui

import "../../../components"
import "../../../src/format.js" as Format

/**
 * The fleet: every agent on this machine, running or not.
 *
 * ── Why this is not a chat surface ──────────────────────────────────────────
 *
 * The terminal owns the conversation and Axon Fleet owns the debugger. What
 * neither can show is the MACHINE: a terminal is one process in one directory
 * and cannot see the other four, and a debugger is attached to one agent.
 * This page exists for the same reason the model manager does — it answers a
 * question that only the daemon can, and hands off for everything else.
 *
 * So every action here is a LAUNCH, never a conversation. Open a terminal on
 * it, open its source, stop it. The moment a message box appears on this page
 * it has started competing with the terminal, and the terminal wins.
 */
Item {
    id: root

    property var machine: null
    property var service: null
    property string term: ""

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    /** A row was opened — carries the UNSCOPED directory name, which is what the rail is keyed by. */
    signal opened(string agent)

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property color rule: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.14)

    readonly property var capacity: machine ? machine.capacity : null
    readonly property var usage: machine ? machine.usage : null
    readonly property var samples: machine ? machine.samples : []
    readonly property bool live: !!machine && machine.health === "connected"

    function series(field) {
        var out = []
        for (var i = 0; i < samples.length; i++) out.push(samples[i][field])
        return out
    }
    readonly property var times: series("at")
    function ramUsed() {
        var out = []
        if (!capacity) return out
        for (var i = 0; i < samples.length; i++) out.push(capacity.ram - samples[i].ramAvailable)
        return out
    }
    function share(field) {
        var out = []
        for (var i = 0; i < samples.length; i++) {
            var mine = samples[i].axon
            out.push(mine ? mine[field] : null)
        }
        return out
    }
    function asPercent(v) { return Format.percent(v) }
    function asBytes(v) { return Format.bytes(v) }

    /** The search box, against whatever this row is called. */
    function matches(text) {
        var q = String(term || "").toLowerCase().trim()
        return q === "" || String(text).toLowerCase().indexOf(q) !== -1
    }

    /** Live instances, roots only — a sub-agent belongs under its parent, not beside it. */
    readonly property var running: {
        if (!machine || !machine.agents) return []
        var out = []
        for (var i = 0; i < machine.agents.length; i++) {
            var a = machine.agents[i]
            if (a.parentSessionId) continue
            if (matches(a.agentName)) out.push(a)
        }
        return out
    }

    /**
     * Projects with nothing running.
     *
     * A project whose agent is up appears above rather than twice: the row
     * that can be stopped and attached to is more useful than the one that can
     * only be started.
     */
    readonly property var idle: {
        if (!machine || !machine.installed) return []
        var live = {}
        for (var i = 0; i < running.length; i++) {
            var bare = String(running[i].agentName).replace(/^@[^/]+\//, "")
            live[bare] = true
        }
        var out = []
        for (var j = 0; j < machine.installed.length; j++) {
            var p = machine.installed[j]
            if (live[p.name]) continue
            if (matches(p.ref || p.name)) out.push(p)
        }
        return out
    }

    /** How many weights an agent is holding, for the row's right-hand figure. */
    function heldBy(sessionId) {
        var total = 0
        if (!machine || !machine.holds) return 0
        for (var i = 0; i < machine.holds.length; i++) {
            if (String(machine.holds[i].agent).indexOf(String(sessionId)) !== -1) total += machine.holds[i].bytes
        }
        return total
    }

    Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: page.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
            id: page
            width: parent.width
            spacing: Style.space(14)

            Item {
                width: parent.width
                height: title.implicitHeight + Style.space(4) + subtitle.implicitHeight

                Text {
                    id: title
                    anchors.left: parent.left
                    anchors.top: parent.top
                    textFormat: Text.PlainText
                    text: "Fleet"
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.subtitle
                    font.bold: true
                }

                Text {
                    id: subtitle
                    anchors.left: parent.left
                    anchors.top: title.bottom
                    anchors.topMargin: Style.space(4)
                    textFormat: Text.PlainText
                    text: root.running.length === 0
                        ? "Nothing running on this machine"
                        : root.running.length + (root.running.length === 1 ? " agent running" : " agents running")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                }

                Text {
                    anchors.right: parent.right
                    anchors.verticalCenter: title.verticalCenter
                    textFormat: Text.PlainText
                    text: root.machine && root.machine.hasData
                        ? (Format.bytes(root.machine.held) + " held") : ""
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                }
            }

            // The same four readings the machine page shows, for the same
            // reason: deciding whether to start another agent is a memory
            // question, and the answer belongs beside the decision.
            Row {
                width: parent.width
                spacing: Style.space(12)
                visible: !!root.machine && root.machine.hasData

                readonly property real cell: Math.floor((width - Style.space(12) * 3) / 4)

                ResourceRow {
                    width: parent.cell; chartHeight: Style.space(22); windowMs: 60000
                    label: "GPU"; format: root.asPercent; live: root.live
                    reading: root.usage ? Format.percent(root.usage.gpuUtil) : "—"
                    unavailable: root.usage && root.usage.gpuUtil !== null ? "" : "No GPU"
                    values: root.series("gpuUtil"); times: root.times; max: 100
                    foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily
                }
                ResourceRow {
                    width: parent.cell; chartHeight: Style.space(22); windowMs: 60000
                    label: "VRAM"; format: root.asBytes; live: root.live
                    reading: root.usage ? Format.bytes(root.usage.vramUsed) : "—"
                    unavailable: root.capacity && root.capacity.vram ? "" : "Unreadable"
                    values: root.series("vramUsed"); share: root.share("vram"); times: root.times
                    max: root.capacity ? root.capacity.vram : null
                    foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily
                }
                ResourceRow {
                    width: parent.cell; chartHeight: Style.space(22); windowMs: 60000
                    label: "RAM"; format: root.asBytes; live: root.live
                    reading: root.usage && root.capacity
                        ? Format.bytes(root.capacity.ram - root.usage.ramAvailable) : "—"
                    values: root.ramUsed(); share: root.share("ram"); times: root.times
                    max: root.capacity ? root.capacity.ram : null
                    foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily
                }
                ResourceRow {
                    width: parent.cell; chartHeight: Style.space(22); windowMs: 60000
                    label: "CPU"; format: root.asPercent; live: root.live
                    reading: root.usage ? Format.percent(root.usage.cpuUtil) : "—"
                    values: root.series("cpuUtil"); share: root.share("cpuUtil"); times: root.times
                    max: 100
                    foreground: root.foreground; accent: root.accent; fontFamily: root.fontFamily
                }
            }

            Rectangle { width: parent.width; height: 1; color: root.rule }

            PanelSectionHeader {
                text: "RUNNING"
                foreground: root.foreground
                fontFamily: root.fontFamily
            }

            Text {
                width: parent.width
                visible: root.running.length === 0
                textFormat: Text.PlainText
                text: root.term === ""
                    ? "No agents are running. Open one below and a terminal starts on it."
                    : "No running agent matches."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }

            Column {
                width: parent.width
                spacing: Style.space(2)

                Repeater {
                    model: root.running
                    AgentRow {
                        required property var modelData
                        width: parent.width
                        instance: modelData
                        held: root.heldBy(modelData.sessionId)
                        service: root.service
                        term: root.term
                        foreground: root.foreground
                        accent: root.accent
                        fontFamily: root.fontFamily
                        onStopped: if (root.service) root.service.stopAgent(modelData.sessionId)
                        onOpened: root.opened(String(modelData.agentName).replace(/^@[^/]+\//, ""))
                    }
                }
            }

            Item { width: 1; height: Style.space(4) }

            PanelSectionHeader {
                text: "AGENTS"
                foreground: root.foreground
                fontFamily: root.fontFamily
            }

            Text {
                width: parent.width
                visible: root.idle.length === 0
                textFormat: Text.PlainText
                text: root.term === ""
                    ? "Every agent on this machine is running."
                    : "No agent matches."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }

            Column {
                width: parent.width
                spacing: Style.space(2)

                Repeater {
                    model: root.idle
                    AgentRow {
                        required property var modelData
                        width: parent.width
                        project: modelData
                        service: root.service
                        term: root.term
                        foreground: root.foreground
                        accent: root.accent
                        fontFamily: root.fontFamily
                        onOpened: root.opened(String(modelData.name))
                    }
                }
            }

            Item { width: 1; height: Style.space(16) }
        }
    }
}
