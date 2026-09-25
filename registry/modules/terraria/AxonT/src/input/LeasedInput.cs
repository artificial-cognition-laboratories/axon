#nullable enable

using System;

namespace AxonT;

/** Complete keyboard-equivalent control state, never a semantic game action. */
internal readonly struct LeasedInputState
{
    internal static readonly LeasedInputState Neutral = new(false, false, false, false, false, false, false);

    internal LeasedInputState(bool left, bool right, bool up, bool down, bool jump, bool useItem, bool useTile)
    {
        Left = left;
        Right = right;
        Up = up;
        Down = down;
        Jump = jump;
        UseItem = useItem;
        UseTile = useTile;
    }

    internal bool Left { get; }
    internal bool Right { get; }
    internal bool Up { get; }
    internal bool Down { get; }
    internal bool Jump { get; }
    internal bool UseItem { get; }
    internal bool UseTile { get; }
}

/**
 * Thread-safe, single-owner input lease. Network workers submit state; the
 * game thread reads it. Expiry is enforced at read time, so stale control
 * always becomes neutral even if a disconnect is never observed.
 */
internal sealed class LeasedInput
{
    internal const int MinLeaseMs = 50;
    internal const int MaxLeaseMs = 250;

    private readonly object gate = new();
    private string? owner;
    private long lastSequence = -1;
    private long expiresAtUnixMs;
    private LeasedInputState state = LeasedInputState.Neutral;

    internal bool TrySet(string sessionId, long sequence, int leaseMs, LeasedInputState next, out string rejection)
    {
        lock (gate)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (leaseMs < MinLeaseMs || leaseMs > MaxLeaseMs)
            {
                rejection = $"leaseMs must be {MinLeaseMs}..{MaxLeaseMs}";
                return false;
            }

            if (owner is not null && owner != sessionId && now < expiresAtUnixMs)
            {
                rejection = "another session holds the input lease";
                return false;
            }

            if (owner == sessionId && sequence <= lastSequence)
            {
                rejection = "input sequence must strictly increase";
                return false;
            }

            owner = sessionId;
            lastSequence = sequence;
            state = next;
            expiresAtUnixMs = now + leaseMs;
            rejection = "";
            return true;
        }
    }

    internal LeasedInputState Read()
    {
        lock (gate)
        {
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= expiresAtUnixMs)
                NeutralizeLocked();

            return state;
        }
    }

    internal void Release(string sessionId)
    {
        lock (gate)
            if (owner == sessionId)
                NeutralizeLocked();
    }

    internal void Neutralize()
    {
        lock (gate)
            NeutralizeLocked();
    }

    private void NeutralizeLocked()
    {
        owner = null;
        lastSequence = -1;
        expiresAtUnixMs = 0;
        state = LeasedInputState.Neutral;
    }
}
