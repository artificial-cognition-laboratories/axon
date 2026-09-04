import QtQuick
import qs.Commons

/**
 * A read-only fact about the daemon.
 *
 * Label, an optional line saying what it means, and the value on the right —
 * the shape Omarchy's own panels use for anything a person reads rather than
 * changes.
 */
Item {
    id: root

    property string label: ""
    property string description: ""
    property string value: "—"
    property color valueColor: foreground

    /**
     * The value opens something — a file in the editor, a directory.
     *
     * A link rather than a separate LinkRow so a page can mix facts you read
     * with facts you open without the two rows sitting at different heights.
     * The value wears the accent when it is one, which is the same signal a
     * model name carries when it is installed.
     */
    property bool linked: false
    property color accent: "#0094d2"
    property color foreground: Color.menu.text
    property string fontFamily: Style.font.menuFamily

    signal activated()

    readonly property color dim: Qt.darker(foreground, 1.55)

    implicitHeight: labels.implicitHeight + Style.space(12)

    Column {
        id: labels
        anchors.left: parent.left
        anchors.right: reading.left
        anchors.rightMargin: Style.space(16)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(1)

        Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.label
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
        }

        Text {
            width: parent.width
            visible: root.description !== ""
            textFormat: Text.PlainText
            text: root.description
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
        }
    }

    Text {
        id: reading
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: root.value
        color: root.linked
            ? (linkHover.hovered ? Qt.lighter(root.accent, 1.25) : root.accent)
            : root.valueColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption

        HoverHandler {
            id: linkHover
            enabled: root.linked
            cursorShape: Qt.PointingHandCursor
        }

        TapHandler {
            enabled: root.linked
            onTapped: root.activated()
        }
    }
}
