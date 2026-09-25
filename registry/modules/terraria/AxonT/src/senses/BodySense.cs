#nullable enable

using System;
using Terraria;
using Terraria.ModLoader;

namespace AxonT;

/**
 * A main-thread snapshot of only Terry's own internal/mechanical state.
 *
 * It contains no position, tiles, entities, inventory, map, or semantic game
 * events. The server reads immutable copies off-thread; only Capture() touches
 * Terraria's Player API.
 */
internal sealed class BodySense
{
    private readonly object gate = new();
    private BodySample latest = BodySample.Unavailable;

    /**
     * The inner ear. Stateful, and the state is the point: bias wanders and the
     * previous velocity is what acceleration is measured against.
     */
    private readonly Imu imu = new();
    private long lastObservedAt;

    internal void Capture(Player player)
    {
        // Somebody else's body says nothing about this one. The hook runs for
        // every player on the client, so writing here would blank Terry's fresh
        // sample every tick that Cody — or anyone — shares the world with him:
        // interoception that flickers off only in multiplayer.
        if (player.whoAmI != Main.myPlayer)
            return;

        if (!player.active)
        {
            imu.Clear();
            lastObservedAt = 0;
            lock (gate)
                latest = BodySample.Unavailable;
            return;
        }

        // What crosses into the mind is the INERTIAL reading, and nothing else.
        // True velocity and position are carried too, but the bridge plugin
        // drops both at the door — they are the lab's answer key for scoring
        // dead reckoning, never a sense. Nothing here inspects tiles, entities
        // or collision geometry.
        var survival = player.GetModPlayer<SurvivalPlayer>();
        var survivalConfig = ModContent.GetInstance<SurvivalConfig>();

        // Measured against the real interval, not assumed to be one tick: a
        // stalled client makes the interval a lie, and dividing a velocity
        // change by the wrong interval is a fabricated acceleration.
        var observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var dtTicks = lastObservedAt == 0 ? 0f : (observedAt - lastObservedAt) / 1000f * 60f;
        lastObservedAt = observedAt;
        var inertial = imu.Sample(player.velocity.X, player.velocity.Y, dtTicks);

        var sample = new BodySample(
            available: true,
            observedAt: observedAt,
            healthCurrent: player.statLife,
            healthMaximum: player.statLifeMax2,
            manaCurrent: player.statMana,
            manaMaximum: player.statManaMax2,
            breathCurrent: player.breath,
            breathMaximum: player.breathMax,
            hungerCurrent: survival.Hunger.Current,
            hungerMaximum: survivalConfig.HungerMaximum,
            thirstCurrent: survival.Thirst.Current,
            thirstMaximum: survivalConfig.ThirstMaximum,
            staminaCurrent: survival.Stamina.Current,
            staminaMaximum: survivalConfig.StaminaMaximum,
            painCurrent: survival.Pain.Current,
            painMaximum: survivalConfig.PainMaximum,
            positionX: player.position.X,
            positionY: player.position.Y,
            velocityHorizontal: player.velocity.X,
            velocityVertical: player.velocity.Y,
            inertialX: inertial.X,
            inertialY: inertial.Y
        );

        lock (gate)
            latest = sample;
    }

    /** Leaving a world makes the last sample a lie; it is not merely stale. */
    internal void Clear()
    {
        lock (gate)
            latest = BodySample.Unavailable;
    }

    internal BodySample Read()
    {
        lock (gate)
            return latest;
    }
}

internal readonly struct BodySample
{
    internal static readonly BodySample Unavailable = new(
        available: false,
        observedAt: 0,
        healthCurrent: 0,
        healthMaximum: 0,
        manaCurrent: 0,
        manaMaximum: 0,
        breathCurrent: 0,
        breathMaximum: 0,
        hungerCurrent: 0f,
        hungerMaximum: 0f,
        thirstCurrent: 0f,
        thirstMaximum: 0f,
        staminaCurrent: 0f,
        staminaMaximum: 0f,
        painCurrent: 0f,
        painMaximum: 0f,
        positionX: 0f,
        positionY: 0f,
        velocityHorizontal: 0f,
        velocityVertical: 0f,
        inertialX: 0f,
        inertialY: 0f
    );

    internal BodySample(
        bool available,
        long observedAt,
        int healthCurrent,
        int healthMaximum,
        int manaCurrent,
        int manaMaximum,
        int breathCurrent,
        int breathMaximum,
        float hungerCurrent,
        float hungerMaximum,
        float thirstCurrent,
        float thirstMaximum,
        float staminaCurrent,
        float staminaMaximum,
        float painCurrent,
        float painMaximum,
        float positionX,
        float positionY,
        float velocityHorizontal,
        float velocityVertical,
        float inertialX,
        float inertialY
    )
    {
        Available = available;
        ObservedAt = observedAt;
        HealthCurrent = healthCurrent;
        HealthMaximum = healthMaximum;
        ManaCurrent = manaCurrent;
        ManaMaximum = manaMaximum;
        BreathCurrent = breathCurrent;
        BreathMaximum = breathMaximum;
        HungerCurrent = hungerCurrent;
        HungerMaximum = hungerMaximum;
        ThirstCurrent = thirstCurrent;
        ThirstMaximum = thirstMaximum;
        StaminaCurrent = staminaCurrent;
        StaminaMaximum = staminaMaximum;
        PainCurrent = painCurrent;
        PainMaximum = painMaximum;
        PositionX = positionX;
        PositionY = positionY;
        VelocityHorizontal = velocityHorizontal;
        VelocityVertical = velocityVertical;
        InertialX = inertialX;
        InertialY = inertialY;
    }

    internal bool Available { get; }
    internal long ObservedAt { get; }
    internal int HealthCurrent { get; }
    internal int HealthMaximum { get; }
    internal int ManaCurrent { get; }
    internal int ManaMaximum { get; }
    internal int BreathCurrent { get; }
    internal int BreathMaximum { get; }
    internal float HungerCurrent { get; }
    internal float HungerMaximum { get; }
    internal float ThirstCurrent { get; }
    internal float ThirstMaximum { get; }
    internal float StaminaCurrent { get; }
    internal float StaminaMaximum { get; }
    internal float PainCurrent { get; }
    internal float PainMaximum { get; }
    internal float PositionX { get; }
    internal float PositionY { get; }
    /**
     * True velocity, and true position above. Both are ANSWER KEY: they never
     * cross the door into the mind — the bridge plugin drops them — and exist
     * so the lab can score what dead reckoning made of the inertial reading.
     */
    internal float VelocityHorizontal { get; }
    internal float VelocityVertical { get; }

    /**
     * What the inner ear actually reports, and the whole of what crosses the
     * door: noisy, biased, saturating, gravity included.
     *
     * `Grounded` used to be here too and is gone. Whether something is holding
     * the body up is a question about the world, and the mind works it out from
     * this signal alone — a body on ground feels the full pull opposed, one in
     * free fall feels nothing.
     */
    internal float InertialX { get; }
    internal float InertialY { get; }
}
