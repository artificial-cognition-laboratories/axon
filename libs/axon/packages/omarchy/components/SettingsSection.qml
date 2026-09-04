import QtQuick
import qs.Commons

/** A heading and its one-line rationale. */
Column {
    id: root

    property string title: ""
    property string description: ""
    property color foreground: Color.menu.text
    property string fontFamily: Style.font.menuFamily

    readonly property color dim: Qt.darker(foreground, 1.55)

    spacing: Style.space(3)
    topPadding: Style.space(22)
    bottomPadding: Style.space(6)

    Text {
        textFormat: Text.PlainText
        text: root.title
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.subtitle
        font.bold: true
    }

    Text {
        width: root.width
        visible: root.description !== ""
        textFormat: Text.PlainText
        text: root.description
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
    }
}
