import QtQuick
import qs.Commons
import qs.Ui

import "../../../components"
import "../../../src/format.js" as Format

/**
 * Overview — the fleet, then the machine carrying it.
 *
 * Three tiles open it, one per domain the daemon owns: agents, models,
 * machine. That is not a dashboard of everything measurable — it is axond's
 * own shape, which is why there are exactly three and why a fourth needs a
 * reason.
 *
 * Below them, the four resources as area charts. The fill height is the share
 * of capacity in use and the shape is the trend, so one mark answers both
 * questions at panel width.
 */
Column {
    id: root

    property var machine: null
    property color foreground: Color.foreground
    property color accent: "#0094d2"
    property string fontFamily: Style.font.family

    spacing: Style.space(14)

    /** Whether readings are still arriving, so the charts may advance their axis. */
    readonly property bool live: !!machine && machine.health === "connected"

    /** Hover-box formatters. Bytes and percentages are not interchangeable. */
    readonly property var asBytes: function(v) { return Format.bytes(v) }
    readonly property var asPercent: function(v) { return Format.percent(v) }

    readonly property var capacity: machine ? machine.capacity : null
    readonly property var samples: machine ? machine.samples : []

    /** Pull one field out of the sample ring as a plain series. */
    function series(field) {
        var out = []
        if (!samples) return out
        for (var i = 0; i < samples.length; i++) out.push(samples[i][field])
        return out
    }

    /** When each reading was taken. The charts place points by time, not index. */
    readonly property var times: series("at")

    /** RAM is reported as available; the chart wants used. */
    function ramUsed() {
        var out = []
        if (!samples || !capacity) return out
        for (var i = 0; i < samples.length; i++) out.push(capacity.ram - samples[i].ramAvailable)
        return out
    }

    // ── Fleet ───────────────────────────────────────────────────────────────

    Row {
        width: parent.width
        visible: !!root.machine && root.machine.hasData

        StatTile {
            width: parent.width / 3
            value: root.machine ? String(root.machine.agentCount) : "—"
            label: "AGENTS"
            sub: root.machine
                ? (root.machine.agentCount + " total")
                : ""
            emphasised: !!root.machine && root.machine.agentCount > 0
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
        }

        StatTile {
            width: parent.width / 3
            value: root.machine ? String(root.machine.holds.length) : "—"
            label: "MODELS"
            sub: root.machine ? (root.machine.cached.length + " cached") : ""
            emphasised: !!root.machine && root.machine.holds.length > 0
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
        }

        StatTile {
            width: parent.width / 3
            value: root.machine ? Format.bytes(root.machine.held) : "—"
            label: "HELD"
            sub: root.capacity ? ("of " + Format.bytes(root.capacity.vram)) : ""
            foreground: root.foreground
            accent: root.accent
            fontFamily: root.fontFamily
        }
    }

    // ── Resources ───────────────────────────────────────────────────────────

    Column {
        width: parent.width
        spacing: Style.space(10)
        // Air above the heading, not between the tiles and it. A section label
        // belongs to what follows it, so the gap that separates the groups has
        // to sit above the label rather than below.
        topPadding: Style.space(8)

        PanelSectionHeader {
            text: "RESOURCES"
            foreground: root.foreground
            fontFamily: root.fontFamily
        }

        // No install prompt here: the panel header owns that state now, and
        // this page is not mounted while it shows.
        EmptyState {
            width: parent.width
            visible: !root.machine || !root.machine.hasData
            foreground: root.foreground
            text: root.machine ? root.machine.detail : ""
        }

        Column {
            width: parent.width
            spacing: Style.space(12)
            visible: !!root.machine && root.machine.hasData

            ResourceRow {
                label: "GPU"
                format: root.asPercent
                live: root.live
                reading: root.machine && root.machine.usage ? Format.percent(root.machine.usage.gpuUtil) : "—"
                unavailable: root.machine && root.machine.usage && root.machine.usage.gpuUtil !== null ? "" : "No GPU reading"
                values: root.series("gpuUtil")
                times: root.times
                max: 100
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
            }

            // The row this plugin exists for: the machine's total use, with
            // Axon's own share drawn inside it.
            ResourceRow {
                label: "VRAM"
                format: root.asBytes
                live: root.live
                reading: root.machine && root.machine.usage && root.capacity
                    ? Format.ratio(root.machine.usage.vramUsed, root.capacity.vram)
                    : "—"
                unavailable: root.capacity && root.capacity.vram ? "" : "Video memory unreadable"
                values: root.series("vramUsed")
                times: root.times
                // The MEASURED share, not `held`. `held` is what admission
                // reserved; this is what the driver actually handed our
                // processes, and the two legitimately disagree.
                share: root.machine ? root.machine.axonSeries("vram") : []
                max: root.capacity ? root.capacity.vram : null
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
            }

            ResourceRow {
                label: "RAM"
                format: root.asBytes
                live: root.live
                reading: root.machine && root.machine.usage && root.capacity
                    ? Format.ratio(root.capacity.ram - root.machine.usage.ramAvailable, root.capacity.ram)
                    : "—"
                values: root.ramUsed()
                share: root.machine ? root.machine.axonSeries("ram") : []
                times: root.times
                max: root.capacity ? root.capacity.ram : null
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
            }

            ResourceRow {
                label: "CPU"
                format: root.asPercent
                live: root.live
                reading: root.machine && root.machine.usage ? Format.percent(root.machine.usage.cpuUtil) : "—"
                unavailable: root.machine && root.machine.usage && root.machine.usage.cpuUtil !== undefined
                    && root.machine.usage.cpuUtil !== null ? "" : "Not measured yet"
                values: root.series("cpuUtil")
                share: root.machine ? root.machine.axonSeries("cpuUtil") : []
                times: root.times
                max: 100
                foreground: root.foreground
                accent: root.accent
                fontFamily: root.fontFamily
            }
        }
    }
}
