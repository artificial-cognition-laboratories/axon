#nullable enable

using System.ComponentModel;
using Terraria.ModLoader.Config;

namespace AxonT;

/**
 * Tunables for every survival stat, kept in one config rather than one per
 * stat: they get tuned together when shaping a benchmark scenario (e.g. "harsh
 * hunger, mild temperature"). ClientSide because AxonT is Client-only (build.txt) —
 * there is no server component to host a ServerSide config.
 */
public sealed class SurvivalConfig : ModConfig
{
    public override ConfigScope Mode => ConfigScope.ClientSide;

    [Header("Hunger")]

    /** Off: the meter holds full and never starves. Off until the lab has food to find. */
    [DefaultValue(false)]
    public bool HungerEnabled;

    [DefaultValue(100f)]
    public float HungerMaximum;

    /** 60 ticks/second; default drains a full meter in ~30 minutes. */
    [DefaultValue(0.00093f)]
    public float HungerDecayPerTick;

    /** Damage taken per starvation hit once hunger is empty. */
    [DefaultValue(4)]
    public int StarvationDamage;

    /** Ticks between starvation hits (3 seconds by default). */
    [DefaultValue(180)]
    public int StarvationIntervalTicks;

    [Header("Thirst")]

    /** Off: the meter holds full and never dehydrates. Off until the lab has water to find. */
    [DefaultValue(false)]
    public bool ThirstEnabled;

    [DefaultValue(100f)]
    public float ThirstMaximum;

    /** Drains faster than hunger; default empties a full meter in ~15 minutes. */
    [DefaultValue(0.00185f)]
    public float ThirstDecayPerTick;

    /** Refill rate while standing in water — drinking is fast, ~33 seconds to fill from empty. */
    [DefaultValue(0.05f)]
    public float ThirstRefillPerTick;

    /** Damage taken per dehydration hit once thirst is empty. */
    [DefaultValue(4)]
    public int DehydrationDamage;

    /** Ticks between dehydration hits (3 seconds by default). */
    [DefaultValue(180)]
    public int DehydrationIntervalTicks;

    [Header("Pain")]

    /** The scale pain is reported against. */
    [DefaultValue(100f)]
    public float PainMaximum;

    /** Pain per point of damage: a 20-damage zombie hit is most of the meter. */
    [DefaultValue(4f)]
    public float PainPerDamage;

    /** 60 ticks/second; default fades a full meter in ~5 seconds. */
    [DefaultValue(0.33f)]
    public float PainFadePerTick;

    [Header("Stamina")]
    [DefaultValue(100f)]
    public float StaminaMaximum;

    /** Drains while exerting (moving on foot or swimming); empties in ~20 seconds of continuous exertion. */
    [DefaultValue(0.0833f)]
    public float StaminaDrainPerTick;

    /** Regenerates while idle; fills from empty in ~15 seconds. */
    [DefaultValue(0.111f)]
    public float StaminaRegenPerTick;

    /** Move speed multiplier applied while stamina is empty. */
    [DefaultValue(0.5f)]
    public float ExhaustedMoveSpeedMultiplier;
}
