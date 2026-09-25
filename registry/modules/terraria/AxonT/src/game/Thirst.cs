#nullable enable

using System;
using Terraria;
using Terraria.ModLoader.IO;

namespace AxonT;

/**
 * Decays faster than hunger. Restored passively by standing in water — there's
 * no carried water item yet, so submersion is the only "drink" signal
 * available without new content; a bottle item can replace this later.
 *
 * Empty thirst doesn't damage on its own; it fires its own interval hit
 * alongside hunger's, so a player empty on both compounds naturally without
 * special-cased logic.
 */
internal sealed class Thirst
{
    internal float Current { get; private set; }

    private int ticksSinceDehydrationHit;

    internal void Tick(Player player, SurvivalConfig config)
    {
        // Disabled means held full, not frozen: a body sense reading "starving
        // but unharmed" would teach the mind a lie about its own state.
        if (!config.ThirstEnabled)
        {
            Current = config.ThirstMaximum;
            return;
        }

        bool inWater = player.wet && !player.lavaWet && !player.honeyWet;
        float delta = inWater ? config.ThirstRefillPerTick : -config.ThirstDecayPerTick;
        Current = Math.Clamp(Current + delta, 0f, config.ThirstMaximum);

        if (Current > 0f)
        {
            ticksSinceDehydrationHit = 0;
            return;
        }

        if (++ticksSinceDehydrationHit < config.DehydrationIntervalTicks)
            return;

        ticksSinceDehydrationHit = 0;
        player.statLife = Math.Max(1, player.statLife - config.DehydrationDamage);
    }

    internal void Save(TagCompound tag) => tag["thirst"] = Current;

    /** Missing means a brand-new character, not an empty canteen — default full. */
    internal void Load(TagCompound tag, SurvivalConfig config) =>
        Current = tag.ContainsKey("thirst") ? tag.GetFloat("thirst") : config.ThirstMaximum;
}
