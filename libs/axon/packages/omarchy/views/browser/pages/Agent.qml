import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui

import "../../../components"
import "../../../src/format.js" as Format

/**
 * One agent, as a thing that exists rather than a thing that is running.
 *
 * ── What belongs here and what does not ─────────────────────────────────────
 *
 * The rule the whole plugin follows: if a fact is only true WHILE an agent is
 * running, it belongs in the terminal; if it is true when nothing is running,
 * it belongs here. A conversation is the first kind. A schedule is the second
 * — it fires when no terminal is open, no editor is open, and possibly while
 * the person is asleep, so the desktop is the only surface that can own it.
 *
 * That is also the honest answer to the overlap with the Fleet extension.
 * Fleet is the AUTHORING view — live, attached, beside the code you are
 * writing. This is the OPERATIONS view — persistent, machine-wide, about an
 * agent you are not currently looking at. Same data, different question.
 *
 * ── No charts ───────────────────────────────────────────────────────────────
 *
 * The four resource readings live on the machine page and the fleet list,
 * which are the two places the answer changes a decision ("can I start
 * another one"). Repeating them on a page about ONE agent's definition would
 * be decoration that pushes the actual content below the fold.
 */
Item {
    id: root

    /** The installed project this page is about. Null renders nothing. */
    property var project: null
    /** Its live instance, when one is running. */
    property var instance: null

    property var machine: null
    property var service: null

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    signal dismissed()

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property color rule: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.12)

    readonly property bool live: !!instance

    readonly property string name: project ? String(project.ref || project.name) : ""
    readonly property string root_: project ? String(project.root || "") : ""

    /** Which tab is showing. Local: it is a view state, not something the daemon owns. */
    property string tab: "overview"

    /*
     * Back to the fleet whenever the page's subject changes.
     *
     * Opening a different agent while sitting on Schedules would land on a tab
     * about the previous one's wakeups, which reads as the page failing to
     * update rather than as a tab that was left open.
     */
    onNameChanged: tab = "overview"

    /** Bytes of weights this agent is holding right now. */
    readonly property real held: {
        if (!live || !machine || !machine.holds) return 0
        var total = 0
        for (var i = 0; i < machine.holds.length; i++) {
            if (String(machine.holds[i].agent).indexOf(String(instance.sessionId)) !== -1) total += machine.holds[i].bytes
        }
        return total
    }

    /**
     * The source files this agent actually has.
     *
     * From the daemon, which checked they exist while it was already walking
     * the directory — never derived from the convention here. A link to a
     * `src/tools` that is not there opens an empty buffer and tells the person
     * their agent has something it does not.
     */
    readonly property var definition: project && project.definition ? project.definition : []

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
            // The same 575 every page in this window uses. The pane is as wide
            // as the window; this content is facts and prose, both of which get
            // harder to read the wider they run.
            anchors.horizontalCenter: parent.horizontalCenter
            width: Math.min(parent.width, Style.space(575))
            spacing: 0

            // Breathing room above the title. The pane's own top edge is the
            // window's, and a heading hard against it reads as clipped.
            Item { width: 1; height: Style.space(10) }

            // ── Header ──────────────────────────────────────────────────────
            //
            // Inline, not sticky. It is four lines; pinning it would spend
            // permanent vertical space to save a scroll that barely happens,
            // and every other page here scrolls its title away too.
            Item {
                width: parent.width
                height: identity.implicitHeight

                Column {
                    id: identity
                    anchors.left: parent.left
                    anchors.right: verbs.left
                    anchors.rightMargin: Style.space(12)
                    anchors.top: parent.top
                    spacing: Style.space(3)

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: root.name
                        color: root.live ? root.accent : root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.subtitle
                        font.bold: true
                        elide: Text.ElideRight
                    }

                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: {
                            var parts = []
                            if (root.project && root.project.version) parts.push("v" + root.project.version)
                            parts.push(root.live ? "running" : "idle")
                            if (root.held > 0) parts.push(Format.bytes(root.held) + " held")
                            return parts.join(" · ")
                        }
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }
                }

                /*
                 * The same three verbs the row carries, in the same order.
                 *
                 * A detail page that offered a different set would make the
                 * list and the page disagree about what you can do with an
                 * agent. They both dispatch through the service, so there is
                 * one definition of what "open a terminal on it" means.
                 */
                Row {
                    id: verbs
                    anchors.right: parent.right
                    anchors.top: parent.top
                    spacing: Style.space(2)

                    IconButton {
                        glyph: "\uea85"  // codicon terminal
                        foreground: root.foreground
                        accent: root.accent
                        fontFamily: root.fontFamily
                        onClicked: if (root.service) root.service.openTerminal(root.live ? root.name : root.root_)
                    }

                    IconButton {
                        visible: root.root_ !== ""
                        glyph: "\ueaf7"  // codicon folder-opened
                        foreground: root.foreground
                        accent: root.accent
                        fontFamily: root.fontFamily
                        onClicked: if (root.service) root.service.openEditor(root.root_)
                    }

                    IconButton {
                        visible: root.live
                        glyph: "\uead7"  // codicon debug-stop
                        destructive: true
                        foreground: root.foreground
                        accent: root.accent
                        fontFamily: root.fontFamily
                        onClicked: if (root.service && root.instance) root.service.stopAgent(root.instance.sessionId)
                    }
                }
            }

            Item { width: 1; height: Style.space(14) }

            TabStrip {
                width: parent.width
                tabs: [
                    { value: "overview", label: "Overview" },
                    { value: "schedules", label: "Schedules" },
                    { value: "sessions", label: "Sessions" },
                ]
                value: root.tab
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
                onSelected: function (v) { root.tab = v }
            }

            // ── Overview ────────────────────────────────────────────────────
            Column {
                width: parent.width
                visible: root.tab === "overview"
                spacing: 0

                SettingsSection {
                    width: parent.width
                    title: "Agent"
                    description: "What this agent is on this machine. Runtime details belong to the terminal it runs in."
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                }

                SettingsRow {
                    width: parent.width
                    label: "Identity"
                    value: root.name
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                }

                SettingsRow {
                    width: parent.width
                    label: "Project root"
                    description: "Opens in your editor."
                    value: root.root_
                    linked: root.root_ !== ""
                    accent: root.accent
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    onActivated: if (root.service) root.service.openEditor(root.root_)
                }

                SettingsRow {
                    width: parent.width
                    label: "Profile"
                    description: "The account this agent is installed under."
                    value: root.project ? String(root.project.profile || "—") : "—"
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                }

                SettingsRow {
                    width: parent.width
                    label: "Status"
                    value: root.live ? "Running" : "Idle"
                    valueColor: root.live ? root.accent : root.dim
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                }

                SettingsRow {
                    width: parent.width
                    label: "Last used"
                    /*
                     * `usedAt` is epoch MILLISECONDS; `since()` parses an ISO
                     * string. Handed the number directly it returns "" — a
                     * blank row rather than a wrong one, which is the kind of
                     * silent nothing that survives review.
                     *
                     * Null when the filesystem could not say, and "—" is the
                     * honest rendering of that; a zero would read as 1970.
                     */
                    value: root.project && root.project.usedAt
                        ? Format.since(new Date(root.project.usedAt).toISOString()) + " ago"
                        : "—"
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                }

                SettingsSection {
                    width: parent.width
                    title: "Definition"
                    description: "The source that decides how this agent boots and what it can do. Each opens in your editor."
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                }

                Repeater {
                    model: root.definition

                    SettingsRow {
                        required property var modelData
                        width: page.width
                        label: String(modelData.label)
                        // The path relative to the project, because the
                        // absolute one is mostly the root repeated on every row.
                        value: String(modelData.path).indexOf(root.root_) === 0
                            ? String(modelData.path).slice(root.root_.length + 1)
                            : String(modelData.path)
                        linked: true
                        accent: root.accent
                        foreground: root.foreground
                        fontFamily: root.fontFamily
                        onActivated: if (root.service) root.service.openEditor(String(modelData.path))
                    }
                }

                EmptyState {
                    width: parent.width
                    visible: root.definition.length === 0
                    text: "No source files were readable in this project."
                    foreground: root.foreground
                }
            }

            // ── Schedules ───────────────────────────────────────────────────
            Column {
                width: parent.width
                visible: root.tab === "schedules"
                spacing: 0

                SettingsSection {
                    width: parent.width
                    title: "Schedules"
                    description: "Axond wakes this agent on a clock, with no terminal open. This is the only surface that can show that, which is why it is here rather than in the editor."
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                }

                /*
                 * Deliberately says it is not connected yet.
                 *
                 * `Schedule()` in the daemon is real and now actually runs —
                 * its execution path threw `ReferenceError` on the first line
                 * of every run until this pass — but nothing exposes it over
                 * the control socket, so this view has no way to read or write
                 * one. An empty list here would claim this agent has no
                 * wakeups, which is a different statement from "we cannot see
                 * them yet" and the wrong one to make.
                 */
                EmptyState {
                    width: parent.width
                    text: "Not connected yet — the daemon owns schedules, and this view cannot read them."
                    foreground: root.foreground
                }
            }

            // ── Sessions ────────────────────────────────────────────────────
            Column {
                width: parent.width
                visible: root.tab === "sessions"
                spacing: 0

                SettingsSection {
                    width: parent.width
                    title: "Sessions"
                    description: "What this agent has done. Opening one continues it in a terminal."
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                }

                EmptyState {
                    width: parent.width
                    text: "Not connected yet — session history is on disk, but the daemon does not report it."
                    foreground: root.foreground
                }
            }

            Item { width: 1; height: Style.space(24) }
        }
    }
}
