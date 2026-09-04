import QtQuick
import qs.Commons

/**
 * A compact control for the list's own header row.
 *
 * Sort and the fit filter belong here rather than in the rail or a new band
 * above the results: the rail means SCOPE and the header means SEARCH, and
 * both of those invariants are why this surface stays legible. How a list is
 * ordered, and what it excludes, are properties of the list — so they sit on
 * the list's heading, which already exists and costs no new chrome.
 *
 * Clicking cycles, the same gesture the budget readout uses. A dropdown would
 * be more discoverable for eight options; for four it is a menu to open, aim
 * at and dismiss where a click would have done.
 */
Item {
    id: root

    property string label: ""
    /** Drawn as engaged — a filter that is on, rather than a value that is set. */
    property bool active: false
    property bool showCaret: false

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    signal clicked()

    readonly property color dim: Qt.darker(foreground, 1.55)

    implicitWidth: text.implicitWidth + Style.space(16)
    implicitHeight: text.implicitHeight + Style.space(8)

    Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        color: root.active
            ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.16)
            : (hover.hovered ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08) : "transparent")

        Behavior on color { ColorAnimation { duration: 90 } }
    }

    Text {
        id: text
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: root.label + (root.showCaret ? "  ▾" : "")
        color: root.active ? root.accent : (hover.hovered ? root.foreground : root.dim)
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: root.active
    }

    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
    TapHandler { onTapped: root.clicked() }
}
