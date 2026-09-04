import QtQuick
import qs.Commons

/**
 * A small bordered action.
 *
 * `qs.Ui` has `WidgetButton`, but it is bar chrome — sized for a status slot,
 * coloured from the bar, and with no clicked signal at all. This is the
 * plugin's own idiom: hover and tap handlers over a rounded surface, the same
 * shape every other interactive thing here uses.
 */
Item {
    id: root

    property string text: ""
    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily
    /** Destructive actions wear their own colour, everywhere, without asking. */
    property bool destructive: false
    property bool enabled: true

    signal clicked()

    readonly property color tint: destructive ? "#e05252" : accent

    implicitWidth: label.implicitWidth + Style.space(22)
    implicitHeight: label.implicitHeight + Style.space(10)
    opacity: enabled ? 1.0 : 0.45

    Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        color: hover.hovered && root.enabled
            ? Qt.rgba(root.tint.r, root.tint.g, root.tint.b, 0.16)
            : Qt.rgba(root.tint.r, root.tint.g, root.tint.b, 0.08)
        border.width: 1
        border.color: Qt.rgba(root.tint.r, root.tint.g, root.tint.b, hover.hovered && root.enabled ? 0.55 : 0.3)

        Behavior on color { ColorAnimation { duration: 90 } }
    }

    Text {
        id: label
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: root.text
        color: root.tint
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: true
    }

    HoverHandler {
        id: hover
        enabled: root.enabled
        cursorShape: Qt.PointingHandCursor
    }

    TapHandler {
        enabled: root.enabled
        onTapped: root.clicked()
    }
}
