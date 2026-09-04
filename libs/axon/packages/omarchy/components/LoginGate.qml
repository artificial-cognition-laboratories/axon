import QtQuick
import Quickshell
import qs.Commons

/**
 * What someone sees on the agent side before they have an account.
 *
 * ── Why the wall is here and nowhere else ───────────────────────────────────
 *
 * Local models need no account and must never ask for one — someone can
 * install this, download a weight and run it having signed nothing. That is
 * the whole funnel, and a login wall in front of it would throw away the one
 * thing that makes the plugin worth installing.
 *
 * Agents are different. A project is owned by a profile, `axon <ref> -a`
 * refuses without one, and every verb on the fleet page depends on it. So the
 * wall sits at the first thing that genuinely needs an identity, which is
 * exactly one section of one window.
 *
 * ── Why it launches the CLI ─────────────────────────────────────────────────
 *
 * `axon login` is a device flow that already exists, already writes the
 * credential to the right store, and now opens the browser itself. A second
 * implementation in QML would be a second thing to keep correct about tokens.
 */
Item {
    id: root

    /** Absolute path to the CLI, so the terminal does not have to find it. */
    property string axonPath: ""

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property color background: Color.menu.background
    property string fontFamily: Style.font.menuFamily

    readonly property color dim: Qt.darker(foreground, 1.55)

    Rectangle {
        anchors.fill: parent
        color: root.background
    }

    // Nothing behind this is usable without an account.
    MouseArea { anchors.fill: parent }

    Column {
        anchors.centerIn: parent
        width: Math.min(Style.space(420), root.width - Style.space(48) * 2)
        spacing: Style.space(10)

        Text {
            width: parent.width
            textFormat: Text.PlainText
            text: "Sign in to use agents."
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
        }

        Text {
            width: parent.width
            textFormat: Text.PlainText
            text: "An agent belongs to an account — it is where your projects, "
                + "modules and published work live. Local models need none of "
                + "that and keep working either way."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
        }

        Item { width: 1; height: Style.space(2) }

        Text {
            id: action
            textFormat: Text.PlainText
            text: "Sign in  ›"
            color: hover.hovered ? root.accent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true

            HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
            TapHandler {
                /*
                 * A terminal, not a silent background call.
                 *
                 * The device flow shows a code that has to match what the
                 * browser asks for, and it can fail in ways worth reading. The
                 * window is where both of those live; hiding it would mean
                 * inventing a place to show them.
                 */
                onTapped: Quickshell.execDetached([
                    "omarchy-launch-tui", "--app-id=org.omarchy.axon",
                    "bash", "-lc",
                    'export PATH="$HOME/.bun/bin:$HOME/.cache/.bun/bin:$HOME/.local/bin:$PATH"; '
                        + JSON.stringify(root.axonPath !== "" ? root.axonPath : "axon")
                        + " login; echo; "
                        + 'read -rsn1 -p "press any key to close"',
                ])
            }
        }

        Text {
            width: parent.width
            textFormat: Text.PlainText
            text: "A browser opens; approve the code and come back."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
        }
    }
}
