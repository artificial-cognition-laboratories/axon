import QtQuick
import Quickshell
import qs.Commons

import "../src/format.js" as Format

/**
 * What someone sees when Axon is not on this machine.
 *
 * ── This is the most important state in the plugin ──────────────────────────
 *
 * Every other surface here serves a person who already runs Axon. This one
 * serves the person who found the plugin in the registry, installed it, and
 * has no idea what they just installed — which, if the plugin does its job as
 * a way in, is most people who ever see it. An invisible icon and an empty
 * panel would be the whole first impression.
 *
 * So it says what Axon is in one line and offers the install, rather than
 * reporting a missing dependency.
 *
 * ── The three states are one surface ────────────────────────────────────────
 *
 * Offered, running, failed. Rendering only the offer — and leaving the panel
 * on it while a terminal installs behind the user's back — is how someone ends
 * up tapping Install twice and watching two scripts race. The state lives in
 * `Install`; this draws whichever one it is in.
 *
 * The install itself runs in Omarchy's own presentation terminal — themed,
 * visible, with a done screen — which is what `omarchy-default-agent` and the
 * Voxtype invitation both use. Nothing is installed silently: a bar widget
 * that pulls in a CLI and a systemd unit unannounced is how a plugin loses
 * trust, and the one-click visible install costs the user nothing they would
 * not accept.
 */
Column {
    id: root

    /** The `Install` leaf off the service. Without it this can only offer. */
    property var install: null

    property color foreground: Color.foreground
    property color accent: "#0094d2"
    property string fontFamily: Style.font.family

    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property string installCommand:
        install ? install.command : "curl -fsSL https://axon.arclabs.it/install | bash"

    readonly property string stage: install ? install.stage : "idle"
    readonly property bool running: stage === "running"
    readonly property bool failed: stage === "failed"

    spacing: Style.space(10)

    // ── The pitch ───────────────────────────────────────────────────────────
    // Stays up while the install runs. Someone waiting on a download is the
    // most attentive reader this text will ever get.

    Text {
        width: parent.width
        textFormat: Text.PlainText
        text: "Axon runs agents and local models on this machine."
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.WordWrap
    }

    Text {
        width: parent.width
        textFormat: Text.PlainText
        text: "Browse Hugging Face and Ollama in one place, download and load weights, "
            + "and keep a video-memory budget so they never crowd out your desktop."
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
    }

    Item { width: 1; height: Style.space(2) }

    // ── Running ─────────────────────────────────────────────────────────────

    ProgressLine {
        width: parent.width
        visible: root.running
        label: "axon-cli"
        // Elapsed rather than a percentage. The script fetches Bun, upgrades
        // it, then installs the CLI, and none of those report a size we could
        // turn into a fraction — so the clock is the only number that is true.
        value: root.install ? Format.duration(root.install.elapsed) : ""
        detail: "Installing in the terminal window. You can close this panel."
        fraction: -1
        foreground: root.foreground
        accent: root.accent
        fontFamily: root.fontFamily
    }

    // ── Failed ──────────────────────────────────────────────────────────────

    Text {
        width: parent.width
        visible: root.failed
        textFormat: Text.PlainText
        text: root.install ? root.install.detail : ""
        color: "#e88"
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
    }

    // ── The action ──────────────────────────────────────────────────────────

    Row {
        spacing: Style.space(14)
        visible: !root.running

        Text {
            id: action
            textFormat: Text.PlainText
            text: root.failed ? "Try again  \u203a" : "Install Axon  \u203a"
            color: hover.hovered ? root.accent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true

            HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: if (root.install) root.install.start() }
        }

        /*
         * The copy is not a convenience, it is the escape hatch.
         *
         * Some people will never let a panel run a script for them, and an
         * install that only works by trusting a button excludes them. This is
         * also the entire recovery path when the launcher itself is missing —
         * `execDetached` on a terminal wrapper that is not there fails
         * silently, and the command is then the only way through.
         */
        Text {
            id: copy
            textFormat: Text.PlainText
            text: copied.running ? "Copied" : "Copy command"
            color: copied.running ? root.accent
                 : (copyHover.hovered ? root.accent : root.dim)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            // Centred against the taller sibling rather than anchored to its
            // baseline: `Row` positions its own children and refuses anchors,
            // so a baseline binding here is silently dropped.
            height: action.height
            verticalAlignment: Text.AlignVCenter

            HoverHandler { id: copyHover; cursorShape: Qt.PointingHandCursor }
            TapHandler {
                // `-n` because wl-copy appends a newline without it, and a
                // clipboard that submits itself the moment it is pasted is not
                // what anybody asked for.
                onTapped: {
                    Quickshell.execDetached(["wl-copy", "-n", "--", root.installCommand])
                    copied.restart()
                }
            }

            Timer { id: copied; interval: 1600; repeat: false }
        }
    }

    Text {
        width: parent.width
        visible: !root.running
        textFormat: Text.PlainText
        text: root.installCommand
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
    }
}
