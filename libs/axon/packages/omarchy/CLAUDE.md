# @arcforge/omarchy

## What This Is

Axon's surface on the Omarchy desktop — a Quickshell bar widget that answers
one question: *what is Axon doing to this machine right now.*

It is the third Axon client, beside the TUI and the Fleet editor extension,
and it is the only one that exists when no terminal and no editor are open.
That is its entire reason to exist: `axond` is a resident, supervised,
per-machine daemon, and a desktop is the first place that fact is visible to
someone who has not read the architecture.

Distributed as its own git repo (`omarchy plugin add <url>`), developed here.
The package root IS the plugin root, so the published repo is a mirror of this
directory and nothing has to be rearranged to ship it.

## The Design

**One machine with many tenants, never one agent at a time.** `omarchy.agents`
switches between subscriptions because a subscription is what it describes.
This describes a *box*: the resources are shared, the holders are several, and
the interesting number is which agent is holding what. A switcher here would
be a copy of the wrong idea.

**The panel is strictly a display.** Every figure comes from `axond`, which
already measures all of it. No collection, no derivation, no second source of
truth for anything the daemon owns. The QML is a renderer — that keeps the
surface small against an alpha plugin API, and it is where the boundary
belongs anyway.

**The daemon link is three states, not a boolean.** `Machine.health` is
"offline" | "starting" | "connected". A boolean cannot say "starting", and the
difference matters: a daemon mid-launch and a daemon that failed to launch look
identical to someone staring at a dot, and only one is worth acting on. systemd
already distinguishes them, so collapsing them here would discard something we
are handed. `StatusDot` renders it red / amber / green over the hero mark.

**Status colours are literals, and only status colours.** Everything else takes
its colour from `qs.Commons` so it follows the theme. Red, amber and green are
read as a traffic light before they are read as colours, and a theme that
tinted "offline" to something calm would be actively harmful. The theme has no
green or amber to borrow in any case — only `urgent`.

**Null is unreadable, never zero.** The daemon's `MachineUsage` type is
scrupulous about this — a machine with no GPU and a machine whose GPU cannot
be probed are different facts. The panel must not collapse them: it draws
"unreadable" and says why, rather than a meter at zero that reads as idle.

**Nothing to say means nothing in the bar.** `Bar.qml` collapses a slot whose
item is invisible, so a machine that has never run Axon draws no icon at all.
A dead Axon glyph in someone's bar is worse than no glyph — this is the same
contract `omarchy.agents` keeps, and it is why that widget can ship enabled by
default.

**Themed through `qs.Commons`, never hardcoded.** Every colour comes from
`Color.*` and every metric from `Style.*`. A plugin that hardcodes anything
stops following the user's theme, which is the single clearest tell that
something was bolted on.

**Chrome in `Panel.qml`, content in a tab file.** The panel is a hero, a tab
row, and one mounted tab:

```
[hero: mark + machine identity]
[tab row]
[active tab]
```

Each tab is its own file and only the active one is mounted — a Loader, not
three hidden Columns, because a tab that is not showing must not be polling or
holding a socket open. Adding Registry is a file plus one row in `tabs`. This
is what keeps `Panel.qml` readable as the view grows, which it will.

**The tab strip is `TabStrip`, deliberately not `ButtonGroup`.** That component
draws a segmented control — bordered, filled, chunky — which is right for
picking a value and wrong for navigating a view. `TabStrip` is inline labels
between two full-width rules with the active one underlined in brand cyan, the
same strip the Axon Console uses in the editor, so the two surfaces read as one
product. It is named TabStrip because `QtQuick.Controls` exports a `TabBar` and
`Panel.qml` imports that module for `ScrollBar`; the shorter name silently
resolves to theirs.

**Two marks, two sizes.** The bar glyph sits at `Style.bar.iconFont`, not
`iconCanvas`: the canvas is the box a glyph is drawn inside, and matching it
makes a stroked shape read a size larger than every Nerd Font neighbour. The
hero mark is `displayLarge` and wears the brand cyan; the bar glyph follows the
bar foreground so it sits level with its neighbours.

**This is NOT** a runtime, a chat client, or a place logic lives. The v1 line
is: local model management, the fleet, dictation, and a handoff to the terminal
for everything else. HTTP model serving, OS-level agent policy and live
streaming dictation are named and deferred — see the strategy note in
Known Debt.

## Key Interfaces

