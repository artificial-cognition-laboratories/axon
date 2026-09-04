import QtQuick
import qs.Commons

/**
 * The input box: a text area with a control bar inside its own border.
 *
 * ── Why one surface and not a field with a row under it ─────────────────────
 *
 * The shape every current assistant converged on — Claude, T3, ChatGPT — is a
 * single rounded surface holding the text and its controls, and it converged
 * because it reads as ONE object you are addressing rather than a form you are
 * filling in. That distinction matters more here than it does there: this
 * panel's whole job is making a local weight feel like something you can talk
 * to, and a form does not feel like that.
 *
 * ── What it does NOT own ────────────────────────────────────────────────────
 *
 * It does not know what a model is, cannot run one, and has no idea what an
 * attachment will be used for. It renders text, holds attachments it was
 * given, and emits. Everything about capability lives in the page above,
 * because the same box serves a chat model, a transcriber and an embedder and
 * must not grow a branch per modality.
 */
Item {
    id: root

    property string placeholder: "Ask this model something…"
    property alias text: input.text

    /** [{ kind, name }] — what has been attached. Rendered as chips above the text. */
    property var attachments: []

    /**
     * A run is in flight. Blocks the text, because the box is about to be
     * cleared and typing into something that is going to be wiped is a lie.
     */
    property bool busy: false

    /**
     * Whether submitting would actually do anything.
     *
     * SEPARATE from `busy` on purpose. The first version disabled the whole
     * box whenever the model was not resident, which read as the input being
     * broken — you could not click into it, and nothing said why. Composing
     * before loading is completely reasonable; only the send is not.
     */
    property bool canSend: true

    /** Whether this model can take a file at all. Hides the attach control. */
    property bool accepts: true

    /** Free-form right-hand label — the page puts the model name here. */
    property string trailing: ""

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property bool empty: input.text.trim() === "" && attachments.length === 0

    /** Everything that has to be true for the arrow to mean anything. */
    readonly property bool sendable: !empty && !busy && canSend

    signal submitted(string text)
    signal attachRequested()
    signal attachmentRemoved(int index)
    signal trailingActivated()

    function take() { input.forceActiveFocus() }
    function clear() { input.text = "" }

    implicitHeight: frame.implicitHeight

    Rectangle {
        id: frame
        anchors.fill: parent
        radius: Style.space(10)
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
        border.width: 1
        border.color: input.activeFocus
            ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.55)
            : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.14)

        implicitHeight: body.implicitHeight + Style.space(20)

        Behavior on border.color { ColorAnimation { duration: 120 } }

        Column {
            id: body
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: Style.space(10)
            spacing: Style.space(8)

            // ── Attachments ─────────────────────────────────────────────────
            // Above the text rather than beside the controls: a file you added
            // is context for what you are about to type, and context belongs
            // where you can see it while typing.

            Flow {
                width: parent.width
                spacing: Style.space(6)
                visible: root.attachments.length > 0

                Repeater {
                    model: root.attachments

                    Rectangle {
                        required property var modelData
                        required property int index
                        radius: Style.cornerRadius
                        color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.12)
                        border.width: 1
                        border.color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.28)
                        implicitWidth: chip.implicitWidth + Style.space(20)
                        implicitHeight: chip.implicitHeight + Style.space(8)

                        Text {
                            id: chip
                            anchors.centerIn: parent
                            textFormat: Text.PlainText
                            text: String(parent.modelData.name) + "  ×"
                            color: root.accent
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                        }

                        HoverHandler { cursorShape: Qt.PointingHandCursor }
                        TapHandler { onTapped: root.attachmentRemoved(parent.index) }
                    }
                }
            }

            // ── The text ────────────────────────────────────────────────────

            TextEdit {
                id: input
                width: parent.width
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                wrapMode: TextEdit.Wrap
                selectByMouse: true
                selectionColor: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.35)
                enabled: !root.busy

                // A floor of three lines, growing with the content. A box that
                // starts one line tall and jumps as you type reflows the whole
                // page under it on the second word.
                height: Math.max(implicitHeight, font.pixelSize * 3.2)

                /*
                 * Enter sends, Shift+Enter breaks the line.
                 *
                 * The convention every assistant input uses, and worth stating
                 * because it is the opposite of a plain text area: the box is
                 * for one instruction, and the common case is sending it.
                 */
                Keys.onReturnPressed: function (event) {
                    if (event.modifiers & Qt.ShiftModifier) { event.accepted = false; return }
                    event.accepted = true
                    root.send()
                }
                Keys.onEnterPressed: function (event) {
                    if (event.modifiers & Qt.ShiftModifier) { event.accepted = false; return }
                    event.accepted = true
                    root.send()
                }

                Text {
                    anchors.fill: parent
                    textFormat: Text.PlainText
                    text: root.placeholder
                    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.35)
                    font: input.font
                    wrapMode: Text.Wrap
                    visible: input.text === ""
                }
            }

            // ── Controls ────────────────────────────────────────────────────

            Item {
                width: parent.width
                height: Math.max(attach.implicitHeight, send.implicitHeight)

                IconButton {
                    id: attach
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    visible: root.accepts
                    glyph: "+"
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onClicked: root.attachRequested()
                }

                // The model this will run against. A label rather than a
                // dropdown here: the page owns selection, and two places to
                // change the model is two places to get it wrong.
                Text {
                    id: trailing
                    anchors.right: send.left
                    anchors.rightMargin: Style.space(10)
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: root.trailing
                    color: trailingHover.hovered ? root.accent : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideLeft
                    width: Math.min(implicitWidth, parent.width - attach.width - send.width - Style.space(40))

                    HoverHandler { id: trailingHover; cursorShape: Qt.PointingHandCursor }
                    TapHandler { onTapped: root.trailingActivated() }
                }

                IconButton {
                    id: send
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    // A filled arrow when there is something to send, so the
                    // box says whether pressing Enter will do anything.
                    glyph: root.busy ? "…" : "↑"
                    foreground: root.sendable ? root.foreground : root.dim
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onClicked: root.send()
                }
            }
        }
    }

    /** Named so both Enter and the button reach the same guard. */
    function send() {
        if (!sendable) return
        submitted(input.text.trim())
    }
}
