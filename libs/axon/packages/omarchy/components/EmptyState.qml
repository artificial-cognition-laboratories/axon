import QtQuick
import qs.Commons

/** An empty section says why it is empty, never nothing at all. */
Text {
    property color foreground: Color.foreground

    textFormat: Text.PlainText
    color: Qt.darker(foreground, 1.55)
    font.family: Style.font.family
    font.pixelSize: Style.font.body
    font.italic: true
    // Wraps rather than eliding. These lines explain why something is empty,
    // and half an explanation is worse than none — the dictation trouble line
    // in particular carries a command someone has to be able to read.
    wrapMode: Text.WordWrap
}
