import QtQuick
import qs.Commons

/**
 * A label, a figure, and a full-width track beneath them.
 *
 * The shape Omarchy's own agent-usage panel uses for a quota — name on the
 * left, percentage on the right, a thin rule under both, and a line of detail
 * below that. Copying it is the point: a progress row that invents its own
 * geometry reads as a different application inside the same bar.
 */
Item {
    id: root

    property string label: ""
    property string value: ""
    property string detail: ""
    /**
     * 0..1, or negative for indeterminate.
     *
     * Indeterminate does not draw a fill at some invented percentage — it runs
     * a shuttle across the track instead. An empty track reads as stalled and
     * a half-full one is a claim we cannot make, so the honest signal is
     * motion: something is happening, nobody knows how far along.
     */
    property real fraction: 0

    property color foreground: Color.foreground
    property color accent: "#0094d2"
    property string fontFamily: Style.font.family
    property bool alarming: false

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property bool indeterminate: fraction < 0

    width: parent ? parent.width : implicitWidth
    implicitHeight: name.implicitHeight + track.height + sub.implicitHeight + Style.space(12)

    Text {
        id: name
        anchors.left: parent.left
        anchors.right: figure.left
        anchors.rightMargin: Style.space(10)
        anchors.top: parent.top
        textFormat: Text.PlainText
        text: root.label
        color: root.alarming ? "#e88" : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
    }

    Text {
        id: figure
        anchors.right: parent.right
        anchors.baseline: name.baseline
        textFormat: Text.PlainText
        text: root.value
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
    }

    Rectangle {
        id: track
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: name.bottom
        anchors.topMargin: Style.space(6)
        height: Style.space(3)
        radius: height / 2
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

        Rectangle {
            visible: !root.indeterminate
            width: parent.width * Math.max(0, Math.min(1, root.fraction))
            height: parent.height
            radius: parent.radius
            color: root.alarming ? "#e05252" : root.accent
            // Animated, because bytes arrive in bursts and a bar that jumped
            // in steps would read as stalling between them.
            Behavior on width { NumberAnimation { duration: 320; easing.type: Easing.OutQuad } }
        }

        // The shuttle, when there is no fraction to draw. Shared with the
        // other surfaces that wait on work of unknown length.
        BusyTrack {
            anchors.fill: parent
            visible: root.indeterminate
            active: root.indeterminate && root.visible
            accent: root.alarming ? "#e05252" : root.accent
            track: "transparent"
        }
    }

    Text {
        id: sub
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: track.bottom
        anchors.topMargin: Style.space(4)
        textFormat: Text.PlainText
        text: root.detail
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
    }
}
