#nullable enable

using System;
using Terraria;

namespace AxonT;

/**
 * Pain — being hurt, felt as it happens.
 *
 * Without this, injury reaches the mind only as health being lower than it
 * was: a difference between two readings, which the mind must notice, hold
 * and subtract. That is inference, not sensation, and it arrives a tick late
 * and blurred — a slow poison and a sword both read as "less health".
 *
 * So the body reports the hit itself. It spikes with the damage taken and
 * fades, which makes "I am being hurt right now" and "I was hurt a moment
 * ago" different values rather than the same one.
 *
 * ONE signal, not one per limb. A body map is a real thing to want later —
 * where it hurts changes what you do about it — but nothing downstream can
 * use location yet, and a sense nobody reads is decoration.
 *
 * Deliberately NOT persisted: pain is a state of the body now, and a
 * character that loads still hurting from yesterday's wound would be lying.
 */
internal sealed class Pain
{
    internal float Current { get; private set; }

    /** Called when the body takes damage, with what it cost. */
    internal void Hurt(int damage, SurvivalConfig config)
    {
        Current = Math.Clamp(Current + damage * config.PainPerDamage, 0f, config.PainMaximum);
    }

    internal void Tick(SurvivalConfig config)
    {
        Current = Math.Max(0f, Current - config.PainFadePerTick);
    }

    /** A respawned body is a whole one. */
    internal void Clear() => Current = 0f;
}
