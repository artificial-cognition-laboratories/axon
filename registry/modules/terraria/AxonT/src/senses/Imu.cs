#nullable enable

using System;

namespace AxonT;

/**
 * An inertial measurement unit, simulated honestly.
 *
 * Terraria hands out `player.velocity`, so acceleration is one subtraction
 * away. That is the whole danger: a clean differentiate-then-integrate round
 * trip reimplements velocity through two extra transforms and teaches the
 * organism nothing. A real inner ear is not a velocity oracle with extra
 * steps — it is a noisy, biased, saturating accelerometer, and every hard
 * problem in dead reckoning comes from those three words.
 *
 * So the loss here is deliberate and load-bearing:
 *
 *   BIAS       a slow random walk. The dominant error in real MEMS parts, and
 *              the reason integrated velocity drifts instead of merely being
 *              noisy. It cannot be calibrated away once and for all because it
 *              moves.
 *   NOISE      white, per sample. Integrated once it becomes a velocity random
 *              walk; integrated twice, position error grows faster than time.
 *   SATURATION a measurement range. A hard landing reads as "at least this
 *              much", which is what a real part does and what makes a spike a
 *              lower bound rather than a number.
 *
 * Gravity is included, because an accelerometer cannot tell being still from
 * falling freely — it measures PROPER acceleration. That is not a wart: the
 * gravity vector is what says which way is down, and it is the one output that
 * never drifts. An organism's sense of vertical comes from exactly this.
 *
 * Parameters are fields rather than constants so the difficulty is a dial: set
 * noise and bias to zero and this becomes the dishonest version, which is
 * useful precisely once, for confirming that the fusion above it works at all.
 */
internal sealed class Imu
{
    /**
     * Terraria's gravity, in px/tick². The client applies about this to a
     * falling player each tick, and a resting accelerometer reads its negation
     * — the ground pushing up.
     */
    private const float Gravity = 0.4f;

    /** Standard deviation of the per-sample white noise, px/tick². */
    private const float NoiseSigma = 0.05f;

    /**
     * How far the bias wanders per sample, px/tick². Small on purpose: a bias
     * that moved fast would be noise, and the difficulty of bias is that it
     * moves slowly enough to look like a real acceleration.
     */
    private const float BiasWalk = 0.0008f;

    /** How far the bias may wander before it is pulled back, px/tick². */
    private const float BiasLimit = 0.06f;

    /** Full-scale range. Beyond this the part clips, and the reading is a floor. */
    private const float Range = 8f;

    private readonly Random noise = new();

    private float lastVelocityX;
    private float lastVelocityY;
    private bool primed;

    private float biasX;
    private float biasY;

    /**
     * One reading, from the velocity this tick and the velocity last tick.
     *
     * `dtTicks` is the elapsed simulation time. Passed in rather than assumed
     * to be 1, because a stalled client makes the interval a lie and dividing
     * by a wrong interval is a fabricated acceleration.
     */
    internal (float X, float Y) Sample(float velocityX, float velocityY, float dtTicks)
    {
        if (!primed || dtTicks <= 0f)
        {
            primed = true;
            lastVelocityX = velocityX;
            lastVelocityY = velocityY;
            // At rest the part still feels the ground pushing up. Reporting
            // zero here would make the first sample the one moment gravity did
            // not exist.
            return Clip(-Gravity, axisNoise: true);
        }

        var accelX = (velocityX - lastVelocityX) / dtTicks;
        var accelY = (velocityY - lastVelocityY) / dtTicks;
        lastVelocityX = velocityX;
        lastVelocityY = velocityY;

        // Proper acceleration: what the body did MINUS what gravity is doing to
        // it. A player in free fall accelerates downward at g and the part
        // reads zero, exactly as a real one does.
        Walk();
        var x = accelX + biasX + Noise();
        var y = (accelY - Gravity) + biasY + Noise();

        return (Saturate(x), Saturate(y));
    }

    /** The body left the world; the last reading is a lie rather than merely stale. */
    internal void Clear()
    {
        primed = false;
        biasX = 0f;
        biasY = 0f;
    }

    private (float X, float Y) Clip(float verticalOnly, bool axisNoise)
    {
        Walk();
        var x = biasX + (axisNoise ? Noise() : 0f);
        var y = verticalOnly + biasY + (axisNoise ? Noise() : 0f);
        return (Saturate(x), Saturate(y));
    }

    /**
     * The bias takes a step, bounded.
     *
     * Bounded rather than free: an unbounded walk eventually wanders far enough
     * to dominate every reading, which stops being a sensor model and starts
     * being a broken part. Real ones stay within a spec.
     */
    private void Walk()
    {
        biasX = Bounded(biasX + (float)((noise.NextDouble() - 0.5) * 2.0 * BiasWalk));
        biasY = Bounded(biasY + (float)((noise.NextDouble() - 0.5) * 2.0 * BiasWalk));
    }

    private static float Bounded(float bias) => Math.Clamp(bias, -BiasLimit, BiasLimit);

    private static float Saturate(float value) => Math.Clamp(value, -Range, Range);

    /** Gaussian, by Box–Muller. Uniform noise would not integrate the way a real part's does. */
    private float Noise()
    {
        var first = 1.0 - noise.NextDouble();
        var second = 1.0 - noise.NextDouble();
        return (float)(Math.Sqrt(-2.0 * Math.Log(first)) * Math.Cos(2.0 * Math.PI * second) * NoiseSigma);
    }
}
