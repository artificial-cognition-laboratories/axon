import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui

import "../../components"
import "../../src"
import "pages"

/**
 * Axon in the bar: one icon, one panel.
 *
 * The panel answers one question — what is Axon doing to this machine right
 * now — so it is laid out as one machine with many tenants, not as one agent
 * at a time. That is why it is not a second copy of the usage widget: those
 * describe a subscription, this describes a box.
 *
 * ── Structure ───────────────────────────────────────────────────────────────
 *
 *   [hero: mark + machine identity]
 *   [tab row]
 *   [active tab]
 *
 * The chrome lives here and nothing else does. Each tab is its own file, so
 * this one stays short enough to read in a sitting however many tabs arrive —
 * Registry is the obvious fourth, and adding it is a file plus one row in
 * `tabs`.
 */
Panel {
    id: root
    moduleName: "arclabs.axon"
    ipcTarget: "arclabs.axon"

    readonly property color foreground: bar ? bar.foreground : Color.foreground
    readonly property color dim: Qt.darker(foreground, 1.55)
    readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

    /** Axon's primary cyan. The mark wears it inside the panel; the bar glyph follows the bar. */
    readonly property color brand: "#0094d2"

    /** Feed the views synthetic data. For building components before the transport lands. */
    readonly property bool mockData: String(root.setting("mockData", "false")) === "true"

    /** Development override for what produces the state stream. Empty uses the installed CLI. */
    readonly property string watchCommand: String(root.setting("watchCommand", ""))

    /** Development override for what runs daemon verbs. Empty uses the installed CLI. */
    readonly property string commandPrefix: String(root.setting("commandPrefix", ""))

    /** Show the icon when the daemon has something to report, or when asked to always show. */
    readonly property bool showAlways: String(root.setting("showWhenIdle", "false")) === "true"

    /** Force the install offer, to review the one flow an installed machine cannot reach. */
    readonly property bool simulateMissing: String(root.setting("simulateMissing", "false")) === "true"

    /** Where the install script comes from. Empty uses production. */
    readonly property string installerSource: String(root.setting("installerSource", ""))

    /**
     * A floor for the panel, so tabs do not resize the dropdown as you move
     * between them. Set to roughly the Overview's natural height, which is the
     * tallest tab and the one the layout was designed against — an empty
     * Agents tab then reads as a panel with room in it rather than a stub.
     *
     * Not a literal 3:1 against the 380 width, which would be ~1140px and
     * taller than most of the screen. One number, change it here.
     */
    readonly property real minContentHeight: Style.space(440)

    readonly property var tabs: [
        { value: "overview", label: "Overview" },
        { value: "models", label: "Models" },
        { value: "agents", label: "Agents" },
    ]
    property string tab: "overview"

    /*
     * Nothing to report, nothing in the bar — with one deliberate exception.
     *
     * `Bar.qml` collapses a slot whose item is invisible, so a machine where
     * the daemon is merely down draws no icon rather than a dead one, which is
     * the contract omarchy.agents keeps and the reason that widget can ship
     * enabled by default.
     *
     * "Axon is not installed" is different. Somebody chose to install THIS
     * plugin; hiding from them would mean the only thing they ever see of it
     * is nothing at all. So the icon shows, and the panel behind it explains
     * what Axon is and offers to install it. That state is the way in, not a
     * missing dependency.
     */
    visible: showAlways
        || (!!daemon && daemon.hasData)
        || (!!daemon && daemon.health === "missing")
    implicitWidth: button.implicitWidth
    implicitHeight: button.implicitHeight

    /**
     * The shared daemon link, owned by this plugin's service.
     *
     * Not a `Machine` of its own: the browser is a separate entry point and
     * would otherwise run a second transport over the same daemon. The service
     * is mounted at shell startup and both views read it.
     *
     * `ensureService` creates it on first ask, which matters when the shell
     * has not mounted services yet; `serviceFor` is the plain lookup and the
     * fallback for a shell that predates it.
     */
    readonly property var service: bar && bar.shell
        ? (typeof bar.shell.ensureService === "function"
            ? bar.shell.ensureService("arclabs.axon")
            : bar.shell.serviceFor("arclabs.axon"))
        : null

    readonly property var daemon: service ? service.machine : null

    /** Axon is not on this machine. The one state that replaces the panel. */
    readonly property bool missing: !!daemon && daemon.health === "missing"

    // Settings are handed to bar widgets and to nothing else, so this is the
    // only place that can tell the service whether to mock.
    function pushSettings() {
        if (!service) return
        service.mock = root.mockData
        service.watchOverride = root.watchCommand
        service.commandOverride = root.commandPrefix
        service.pretendMissing = root.simulateMissing
        service.installerSource = root.installerSource
    }
    onInstallerSourceChanged: pushSettings()
    onSimulateMissingChanged: pushSettings()
    onMockDataChanged: pushSettings()
    onWatchCommandChanged: pushSettings()
    onCommandPrefixChanged: pushSettings()
    onServiceChanged: pushSettings()
    Component.onCompleted: pushSettings()


    // Two marks, two sizes. The bar glyph sits at the icon FONT size rather
    // than the icon canvas: the canvas is the box a glyph is drawn inside, and
    // matching it makes a stroked shape read a size larger than every Nerd
    // Font neighbour.
    /*
     * The bar mark is IDENTITY, and identity does not flicker.
     *
     * It briefly turned red with a pulsing dot while the microphone was open.
     * That was wrong twice: the pill on screen is already the recording
     * indicator, so this was a second signal for one state — and a logo that
     * changes colour reads as an ALERT, which "we are listening, as you asked"
     * is not. The dot also pushed the glyph visibly off-centre against its
     * neighbours, because it added weight the layout did not account for.
     *
     * So it stays exactly what every other bar icon is: one glyph, one colour,
     * centred.
     */
    Component {
        id: barMark
        Chevron {
            color: root.foreground
            size: Style.bar.iconFont
        }
    }

    // The hero mark carries the daemon's state as a badge over its lower
    // chevron. Positioned by fraction rather than anchored to the edge: the
    // glyph's ink stops well short of its box, so a dot at the box corner
    // would float beside the mark instead of sitting on it.
    Component {
        id: heroMark
        Item {
            implicitWidth: mark.implicitWidth + Style.space(3)
            implicitHeight: mark.implicitHeight

            Chevron {
                id: mark
                color: root.brand
                size: Style.font.displayLarge
                weight: 0.135
            }

            StatusDot {
                health: root.daemon ? root.daemon.health : "offline"
                x: mark.width * 0.84 - width / 2
                y: mark.height * 0.80 - height / 2
            }
        }
    }

    BarIconButton {
        id: button
        anchors.fill: parent
        bar: root.bar
        iconComponent: barMark
        onPressed: root.toggle()
    }

    KeyboardPanel {
        id: panel
        anchorItem: button
        owner: root
        bar: root.bar
        open: root.opened
        focusTarget: keyCatcher
        contentWidth: panel.fittedContentWidth(Style.space(380))
        contentHeight: panel.fittedContentHeight(Math.max(column.implicitHeight, root.minContentHeight),
                                                 Style.space(640))

        PanelKeyCatcher {
            id: keyCatcher
            anchors.fill: parent

            onCloseRequested: root.close()
            onActivateRequested: if (root.daemon) root.daemon.refresh()
            onMoveRequested: function (dx, dy) {
                if (dx !== 0) root.step(dx)
                if (dy !== 0)
                    panelFlick.contentY = Math.max(0, Math.min(panelFlick.contentY + dy * Style.space(56),
                                                               Math.max(0, panelFlick.contentHeight - panelFlick.height)))
            }
            onTabRequested: function (direction) { root.switchPanel(direction) }
            onTextKey: function (t) { if (t === "r" || t === "R" ) if (root.daemon) root.daemon.refresh() }

            Flickable {
                id: panelFlick
                anchors.fill: parent
                contentWidth: width
                contentHeight: column.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                flickableDirection: Flickable.VerticalFlick
                interactive: contentHeight > height
                ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

                Column {
                    id: column
                    width: panelFlick.width
                    spacing: Style.space(12)

                    PanelHero {
                        width: parent.width
                        iconComponent: heroMark
                        title: "Axon Fleet"
                        meta: root.daemon && root.daemon.hasData
                            ? (root.daemon.capacity && root.daemon.capacity.gpu ? root.daemon.capacity.gpu : "Local inference")
                            : (root.daemon ? root.daemon.detail : "Axon service unavailable")
                        foreground: root.foreground
                        fontFamily: root.fontFamily
                        // A floor, not a fixed height: the hero must not
                        // resize as the meta line changes length or the mark
                        // swaps, or the tab strip below it walks up and down.
                        height: Math.max(implicitHeight, Style.space(48))
                    }

                    /*
                     * The gate, directly under the hero.
                     *
                     * In the header rather than inside Overview because it is
                     * not one panel's empty state — it is the condition of the
                     * whole plugin, and it has to stay visible while an install
                     * runs whichever tab someone wanders onto. The tabs below
                     * stand down while it shows: three headings leading to
                     * three empty pages is noise stacked on the one thing the
                     * person is meant to read.
                     */
                    InstallPrompt {
                        width: parent.width
                        visible: root.missing
                        install: root.service ? root.service.install : null
                        foreground: root.foreground
                        accent: root.brand
                        fontFamily: root.fontFamily
                    }

                    TabStrip {
                        width: parent.width
                        visible: !root.missing
                        tabs: root.tabs
                        value: root.tab
                        foreground: root.foreground
                        accent: root.brand
                        fontFamily: root.fontFamily
                        onSelected: function (value) { root.tab = value }
                    }

                    // One tab is mounted at a time. A Loader rather than three
                    // hidden Columns: a tab that is not showing must not be
                    // polling, binding, or holding a socket open.
                    // A constant box, not the tab's own height. Letting each
                    // tab size the column made the scrollbar appear and vanish
                    // between them, and its width change reflowed every line
                    // above — so switching tabs nudged the strip and the hero.
                    // The floor matches the panel's own minimum, less the
                    // chrome above it.
                    Loader {
                        width: parent.width
                        visible: !root.missing
                        active: !root.missing
                        height: root.missing ? 0 : Math.max(item ? item.implicitHeight : 0,
                                         root.minContentHeight - Style.space(140))
                        sourceComponent: root.tab === "models" ? modelsTab
                                       : root.tab === "agents" ? agentsTab
                                       : overviewTab
                    }
                }
            }
        }
    }

    // The stream costs a poll for as long as it runs, so it is opened only
    // while the panel is actually showing something.
    onOpenedChanged: {
        if (!service) return
        if (opened) service.acquire()
        else service.release()
    }

    Component.onDestruction: if (service && opened) service.release()

    Component {
        id: overviewTab
        Overview { machine: root.daemon; foreground: root.foreground; accent: root.brand; fontFamily: root.fontFamily }
    }

    Component {
        id: modelsTab
        Models { machine: root.daemon; service: root.service; foreground: root.foreground; accent: root.brand; fontFamily: root.fontFamily }
    }

    Component {
        id: agentsTab
        Agents { machine: root.daemon; foreground: root.foreground; accent: root.brand; fontFamily: root.fontFamily }
    }

    /** Move one tab left or right, without wrapping past the ends. */
    function step(direction) {
        var index = 0
        for (var i = 0; i < tabs.length; i++)
            if (tabs[i].value === tab) index = i
        var next = Math.max(0, Math.min(tabs.length - 1, index + direction))
        tab = tabs[next].value
    }
}
