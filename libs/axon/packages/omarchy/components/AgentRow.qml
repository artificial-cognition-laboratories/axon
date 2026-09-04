import QtQuick
import qs.Commons

import "../src/format.js" as Format

/**
 * One agent, running or not.
 *
 * The same shape as ModelRow on purpose. Two lists in one window that describe
 * different things should still be read the same way — name and origin on the
 * left, verbs then a figure on the right — so learning one teaches the other.
 *
 * Every verb is a HANDOFF. This row opens a terminal, opens an editor, or
 * stops a process; it never talks to an agent, because the terminal already
 * does that better than a list row ever could.
 */
Item {
    id: root

    /** A live instance from the daemon's registry, when this row is running. */
    property var instance: null
    /** An installed project, when it is not. Exactly one of the two is set. */
    property var project: null

    /** Bytes of model weights this agent is holding. Zero when it holds none. */
    property real held: 0

    /**
     * The daemon link, which owns every handoff.
     *
     * The row used to build its own `omarchy-launch-tui` command line, PATH
     * export and all. That command belongs to the thing that resolved the CLI
     * binary, and the detail header needs the identical one — two copies of a
     * subtle environment fix is how they drift.
     */
    property var service: null

    property string term: ""
    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    signal stopped()

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property bool live: !!instance

    /**
     * `@scope/name`, from whichever side of the row is set.
     *
     * A project's DIRECTORY name is not its name — `zeno` on disk is
     * `@axon/zeno` to the CLI and to anyone reading the list. The daemon reads
     * the declared one out of the project's package.json; `name` is the
     * fallback for a project that declares none.
     */
    readonly property string name: live
        ? String(instance.agentName)
        : (project ? String(project.ref || project.name) : "")

    /** Where the source is, which is what an editor gets pointed at. */
    readonly property string root_: live
        ? String(instance.projectRoot || "")
        : (project ? String(project.root) : "")

    /**
     * What `axon <ref>` is given.
     *
     * A running instance already carries a scoped name — `@cody/zeno` — and a
     * project carries only its directory name, which the CLI rejects as an
     * unknown COMMAND rather than an agent. Its absolute path is a ref the CLI
     * takes and needs no scope guessed for it: the scope lives on the account,
     * not on the folder, and inventing one produced "Unknown command: zeno".
     */
    readonly property string ref: live ? name : root_

    /**
     * Emitted when the row itself is clicked, for a caller that has somewhere
     * to go. The verbs stay buttons: opening a detail view and opening a
     * terminal are different intentions and must not share a hit area.
     */
    signal opened()

    readonly property string detail: live
        ? ("pid " + instance.pid + " · " + Format.since(instance.startedAt))
        : (project ? String(project.profile) : "")

    readonly property real inset: Style.space(10)

    width: parent ? parent.width : implicitWidth
    implicitHeight: Style.space(44)

    Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
        visible: hover.hovered
    }

    Column {
        anchors.left: parent.left
        anchors.leftMargin: root.inset
        anchors.right: actions.left
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
            width: parent.width
            textFormat: Text.RichText
            text: Format.highlight(root.name, root.term, root.accent)
            // Running agents wear the brand, exactly as resident models do.
            color: root.live ? root.accent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
        }

        Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.detail
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
        }
    }

    Row {
        id: actions
        anchors.right: badge.left
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        /*
         * Open a terminal ON this agent.
         *
         * The single most important control here: someone who has installed
         * the plugin already has the CLI and an agent, and has never opened a
         * terminal. `axon <name> -a` is the whole onboarding, and a button is
         * the difference between discovering that and not.
         */
        IconButton {
            glyph: "\uea85"  // codicon terminal
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onClicked: if (root.service) root.service.openTerminal(root.ref)
        }

        IconButton {
            visible: root.root_ !== ""
            glyph: "\ueaf7"  // codicon folder-opened
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onClicked: if (root.service) root.service.openEditor(root.root_)
        }

        // Stopping is destructive and only meaningful while something runs.
        IconButton {
            visible: root.live
            glyph: "\uead7"  // codicon debug-stop
            destructive: true
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onClicked: root.stopped()
        }
    }

    Column {
        id: badge
        anchors.right: parent.right
        anchors.rightMargin: root.inset
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
            anchors.right: parent.right
            visible: root.held > 0
            textFormat: Text.PlainText
            text: Format.bytes(root.held)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
        }

        Text {
            anchors.right: parent.right
            textFormat: Text.PlainText
            text: root.live ? "RUNNING" : "IDLE"
            color: root.live ? root.accent : Qt.darker(root.foreground, 2.0)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
        }
    }

    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }

    /*
     * The row opens the agent; the verbs keep their own hit areas.
     *
     * Excluded by GEOMETRY rather than by relying on the buttons to consume the
     * event, because handlers do not consume — a tap on "stop" reaches this one
     * too, and would have opened the detail view of the agent it just killed.
     * Same fix ModelRow uses for the same reason.
     */
    TapHandler {
        onTapped: function (point) {
            if (actions.contains(actions.mapFromItem(root, point.position))) return
            root.opened()
        }
    }
}
