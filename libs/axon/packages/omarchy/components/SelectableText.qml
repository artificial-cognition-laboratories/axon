import QtQuick

/*
 * Read-only rich text with native selection. QML Text only paints text; TextEdit
 * is the selectable primitive. Kept as a leaf so document blocks retain their
 * layout and styling responsibilities.
 */
TextEdit {
    id: root

    readOnly: true
    selectByMouse: true
    selectByKeyboard: true
    focusPolicy: Qt.ClickFocus
    cursorVisible: false
    textFormat: TextEdit.RichText
    wrapMode: TextEdit.Wrap
    padding: 0
    leftPadding: 0
    rightPadding: 0
    topPadding: 0
    bottomPadding: 0
    selectionColor: Qt.rgba(0.0, 0.58, 0.82, 0.38)
    selectedTextColor: color

    implicitWidth: contentWidth
    implicitHeight: contentHeight
}
