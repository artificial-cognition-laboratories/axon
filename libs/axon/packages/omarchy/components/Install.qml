import QtQuick
import Quickshell
import Quickshell.Io

/**
 * Getting Axon onto this machine, and knowing whether it worked.
 *
 * ── Why this is a leaf rather than a button's onTapped ──────────────────────
 *
 * The install is the plugin's funnel, and a funnel is a state machine: it is
 * offered, then running, then either present or failed, and every entry point
 * has to render the same one. Held here, `stage` is the single answer and the
 * three surfaces are viewers of it. Spread across the surfaces it would be
 * three copies that disagree the moment one of them is closed.
 *
 * ── Why the terminal, and why a status file ─────────────────────────────────
 *
 * The script runs in Omarchy's presentation terminal — themed, visible, the
 * same way `omarchy-default-agent` installs. Nothing about a bar widget
 * pulling in a CLI should happen behind the user's back, and the scrolling
 * output is most of why anyone trusts it.
 *
 * But a detached terminal gives us no exit code, and polling only for the
 * binary cannot tell "still going" from "failed ten seconds ago" — the panel
 * would sit on a spinner forever after a failure the user already watched
 * happen. So the wrapper records the script's exit status to a file and this
 * polls for it. The binary appearing is still the authority; the status file
 * exists to make failure loud instead of indefinite.
 *
 * The installer is downloaded to a file and run, rather than piped into bash,
 * for exactly one reason: `curl | bash` reports the exit status of bash and
 * loses curl's, so a network failure would be indistinguishable from a clean
 * install. Two steps, two honest codes.
 */
Item {
    id: root

    /** The daemon service. Its `recheck()` is what actually decides "installed". */
    property var service: null

    /**
     * Where the installer is fetched from. Empty uses production.
     *
     * An override because the install script and the panel that runs it ship
     * on different clocks: a fix to the script cannot be exercised here until
     * it is deployed, which makes the one flow we most need to rehearse the
     * one flow we cannot. Pointed at a `file://` path it runs the working copy.
     */
    property string source: ""

    readonly property string url: source !== "" ? source : "https://axon.arclabs.it/install"

    /**
     * What the user is shown and can copy.
     *
     * Built from `url`, not from the production address — a panel installing
     * from a working copy while printing the published one-liner would be
     * showing a command that is not the one it ran.
     */
    readonly property string command: "curl -fsSL " + root.url + " | bash"

    /** "idle" | "running" | "failed" | "done" */
    property string stage: "idle"

    /** Why it failed, in a sentence a person can act on. Empty otherwise. */
    property string detail: ""

    /** Seconds since the install started. Shown because indeterminate needs a clock. */
    property int elapsed: 0

    /**
     * When the script reported success, or -1 while it has not.
     *
     * A clean exit and a findable binary are different facts, and the gap
     * between them is a real failure with a specific cause: the installer put
     * `axon` somewhere this plugin does not look. Waiting out the full timeout
     * on that would report "did not finish" about an install that finished,
     * so it gets its own short fuse and its own sentence.
     */
    property int settledAt: -1

    /** How long after a clean exit we keep expecting the binary to show up. */
    readonly property int settleSeconds: 20

    /**
     * How long before an install that has said nothing is called failed.
     *
     * Generous: the script downloads Bun on a cold machine and a slow link
     * makes that minutes. This only fires when the status file never appears
     * at all, which in practice means the user closed the terminal.
     */
    readonly property int timeoutSeconds: 600

    readonly property string cacheDir: "$HOME/.cache/axon"
    readonly property string statusPath: cacheDir + "/install.status"

    /**
     * Codes the wrapper invents, above anything the installer itself returns.
     * 100 is ours; everything else came from the script.
     */
    readonly property int couldNotFetch: 100

    signal completed()

    /**
     * Launch the installer.
     *
     * Idempotent while running: a second tap on a button that already started
     * one must not open a second terminal racing the first.
     */
    function start() {
        if (stage === "running") return
        stage = "running"
        detail = ""
        elapsed = 0
        settledAt = -1
        Quickshell.execDetached([
            "omarchy-launch-floating-terminal-with-presentation",
            wrapper,
        ])
        poll.start()
    }

    /** Back to the offer, so the surface shows the button again. */
    function reset() {
        poll.stop()
        stage = "idle"
        detail = ""
        elapsed = 0
        settledAt = -1
    }

    /*
     * One line, because the presentation terminal takes a command string and
     * not a script. POSIX only — we cannot know which shell it runs under, so
     * nothing here relies on bash (the installer itself is invoked WITH bash,
     * which is a different thing and is what its shebang asks for).
     */
    readonly property string wrapper:
        'mkdir -p ' + cacheDir + '; rm -f ' + statusPath + '; '
        + 'if curl -fsSL ' + url + ' -o ' + cacheDir + '/install.sh; then '
        + 'bash ' + cacheDir + '/install.sh; echo $? > ' + statusPath + '; '
        + 'else echo ' + couldNotFetch + ' > ' + statusPath + '; fi'

    /**
     * Has it landed yet.
     *
     * Two questions per tick, and their order is the whole logic: the binary
     * being present wins over any status the script left behind, because a
     * machine with a working `axon` on it is installed whatever the script
     * thought of itself.
     */
    Timer {
        id: poll
        interval: 1500
        repeat: true
        onTriggered: {
            root.elapsed += Math.round(interval / 1000)
            if (root.service) root.service.recheck()
            if (!status.running) status.running = true
            if (root.settledAt >= 0 && root.elapsed - root.settledAt >= root.settleSeconds) {
                root.fail("Axon installed, but no `axon` command could be found. "
                    + "Open a new terminal and check that it is on your PATH.")
                return
            }
            if (root.elapsed >= root.timeoutSeconds) root.fail(
                "The installer did not finish. If you closed the terminal, run it again.")
        }
    }

    Process {
        id: status
        command: ["sh", "-c", "cat " + root.statusPath + " 2>/dev/null"]
        running: false
        stdout: StdioCollector {
            waitForEnd: true
            onStreamFinished: {
                // Last line: this process re-runs every tick, and a collector
                // that carried text over would parse two codes as one.
                var lines = String(text).trim().split("\n")
                var code = parseInt(lines[lines.length - 1].trim(), 10)
                if (isNaN(code) || root.stage !== "running") return
                if (code === 0) {
                    // Not "done" — the probe decides that. Only that the
                    // script has stopped claiming to be working.
                    if (root.settledAt < 0) root.settledAt = root.elapsed
                    // A review run asked to be shown this flow; the script has
                    // now really run, so the rest of it should be the truth.
                    if (root.service) root.service.stopPretending()
                    return
                }
                root.fail(root.explain(code))
            }
        }
    }

    /** Turn an exit status into something worth reading. */
    function explain(code) {
        if (code === root.couldNotFetch)
            return "Could not download the installer. Check the network and try again."
        return "The installer stopped with code " + code + ". Its output is in the terminal."
    }

    function fail(reason) {
        poll.stop()
        stage = "failed"
        detail = reason
    }

    /*
     * The service is the authority on whether Axon is here, so the transition
     * to done is driven by its answer rather than by anything this measured.
     * That also means an install someone ran in their own terminal, with this
     * panel open and never touched, resolves the same way.
     */
    Connections {
        target: root.service
        function onInstalledChanged() {
            if (root.service && root.service.installed === true && root.stage !== "done") {
                poll.stop()
                root.stage = "done"
                root.detail = ""
                root.completed()
            }
        }
    }

    Component.onDestruction: poll.stop()
}
