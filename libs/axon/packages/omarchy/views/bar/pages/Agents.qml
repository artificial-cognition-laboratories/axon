import QtQuick
import qs.Commons
import qs.Ui

import "../../../components"
import "../../../src/format.js" as Format

/**
 * Agents — every live agent this daemon can see.
 *
 * ── Flat, not a tree ────────────────────────────────────────────────────────
 *
 * The ownership graph is real — `parentSessionId` says which agent spawned
 * which — but a dropdown is not where it earns its space. Nesting spends
 * indentation on a relationship that is usually one level deep and often
 * absent, and it makes the common case (three agents, none related) look like
 * a structure. A flat list answers "what is running" directly, and the parent
 * is a line of provenance on the row that has one.
 *
 * The tree belongs where it can be expanded and clicked into. That is the
 * editor, and later a full Omarchy view.
 *
 * These outlive the terminal that started them, which is why this view belongs
 * on a desktop rather than only in an editor.
 */
Column {
    id: root

    property var machine: null
    property color foreground: Color.foreground
    property color accent: "#0094d2"
    property string fontFamily: Style.font.family

    spacing: Style.space(10)

    readonly property var live: machine && machine.hasData && machine.agents ? machine.agents : []

    /** Session id → agent name, so a child can name its parent rather than its id. */
    readonly property var bySession: {
        var map = {}
        for (var i = 0; i < live.length; i++) map[live[i].sessionId] = live[i].agentName
        return map
    }

    /** Roots first, then everything spawned — running order, not a hierarchy. */
    readonly property var ordered: {
        var roots = []
        var spawned = []
        for (var i = 0; i < live.length; i++) {
            if (live[i].parentSessionId) spawned.push(live[i])
            else roots.push(live[i])
        }
        return roots.concat(spawned)
    }

    PanelSectionHeader {
        text: "RUNNING"
        foreground: root.foreground
        fontFamily: root.fontFamily
    }

    EmptyState {
        width: parent.width
        visible: root.ordered.length === 0
        foreground: root.foreground
        text: !root.machine || !root.machine.hasData
            ? (root.machine ? root.machine.detail : "")
            : "No agents running"
    }

    Column {
        width: parent.width
        spacing: Style.space(10)

        Repeater {
            model: root.ordered

            ListRow {
                required property var modelData
                readonly property string parentName:
                    modelData.parentSessionId ? (root.bySession[modelData.parentSessionId] || "") : ""

                primary: modelData.agentName
                secondary: parentName !== ""
                    ? "spawned by " + parentName
                    : Format.basename(modelData.projectRoot) + " · pid " + modelData.pid
                trailing: Format.since(modelData.startedAt)
                emphasised: parentName === ""
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
            }
        }
    }
}
