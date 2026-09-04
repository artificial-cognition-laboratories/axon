import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

import "../../../components"
import "../../../src/format.js" as Format

/**
 * Models — everything on this machine, in lifecycle order.
 *
 * ── Why three sections and this order ───────────────────────────────────────
 *
 * Downloading, loaded, on disk. That is the daemon's own vocabulary minus the
 * state it does not own — a weight the registry has and this machine does not
 * belongs in the browser, not here. Reading top to bottom follows a weight's
 * life, so the section a person is looking for is where they would guess.
 *
 * Named "Models" rather than "Loaded" because loaded is one of the three
 * things it shows, and a tab named after its own third section sends people to
 * the browser to find a download.
 *
 * ── Every row is a way in ───────────────────────────────────────────────────
 *
 * A name opens that model in the browser, carried through the overlay's
 * payload. A dropdown listing what you have and offering no way to act on any
 * of it is a status light; this is meant to be the quick menu.
 */
Column {
    id: root

    property var machine: null
    /** The daemon command path, for cancelling a transfer. */
    property var service: null

    property color foreground: Color.foreground
    property color accent: "#0094d2"
    property string fontFamily: Style.font.family

    spacing: Style.space(12)

    readonly property var downloads: machine && machine.downloads ? machine.downloads : []
    readonly property var holds: machine && machine.hasData && machine.holds ? machine.holds : []

    /** Still moving. A finished transfer belongs under what it produced, not under "downloading". */
    readonly property var moving: {
        var out = []
        for (var i = 0; i < downloads.length; i++) {
            if (downloads[i].state === "downloading" || downloads[i].state === "failed") out.push(downloads[i])
        }
        return out
    }

    /** One row per distinct weight, with everything holding it collected onto it. */
    readonly property var resident: {
        var byModel = {}
        var order = []
        for (var i = 0; i < holds.length; i++) {
            var h = holds[i]
            if (!byModel[h.model]) {
                byModel[h.model] = { model: h.model, bytes: h.bytes, holders: [] }
                order.push(h.model)
            }
            byModel[h.model].holders.push(h.agent + " · " + h.role)
        }
        var out = []
        for (var o = 0; o < order.length; o++) out.push(byModel[order[o]])
        return out
    }

    readonly property var onDisk: {
        var out = []
        var all = machine && machine.cached ? machine.cached : []
        for (var i = 0; i < all.length; i++) if (!all[i].resident) out.push(all[i])
        return out
    }

    /** Open one model in the browser, on its detail page. */
    function reveal(id) {
        Quickshell.execDetached(["omarchy-shell", "shell", "summon", "arclabs.axon",
                                 JSON.stringify({ view: "browser", model: String(id) })])
    }

    // ── Downloading ─────────────────────────────────────────────────────────

    Column {
        width: parent.width
        spacing: Style.space(8)
        visible: root.moving.length > 0
        // Air above the heading. A section label belongs to what follows
        // it, so the gap separating the groups sits above the label.
        topPadding: Style.space(8)

        PanelSectionHeader {
            text: "DOWNLOADING"
            foreground: root.foreground
            fontFamily: root.fontFamily
        }

        Repeater {
            model: root.moving

            Item {
                required property var modelData
                width: parent.width
                implicitHeight: line.implicitHeight

                ProgressLine {
                    id: line
                    anchors.left: parent.left
                    anchors.right: cancel.left
                    anchors.rightMargin: Style.space(8)
                    label: Format.basename(modelData.file || modelData.model)
                    value: modelData.state === "failed"
                        ? "failed"
                        : (modelData.total ? Math.round(modelData.received / modelData.total * 100) + "%" : "")
                    detail: modelData.state === "failed"
                        ? (modelData.error || "")
                        : (modelData.total
                            ? Format.bytes(modelData.received) + " of " + Format.bytes(modelData.total)
                            : Format.bytes(modelData.received) + " so far")
                    fraction: modelData.total ? modelData.received / modelData.total : 0
                    alarming: modelData.state === "failed"
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                }

                IconButton {
                    id: cancel
                    anchors.right: parent.right
                    anchors.top: parent.top
                    glyph: "✕"
                    destructive: true
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onClicked: if (root.service) root.service.cancelDownload(modelData.id)
                }
            }
        }
    }

    // ── Loaded ──────────────────────────────────────────────────────────────

    Column {
        width: parent.width
        spacing: Style.space(10)
        // Air above the heading. A section label belongs to what follows
        // it, so the gap separating the groups sits above the label.
        topPadding: Style.space(8)

        Item {
            width: parent.width
            height: loadedHeader.implicitHeight

            PanelSectionHeader {
                id: loadedHeader
                text: "LOADED"
                foreground: root.foreground
                fontFamily: root.fontFamily
            }
        }

        EmptyState {
            width: parent.width
            visible: root.resident.length === 0
            foreground: root.foreground
            text: !root.machine || !root.machine.hasData
                ? (root.machine ? root.machine.detail : "")
                : "Nothing loaded — an agent loads what it needs"
        }

        Repeater {
            model: root.resident

            ListRow {
                required property var modelData
                primary: Format.basename(modelData.model)
                // Every holder, not a count: two agents sharing one weight is
                // the daemon working, and naming both is how that shows.
                secondary: modelData.holders.join("  ·  ")
                trailing: Format.bytes(modelData.bytes)
                emphasised: true
                interactive: true
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
                onActivated: root.reveal(modelData.model)
            }
        }
    }

    // ── On disk ─────────────────────────────────────────────────────────────

    Column {
        width: parent.width
        spacing: Style.space(10)
        visible: root.onDisk.length > 0 || root.resident.length > 0
        // Air above the heading. A section label belongs to what follows
        // it, so the gap separating the groups sits above the label.
        topPadding: Style.space(8)

        Item {
            width: parent.width
            height: diskHeader.implicitHeight

            PanelSectionHeader {
                id: diskHeader
                text: "ON DISK"
                foreground: root.foreground
                fontFamily: root.fontFamily
            }

            Text {
                anchors.right: parent.right
                anchors.verticalCenter: diskHeader.verticalCenter
                textFormat: Text.PlainText
                text: "Browse  ›"
                color: browseHover.hovered ? root.accent : Qt.darker(root.foreground, 1.55)
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true

                HoverHandler { id: browseHover; cursorShape: Qt.PointingHandCursor }
                TapHandler {
                    onTapped: Quickshell.execDetached(["omarchy-shell", "shell", "toggle", "arclabs.axon"])
                }
            }
        }

        EmptyState {
            width: parent.width
            visible: root.onDisk.length === 0
            foreground: root.foreground
            text: "Nothing cached yet"
        }

        Repeater {
            model: root.onDisk

            ListRow {
                required property var modelData
                primary: modelData.name
                // Runtime is nullable and was being concatenated straight into
                // the line, so a weight nothing can execute read "facebook ·
                // null" — the string, rendered.
                secondary: modelData.owner
                    + (modelData.runtime ? "  ·  " + modelData.runtime : "  ·  no runtime here")
                trailing: Format.bytes(modelData.bytes)
                interactive: true
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
                onActivated: root.reveal(modelData.id)
            }
        }
    }
}
