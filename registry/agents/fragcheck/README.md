# fragcheck

A Linux gaming-readiness specialist that lives on your machine.

Install it, and it inspects your actual rig — GPU, drivers, Vulkan, display
server, CPU governor, Proton, and the dozen small settings that quietly cost
you frames — then tells you, straight, how ready you are to game. No generic
advice: every judgment is grounded in what it reads from *your* system.

## Install

```bash
axon install fragcheck
```

## Use

Just ask:

```
» check my rig
```

fragcheck opens already knowing your machine — distro, kernel, GPU, driver,
memory, session, governor, and which gaming tools you have — with no waiting
around. It fills any gaps, forms a verdict, and hands you a scored report:

```
FRAGCHECK — Gaming Readiness
your-host · Ubuntu 24.04 · kernel 6.17

  ✓ GPU            NVIDIA RTX 2080 Ti · nvidia 580
  ✓ Vulkan         device present
  ✗ CPU governor   powersave — want performance
  ⚠ Display        X11 — Wayland would enable VRR
  ✓ Steam/Proton   installed

  SCORE  7/10 — Ready, with a couple of easy wins

  FIX NOW (ranked by impact)
  1. sudo cpupower frequency-set -g performance
  2. switch to a Wayland session for VRR
```

Ask follow-ups — *"why does the governor matter?"*, *"how do I fix the
display thing?"* — and it explains from what it already saw. It never touches
your machine without asking; auditing is read-only.

## What it checks

- **GPU & driver** — the right driver for your card, loaded and current
- **Vulkan** — a real GPU device, not software rendering
- **CPU governor** — performance vs. frame-capping power-saving
- **Display server & VRR** — Wayland/X11 and variable-refresh readiness
- **gamemode**, **Steam/Proton**, **MangoHud**, shader pre-caching
- System tunables that affect frame pacing

Built on [Axon](https://axon.arclabs.it).
