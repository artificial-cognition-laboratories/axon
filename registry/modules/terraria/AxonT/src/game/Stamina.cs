#nullable enable

using System;
using Terraria;
using Terraria.ModLoader.IO;

namespace AxonT;

/**
 * Drains while actually exerting (moving on foot or swimming), regenerates
 * while still. Empty stamina doesn't damage — it saps move speed instead, via
 * PostUpdateRunSpeeds, so exhaustion is felt immediately rather than as a
 * delayed health tax like hunger/thirst.
 */
internal sealed class Stamina
{
    internal float Current { get; private set; }

    internal void Tick(Player player, SurvivalConfig config)
    {
        // Grounded is inferred the same way BodySense does: zero vertical motion.
        bool exerting = (player.velocity.X != 0f && player.velocity.Y == 0f) || player.wet;
        float delta = exerting ? -config.StaminaDrainPerTick : config.StaminaRegenPerTick;
        Current = Math.Clamp(Current + delta, 0f, config.StaminaMaximum);
    }

    internal void ApplyRunSpeedPenalty(Player player, SurvivalConfig config)
    {
        if (Current > 0f)
            return;

        player.moveSpeed *= config.ExhaustedMoveSpeedMultiplier;
    }

    internal void Save(TagCompound tag) => tag["stamina"] = Current;

    /** Missing means a brand-new character, not exhausted — default full. */
    internal void Load(TagCompound tag, SurvivalConfig config) =>
        Current = tag.ContainsKey("stamina") ? tag.GetFloat("stamina") : config.StaminaMaximum;
}
