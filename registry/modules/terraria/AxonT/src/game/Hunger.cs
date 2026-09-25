#nullable enable

using System;
using Terraria;
using Terraria.ID;
using Terraria.ModLoader.IO;

namespace AxonT;

/**
 * Decays continuously; once empty, hits the player on an interval instead of
 * killing outright — starvation alone shouldn't end a run in v1, only make one
 * harder, until temperature/thirst exist to compound with it.
 *
 * Restoration is detected as consuming any item that applies a Well Fed buff:
 * that's the same signal vanilla Terraria uses to mean "that was food", so
 * custom food items are covered for free, with no hand-maintained item list.
 */
internal sealed class Hunger
{
    internal float Current { get; private set; }

    private int ticksSinceStarvationHit;

    internal void Tick(Player player, SurvivalConfig config)
    {
        // Disabled means held full, not frozen: a body sense reading "starving
        // but unharmed" would teach the mind a lie about its own state.
        if (!config.HungerEnabled)
        {
            Current = config.HungerMaximum;
            return;
        }

        Current = Math.Clamp(Current - config.HungerDecayPerTick, 0f, config.HungerMaximum);

        if (Current > 0f)
        {
            ticksSinceStarvationHit = 0;
            return;
        }

        if (++ticksSinceStarvationHit < config.StarvationIntervalTicks)
            return;

        ticksSinceStarvationHit = 0;
        player.statLife = Math.Max(1, player.statLife - config.StarvationDamage);
    }

    internal void OnConsumeItem(Item item, SurvivalConfig config)
    {
        if (item.buffType != BuffID.WellFed && item.buffType != BuffID.WellFed2 && item.buffType != BuffID.WellFed3)
            return;

        Current = config.HungerMaximum;
    }

    internal void Save(TagCompound tag) => tag["hunger"] = Current;

    /** Missing means a brand-new character, not an empty stomach — default full. */
    internal void Load(TagCompound tag, SurvivalConfig config) =>
        Current = tag.ContainsKey("hunger") ? tag.GetFloat("hunger") : config.HungerMaximum;
}
