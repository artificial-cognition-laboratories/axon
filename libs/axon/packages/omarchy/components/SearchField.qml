import QtQuick
import qs.Commons

/**
 * The header's search input.
 *
 * Search is the header rather than a destination in the rail: it is what
 * ninety percent of a visit to this surface consists of, and a primary action
 * you have to navigate to is not primary.
 */
Item {
    id: root

    property alias text: input.text
    property string placeholder: "Search models…"

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    signal accepted()
    signal moved(int delta)

    readonly property color dim: Qt.darker(foreground, 1.55)

    function take() { input.forceActiveFocus() }

    implicitHeight: Style.space(30)

    // The Axon mark rather than a magnifying glass. The field is unmistakably
    // a search field from its placeholder and its position; what the glyph can
    // add is whose search it is. Brand cyan, the same weight it carries in the
    // panel hero — this is the only other place the mark appears at size.
    Chevron {
        id: glyph
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        color: root.accent
        size: Style.font.subtitle
        weight: 0.125
    }

    TextInput {
        id: input
        anchors.left: glyph.right
        anchors.leftMargin: Style.space(8)
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        selectByMouse: true
        selectionColor: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.35)
        clip: true

        // The list is driven from here so typing never has to stop: arrows move
        // the selection while the caret stays in the query.
        Keys.onUpPressed: root.moved(-1)
        Keys.onDownPressed: root.moved(1)
        onAccepted: root.accepted()

        Text {
            anchors.fill: parent
            verticalAlignment: Text.AlignVCenter
            visible: input.text === ""
            textFormat: Text.PlainText
            text: root.placeholder
            color: root.dim
            font: input.font
        }
    }
}
