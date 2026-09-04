import QtQuick
import qs.Commons

/**
 * Tags, as chips that wrap.
 *
 * They were one dot-joined line, elided — which meant thirteen tags rendered as
 * four and a half followed by an ellipsis, and no way to read the rest. A tag
 * list is scanned, not read in order, so it wants a shape that wraps rather
 * than one that runs off the edge.
 */
Flow {
    id: root

    property var tags: []
    /** Beyond this, the rest collapse into a count. A card can carry thirty. */
    property int limit: 12

    property color foreground: Color.menu.text
    property string fontFamily: Style.font.menuFamily

    readonly property color dim: Qt.darker(foreground, 1.7)
    readonly property var shown: (tags || []).slice(0, limit)
    readonly property int hidden: Math.max(0, (tags || []).length - limit)

    spacing: Style.space(6)

    Repeater {
        model: root.shown

        Rectangle {
            required property var modelData
            width: chip.implicitWidth + Style.space(14)
            height: chip.implicitHeight + Style.space(6)
            radius: Style.cornerRadius
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)

            Text {
                id: chip
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: String(modelData)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
            }
        }
    }

    Text {
        visible: root.hidden > 0
        height: Style.space(6) + implicitHeight
        verticalAlignment: Text.AlignVCenter
        textFormat: Text.PlainText
        text: "+" + root.hidden
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
    }
}
