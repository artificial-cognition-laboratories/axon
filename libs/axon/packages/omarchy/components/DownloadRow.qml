import QtQuick
import qs.Commons

import "../src/format.js" as Format

/**
 * One transfer, with its progress.
 *
 * The bar is the row: a separate track under a label would double the height
 * of something there may be several of, and the useful signal is how far along
 * rather than a precise figure. The number is there for anyone who wants it.
 */
Item {
    id: root

    property var download: null
    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    signal cancelled()

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property bool live: !!download && download.state === "downloading"
    readonly property bool failed: !!download && download.state === "failed"
    readonly property real fraction: {
        if (!download || !download.total || download.total <= 0) return 0
        return Math.max(0, Math.min(1, download.received / download.total))
    }

    width: parent ? parent.width : implicitWidth
    implicitHeight: labels.implicitHeight + Style.space(14)

    // The fill sits BEHIND the text rather than beside it, so a row stays one
    // line however many are running.
    Rectangle {
        anchors.fill: parent
        anchors.leftMargin: -Style.space(6)
        anchors.rightMargin: -Style.space(6)
        radius: Style.cornerRadius
        color: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.05)
        visible: root.live

        Rectangle {
            width: parent.width * root.fraction
            height: parent.height
            radius: Style.cornerRadius
            color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.16)
            Behavior on width { NumberAnimation { duration: 300; easing.type: Easing.OutQuad } }
        }
    }

    Column {
        id: labels
        anchors.left: parent.left
        anchors.right: trailing.left
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(1)

        Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.download ? Format.basename(root.download.file || root.download.model) : ""
            color: root.failed ? "#e88" : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
        }

        Text {
            width: parent.width
            textFormat: Text.PlainText
            text: {
                if (!root.download) return ""
                if (root.failed) return root.download.error || "failed"
                if (root.download.state === "cancelled") return "cancelled"
                if (root.download.state === "done") return "complete"
                if (!root.download.total) return Format.bytes(root.download.received) + " so far"
                return Format.bytes(root.download.received) + " of " + Format.bytes(root.download.total)
            }
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
        }
    }

    Row {
        id: trailing
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(10)

        Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.live
            textFormat: Text.PlainText
            text: root.download && root.download.total ? Math.round(root.fraction * 100) + "%" : ""
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.live
            textFormat: Text.PlainText
            text: "✕"
            color: cancelHover.hovered ? "#e05252" : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption

            HoverHandler { id: cancelHover; cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: root.cancelled() }
        }
    }
}