```
manifest.json          id, three kinds, entry points, settings
views/
  bar/                   the quick view: what Axon holds on this machine
    Bar.qml              bar-widget entry point — glyph, hero, tab strip
    pages/               Overview · Loaded · Agents
  browser/               the summoned overlay: find and install models
    Browser.qml          overlay entry point — rail, header, content
    pages/               Discover · Detail · Server · Fleet · Agent · Settings · About
components/            the shared vocabulary every view is written in
  Chevron · StatusDot · TabStrip · Sidebar · SearchField
  Sparkline · ResourceRow · StatTile · ModelRow · TreeRow · ListRow
  EmptyState · InstallPrompt
src/
  Service.qml            service entry point — the one daemon link
  Machine.qml            the state every view binds to
  format.js · tree.js    formatting, and flattening a tree into rows
  dev-watch.ts           the stream, from a source checkout
  dev-cli.ts             the command verbs, from a source checkout
assets/ · system/ · bin/install
```

**One service, two surfaces.** The bar widget and the browser are separate
entry points that cannot see each other, so each owning a transport meant two
streams over one daemon and a browser that could not read plugin settings.
`src/Service.qml` is the single link. A bar widget looks it up through
`bar.shell.ensureService`; an overlay is HANDED it — `shell.qml` assigns
`service` to any panel whose plugin declares one, which means that property
must be writable and named exactly that. A `readonly` version makes the
assignment throw and the surface loads with no daemon at all.

**Settings only reach bar widgets.** Nothing hands them to a service or an
overlay, so `Bar.qml` reads them and pushes them to the service, and the
browser reads them from there. That is why `mockData`, `watchCommand` and
`commandPrefix` all live on the bar widget's schema.

**Reads stream, writes fire.** State arrives on `axon daemon watch --json`,
one JSON object per tick through `Process` + `SplitParser`. Mutations run
`axon daemon <verb> --json` and apply nothing optimistically — the daemon is
the authority on what is cached and what is held, and a panel drawing the
result it hoped for would be wrong for exactly the two seconds that matter.

**The service is the cache, because the cost is the process.** A panel felt
slow at about half a second per open, and none of it was the catalogue: the
daemon answers a warm query in ~1ms. It was 59ms of `bash -ic` sourcing rc
files, 375ms of bun transpiling source (development only — a built binary pays
none of it), and 21ms constructing the daemon, all paid before anything could
be drawn. So the binary is resolved ONCE at service start and every call execs
it with no shell, results are held in memory keyed by query, and the empty
query is prefetched before anyone opens anything. An open renders from memory
and refreshes behind itself.

**Typing filters locally; the network only widens the pool.** The list binds to
a filter over rows already in hand, so it narrows on every character. The remote
search runs behind it and replaces the pool when it lands. Binding the list to
the REPLY was what read as a one-second debounce — reaching the daemon costs a
process, and nothing a keystroke does should wait on one.

**Views bind to `hasData`, never to `connected`.** A reconnecting stream still
holds the last reading. Gating a populated panel on the link blanked it for the
few hundred milliseconds the transport took to reattach, which made every
reopen look like a cold start. The dot reports the link; the panel reports the
machine. The stream also lingers 30 seconds after the last surface closes, so
flicking between the dropdown and the browser never reattaches at all.

**Finding the CLI must not use a login shell.** `bash -ic command -v axon`
measures 59ms in isolation and **1.5 seconds at shell startup**, with every
other plugin loading at once — and the whole plugin was serialised behind it.
Known install locations are tested directly with `sh`, which sources nothing;
the interactive shell survives only as a last resort, off the path that decides
whether the first open feels instant.

**The stream is reference counted.** A running watch holds the daemon at its
two-second cadence, which costs an `nvidia-smi` every two seconds. Surfaces
`acquire()` on open and `release()` on close; a 15s status poll answers
liveness the rest of the time.

**The browser's rail is scope, not navigation.** It keeps the same frame as
Axon's other two registry surfaces — rail, header, scrolling pane — so the
three read as one product. What differs is what the rail holds. The task here
is search, pick, act, and all three happen in the content pane, so nothing in
the rail ever changes the page; it narrows the search space and pins the
machine's footprint to its foot.

**Search is the header, not a rail entry.** It is what ninety percent of a
visit consists of, and a primary action you have to navigate to is not primary.
Arrow keys drive the list from inside the search field so typing never has to
stop.

**Detail overlays the content pane alone.** Rail and header stay put. On a
keyboard surface a frame that moves is a frame you have to re-find, and losing
the result list every time you inspect a model makes comparison impossible.

**Two laws decide what goes in this panel.** They were written after an
"Interact" chat page was built and cut:

> The panel shows state. The terminal does work. Every verb meaning "use" opens
> a terminal.
>
> If a fact is only true while an agent is RUNNING, it belongs in the terminal.
> If it is true when nothing is running, it belongs here.

The first killed Interact — a panel that can chat removes every reason to open
a terminal, which is the one thing this surface exists to make people do. It
was not a weak page; it was a hole in the funnel.

