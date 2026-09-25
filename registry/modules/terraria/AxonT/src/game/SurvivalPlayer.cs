#nullable enable

using Terraria;
using Terraria.ModLoader;
using Terraria.ModLoader.IO;

namespace AxonT;

/**
 * Host for every survival stat. Ticks and persists each one; the per-stat
 * logic (decay curve, effects, restoration) lives in that stat's own class.
 */
public sealed class SurvivalPlayer : ModPlayer
{
    internal readonly Hunger Hunger = new();
    internal readonly Thirst Thirst = new();
    internal readonly Stamina Stamina = new();
    internal readonly Pain Pain = new();

    public override void PostUpdate()
    {
        var config = ModContent.GetInstance<SurvivalConfig>();
        Hunger.Tick(Player, config);
        Thirst.Tick(Player, config);
        Stamina.Tick(Player, config);

        // A dead body feels nothing, and the one that respawns is whole.
        if (Player.dead) Pain.Clear();
        else Pain.Tick(config);
    }

    /** Injury, felt as it lands — see Pain. */
    public override void OnHurt(Player.HurtInfo info) =>
        Pain.Hurt(info.Damage, ModContent.GetInstance<SurvivalConfig>());

    public override void PostUpdateRunSpeeds() =>
        Stamina.ApplyRunSpeedPenalty(Player, ModContent.GetInstance<SurvivalConfig>());

    public override void SaveData(TagCompound tag)
    {
        Hunger.Save(tag);
        Thirst.Save(tag);
        Stamina.Save(tag);
    }

    public override void LoadData(TagCompound tag)
    {
        var config = ModContent.GetInstance<SurvivalConfig>();
        Hunger.Load(tag, config);
        Thirst.Load(tag, config);
        Stamina.Load(tag, config);
    }
}
