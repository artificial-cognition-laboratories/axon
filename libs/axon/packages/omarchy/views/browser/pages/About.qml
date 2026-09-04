import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons

import "../../../components"

Flickable {
    id: root

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily
    readonly property color dim: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.52)

    contentWidth: width
    contentHeight: page.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    interactive: contentHeight > height
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    function open(url) { Quickshell.execDetached(["xdg-open", url]) }

    Column {
        id: page
        width: Math.min(parent.width, Style.space(575))
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: Style.space(12)
        bottomPadding: Style.space(18)

        /*
         * A link OUT, said plainly.
         *
         * This was an "ABOUT AXON" heading with an unlabelled external-link
         * icon beside it. The heading restated the page it was on, and the
         * icon gave no clue it left the application — so the one genuinely
         * useful thing here read as decoration.
         *
         * "Docs →" is the whole header now. The arrow is what says it leaves;
         * a word plus an arrow needs no explaining, where an icon alone does.
         */
        Item {
            width: parent.width
            height: Style.space(30)

            Text {
                id: docsLink
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: "Docs \u2192"
                color: docsHover.hovered ? Qt.lighter(root.accent, 1.25) : root.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption

                HoverHandler { id: docsHover; cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: root.open("https://axon.arclabs.it/docs/v2") }
            }
        }

        Rectangle {
            width: parent.width
            height: 1
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.14)
        }

        MarkdownView {
            width: parent.width
            source: "# Axon on this machine\n\n"
                + "This plugin is the desktop view of **axond**, Axon's local runtime. It lets you discover models, download weights, see what is loaded, and understand the GPU and memory those models hold\u2014without leaving Omarchy.\n\n"
                + "axond is the part doing that work. It keeps the local catalogue and model cache, measures the machine, admits models within the memory budget, and exposes the state this panel reads. The UI is a view over that runtime, not a second model manager.\n\n"
                + "[How the local runtime works](https://axon.arclabs.it/docs/v2/concepts/managed-runtime) \u00B7 [Explore the CLI](https://axon.arclabs.it/docs/v2/cli)\n\n"
                + "## Continue in the terminal\n\n"
                + "![Axon terminal](../assets/axon-tui.png)\n\n"
                + "The **Axon TUI** is where the wider system starts: a working agent in the terminal you already use. Conversations, model selection, modules, commands, and status all share one keyboard-driven palette system, so learning one surface carries across the rest.\n\n"
                + "[See the terminal](https://axon.arclabs.it/docs/v2/tui) \u00B7 [Install Axon](https://axon.arclabs.it/docs/v2/getting-started/installation)\n\n"
                + "## Make the terminal yours\n\n"
                + "Themes, commands, keybinds, and status lines are **terminal extensions**. Install one and it is live immediately. Write one in TypeScript and it appears beside the built-ins\u2014no restart and no hand-edited configuration.\n\n"
                + "[Build terminal extensions](https://axon.arclabs.it/docs/v2/tui/api/tui) \u00B7 [Browse modules](https://axon.arclabs.it/docs/v2/modules/overview)\n\n"
                + "## Build and run your own agent\n\n"
                + "![Axon CLI](../assets/axon-cli.png)\n\n"
                + "The CLI and development server turn an agent into a normal project: prompts, tools, modules, policy, and source travel together. Run it locally while you build; add capabilities when the project needs them.\n\n"
                + "[Create your first agent](https://axon.arclabs.it/docs/v2/getting-started/first-agent) \u00B7 [Learn the development workflow](https://axon.arclabs.it/docs/v2/agent)\n\n"
                + "## Inspect the work\n\n"
                + "![Axon Fleet trace](../assets/axon-fleet.png)\n\n"
                + "**Axon Fleet** is the editor-side debugger for when an agent needs inspection: event logs, traces, engine calls, sessions, and the evidence behind each run. The same project moves from terminal to Fleet and onward to deployment without changing shape.\n\n"
                + "[Explore Axon Fleet](https://axon.arclabs.it/docs/v2/fleet/management)\n\n"
                + "---\n\n"
                + "You are already using Axon through this plugin. The documentation covers the runtime, terminal, extensions, agent projects, and deployment in depth.\n\n"
                + "[Open the full documentation](https://axon.arclabs.it/docs/v2) \u00B7 [Join the Discord](https://discord.gg/jkw5AgFXRw)"
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
            onLinkActivated: function(url) { root.open(url) }
        }
    }
}