The second is why `pages/Agent.qml` exists despite the first. A schedule fires
when no terminal is open, no editor is open, and possibly while the person is
asleep — the desktop is the only surface that can own it. That is also the
honest account of the overlap with the Fleet extension: Fleet is the AUTHORING
view (live, attached, beside the code), this is the OPERATIONS view
(persistent, machine-wide, about an agent you are not looking at). Same data,
different question.

**Handoffs live on the service, never on a row.** `openTerminal(ref)` and
`openEditor(path)` are the two verbs the whole product funnels through, and
both need the resolved CLI path plus a PATH export the compositor does not
provide. `AgentRow` built that command line itself until the detail header
needed the identical one — two copies of a subtle environment fix is how they
drift, so it moved to the thing that already knew where the binary was.

**A row's tap area excludes its verbs by GEOMETRY.** Handlers do not consume
events, so a tap on "stop" also reaches the row's own TapHandler — which would
open the detail page for the agent it just killed. `ModelRow` and `AgentRow`
both test the point against the actions Row rather than relying on ordering.

**Row states are read off the record, never a parallel flag.** `ModelRow` and
`Detail` both derive remote / cached / resident / unrunnable from
`ModelRecord.cached`, `.resident` and `.runtime`, so a row and its detail
cannot disagree about whether something is downloaded.

**A view is an entry point, and it owns its pages.** A dropdown and a centred
console will not lay the same content out the same way, so `pages/` lives under
the view rather than beside it. What they share is `components/` and `src/` —
the vocabulary and the state, never the arrangement. Adding a view is a
directory and one line in `entryPoints`.

The cost is import depth: a page reaches `"../../../components"`. QML has no
path aliases without a registered module, and the shell owns the import path,
so relative is the only option. It is noisy and it is honest.

A relative directory import needs no `qmldir` — `omarchy.notifications` ships
the same shape, and it is the precedent this follows.

**Trees flatten in JS, they do not recurse in QML.** `tree.js` walks a nested
model once per tick and emits rows carrying `depth`, `hasChildren`, `isLast`
and `rails`. QML can recurse through nested Loaders, but a process tree is
shallow and rebuilt constantly — walking it is cheaper than instantiating a
component per level, it puts collapse in one place (a collapsed node is simply
not descended into), and it leaves the logic testable with `bun` outside QML.

**A property shadows an outer id, and QML says nothing.** The `Machine`
instance is `id: daemon`, not `id: machine`, because every page exposes a
`machine` property — and inside a `Component` block `machine: machine` binds
the page's own null to itself rather than reaching the outer object. Nothing
errors, nothing logs; the views just render empty. This cost a full build cycle
to find. When a binding looks right and the view is blank, suspect this first,
and verify with a `console.log` probe read back through `quickshell log` —
absence of errors proves nothing here.

**Compile the tree before reloading: `bin/qmlcheck`.** QML's worst failures
take a whole TYPE out, and a failed type takes its dependents with it. A
`function escape(...)` is an "Illegal method name" — that file then does not
exist to the engine, `Service.qml` reports "Type Voice unavailable", and since
every surface here hangs off the service, the ENTIRE plugin renders nothing:
bar widget, browser and overlay at once. The symptom is a blank product and the
cause is one word in an unrelated file.

`qmllint --bare` does not catch this class. `qmlcachegen` does, because it
actually compiles with the same front end the engine runs. That is what
`bin/qmlcheck` wraps, and it is about a second for the whole tree.

When something DOES go blank, `journalctl --user -n 200 | grep -i qml` carries
the real error — the shell logs "plugin load failed" with the file and line.

**Local QML files lose to imported modules.** `Panel.qml` imports
`QtQuick.Controls` for `ScrollBar`, and that module exports a `TabBar` — a
local `TabBar.qml` was silently shadowed by it, and the failure reads as a typo
in your own property rather than a name collision. Hence `TabStrip`. Check any
new component name against the imported modules first.

Brand cyan is `#0094d2`, declared once on `Panel.root.brand` and passed down as
`accent`.

**There is no chart library.** No QtCharts, nothing in `qs.Ui` draws graphs.
Bars are Rectangles with bound widths; lines and areas are `QtQuick.Shapes`
(`ShapePath` + `PathPolyline`), which is retained-mode and animates on the
scene graph. `Canvas` exists but rasterises on the CPU — reach for it only if
Shapes cannot express the shape.

**The mock is opt-in and never turns itself on.** `Machine.mock`, driven by the
`mockData` setting, feeds the real shapes with a random walk so components can
be built and watched moving before there is a transport. A sine or a constant
would not answer the question the mock exists for — whether the charts read
well against data that jitters.

`Machine` is the whole seam. It exposes `connected`, `status`, `capacity`,
`usage`, `held`, `holds`, `agents`, `samples` — the shape of `MachineState`
plus `AgentsState.agents` — and every view reads only from it.

## Known Debt

See `debt.md`.
