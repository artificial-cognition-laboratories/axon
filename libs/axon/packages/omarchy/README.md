# Axon for Omarchy

What Axon is running on this machine — live agents, resident models, and the
resources they hold — in the Omarchy bar.

## Install

```bash
omarchy plugin add https://github.com/<org>/axon-omarchy.git --enable
```

## Development

```bash
bin/install --link          # symlink into ~/.config/omarchy/plugins
omarchy plugin enable arclabs.axon
```

Saving any file under `~/.config/omarchy/plugins/` reloads the plugin
automatically. If a change does not take, force it with:

```bash
omarchy-shell shell rescanPlugins
```

Read the shell log — QML errors appear here and nowhere else:

```bash
quickshell log -p /usr/share/omarchy/shell --no-color --log-times | tail -40
```

Drive the panel without touching the bar:

```bash
omarchy-shell arclabs.axon open
omarchy-shell arclabs.axon close
```

`omarchy plugin validate .` checks the manifest. Note it refuses a symlinked
plugin folder, so run it against this directory rather than the linked copy.

## Settings

| Key | Default | What it does |
|---|---|---|
| `showWhenIdle` | `false` | By default the icon leaves the bar entirely when the daemon is down and nothing is resident. Set `true` to keep it pinned while developing. |

Set it on the widget's entry in `~/.config/omarchy/shell.json`:

```json
{ "id": "arclabs.axon", "showWhenIdle": "true" }
```
