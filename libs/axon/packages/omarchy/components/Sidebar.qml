import QtQuick
import qs.Commons

/**
 * The scope rail: what you are looking at, not where you are.
 *
 * A registry sidebar is a filter, not a navigation menu — the task here is
 * search, pick, act, and every one of those happens in the content pane. So
 * the rail narrows the search space and never changes the page.
 *
 * The machine footprint is pinned to its foot deliberately. "Local models that
 * do not eat your machine" is the whole claim, and a claim you have to open a
 * settings tab to verify is not being made.
 */
Item {
    id: root

    /**
     * [{ section }] or [{ value, label }] — a bare `section` renders as a heading.
     *
     * No counts. Hugging Face publishes no total and pages by opaque cursor, so
     * the only number available is how many rows happen to be loaded — which
     * beside a scope reads as "how many exist" and is wrong by four orders of
     * magnitude. A number that cannot be honest is worse than no number.
     */
    property var scopes: []

    /** Destinations above the scopes: [{ value, label }]. See the Repeater below. */
    property var leading: []

    /**
     * A row that takes a NAME rather than navigating: { value, placeholder }.
     *
     * Rendered inline where the entry would sit, because "make a new one"
     * belongs beside the things it will join. Dropping into a terminal to be
     * asked for a name was a context switch to answer one question the rail
     * had room for.
     */
    property var composer: null

    /** Emitted with what was typed. The owner decides what creating means. */
    signal composed(string text)

    /** True while the owner is still creating the last thing typed here. */
    property bool busy: false
    /** Why the last create failed, or "". Shown under the field. */
    property string trouble: ""

    property string value: ""

    property color foreground: Color.menu.text
    property color accent: "#0094d2"
    property string fontFamily: Style.font.menuFamily
    property bool focused: false

    signal selected(string value)

    readonly property color dim: Qt.darker(foreground, 1.55)

    /** Filled by the owner — the two lines under the rail. */
    property string footprintPrimary: ""
    property string footprintSecondary: ""

    /**
     * Destinations pinned to the foot, below the scopes: [{ value, label }].
     *
     * These are not scopes — they do not narrow the list, they replace the
     * pane — so they must not sit among things that do. At the foot,
     * separated, they read as the links every sidebar keeps down there, and
     * the rail keeps meaning exactly one thing above them.
     *
     * A list rather than one entry because there are now two, and a second
     * `pinnedTwoValue` property would have been the first step of a ladder.
     */
    property var pinned: []

    Column {
        id: list
        width: parent.width
        spacing: Style.space(1)

        /**
         * Destinations pinned ABOVE the scopes: [{ value, label }].
         *
         * The counterpart of `pinned`, and it exists for one entry — the
         * machine itself. Putting it among the scopes would have made "what is
         * on this box" look like another way to narrow a registry search, and
         * putting it at the foot would have buried the page most visits start
         * from. It is the first thing in the rail because it is the first
         * question: what do I already have.
         */
        Repeater {
            model: root.leading

            Item {
                required property var modelData
                width: list.width
                height: Style.space(26)

                readonly property bool active: root.value === String(modelData.value)

                Rectangle {
                    anchors.fill: parent
                    radius: Style.cornerRadius
                    color: parent.active
                        ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.16)
                        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
                    visible: parent.active || leadHover.hovered
                }

                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: Style.space(10)
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: String(parent.modelData.label)
                    color: parent.active ? root.accent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                }

                HoverHandler { id: leadHover; cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: root.selected(String(parent.modelData.value)) }
            }
        }

        // A break, because what is above is not part of what is below. The
        // group headings already carry their own lead-in; this separates a
        // destination from the filters that follow it.
        Item {
            width: 1
            height: root.leading.length > 0 ? Style.space(14) : 0
        }

        Repeater {
            model: root.scopes

            Loader {
                required property var modelData
                required property int index
                width: list.width
                sourceComponent: modelData.section !== undefined ? headingRow : scopeRow

                Component {
                    id: headingRow
                    Item {
                        width: list.width
                        // Taller than a row so a group reads as a break rather
                        // than another entry. The first heading keeps its own
                        // smaller lead-in, since nothing sits above it.
                        height: index === 0 ? Style.space(26) : Style.space(40)
                        Text {
                            anchors.left: parent.left
                            anchors.leftMargin: Style.space(10)
                            anchors.bottom: parent.bottom
                            anchors.bottomMargin: Style.space(6)
                            textFormat: Text.PlainText
                            text: String(modelData.section)
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            font.bold: true
                        }
                    }
                }

                Component {
                    id: scopeRow
                    Item {
                        width: list.width
                        height: Style.space(26)

                        readonly property bool active: root.value === String(modelData.value)

                        Rectangle {
                            anchors.fill: parent
                            radius: Style.cornerRadius
                            color: parent.active
                                ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.16)
                                : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
                            visible: parent.active || hover.hovered
                        }

                        Text {
                            anchors.left: parent.left
                            anchors.leftMargin: Style.space(10)
                            anchors.verticalCenter: parent.verticalCenter
                            textFormat: Text.PlainText
                            text: String(modelData.label)
                            color: parent.active ? root.accent : root.foreground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.body
                        }

                        HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
                        TapHandler { onTapped: root.selected(String(modelData.value)) }
                    }
                }
            }
        }

        /*
         * The composer sits at the foot of the scopes it will add to.
         *
         * A TextInput that only exists while it is being used: an always-open
         * field in a navigation rail reads as a search box, which is a
         * different promise and one this cannot keep.
         */
        Item {
            width: list.width
            height: root.composer ? Style.space(26) : 0
            visible: !!root.composer

            Rectangle {
                anchors.fill: parent
                radius: Style.cornerRadius
                color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
                visible: composeHover.hovered || field.activeFocus
            }

            Text {
                id: prompt
                anchors.left: parent.left
                anchors.leftMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                // The one sign that a headless scaffold is running. Without a
                // terminal this row is the only place it can be reported.
                text: root.busy ? "\u00B7" : "+"
                color: field.activeFocus ? root.accent : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
            }

            TextInput {
                id: field
                anchors.left: prompt.right
                anchors.leftMargin: Style.space(8)
                anchors.right: parent.right
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                selectByMouse: true
                selectionColor: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.35)

                onAccepted: {
                    var name = text.trim()
                    if (name === "") return
                    text = ""
                    focus = false
                    root.composed(name)
                }

                // Escape leaves without creating anything, which is the only
                // way out a field like this needs.
                Keys.onEscapePressed: { text = ""; focus = false }

                Text {
                    anchors.fill: parent
                    verticalAlignment: Text.AlignVCenter
                    textFormat: Text.PlainText
                    text: root.busy
                        ? "creating\u2026"
                        : (root.composer ? String(root.composer.placeholder) : "")
                    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.4)
                    font: field.font
                    visible: field.text === "" && !field.activeFocus
                }
            }

            HoverHandler { id: composeHover; cursorShape: Qt.IBeamCursor }
            TapHandler { onTapped: field.forceActiveFocus() }
        }

        /*
         * Why the last create failed.
         *
         * Nothing else reports it now that scaffolding is headless — the
         * terminal that used to hold itself open for exactly this is gone, so
         * without this a refusal would be completely silent.
         */
        Text {
            width: list.width - Style.space(20)
            x: Style.space(10)
            visible: root.trouble !== ""
            textFormat: Text.PlainText
            text: root.trouble
            color: "#e05252"
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
        }
    }

    Column {
        id: pinnedList
        anchors.bottom: footprint.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottomMargin: Style.space(10)
        spacing: Style.space(1)

        Repeater {
            model: root.pinned

            Item {
                required property var modelData
                width: pinnedList.width
                height: Style.space(26)

                readonly property bool active: root.value === String(modelData.value)

                Rectangle {
                    anchors.fill: parent
                    radius: Style.cornerRadius
                    color: parent.active
                        ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.16)
                        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
                    visible: parent.active || pinnedHover.hovered
                }

                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: Style.space(10)
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: String(parent.modelData.label)
                    color: parent.active ? root.accent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                }

                HoverHandler { id: pinnedHover; cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: root.selected(String(parent.modelData.value)) }
            }
        }
    }

    Column {
        id: footprint
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.leftMargin: Style.space(10)
        anchors.rightMargin: Style.space(10)
        spacing: Style.space(2)

        Rectangle {
            width: parent.width
            height: 1
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
        }

        Item { width: 1; height: Style.space(6) }

        // Elided, because the rail is a fixed width and these lines carry
        // formatted sizes that grow with the machine.
        Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.footprintPrimary
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
        }

        Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.footprintSecondary
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
        }

        Item { width: 1; height: Style.space(10) }
    }
}
