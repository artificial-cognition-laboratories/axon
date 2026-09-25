#nullable enable

using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Terraria;
using Terraria.ModLoader;
using Terraria.UI;

namespace AxonT;

/**
 * A plain text readout, not a polished bar — this exists so a human watching
 * any client (Terry's or your own) can see what the survival stats are doing
 * while iterating, not as the mod's final HUD.
 */
public sealed class SurvivalHud : ModSystem
{
    public override void ModifyInterfaceLayers(List<GameInterfaceLayer> layers)
    {
        int index = layers.FindIndex(layer => layer.Name == "Vanilla: Resource Bars");
        if (index == -1)
            return;

        layers.Insert(index + 1, new LegacyGameInterfaceLayer(
            "AxonT: Survival HUD",
            DrawHud,
            InterfaceScaleType.UI));
    }

    private static bool DrawHud()
    {
        var player = Main.LocalPlayer;
        if (player?.active != true)
            return true;

        var survival = player.GetModPlayer<SurvivalPlayer>();
        var config = ModContent.GetInstance<SurvivalConfig>();

        string[] lines =
        [
            $"Stamina: {survival.Stamina.Current:0}/{config.StaminaMaximum:0}",
            $"Thirst: {survival.Thirst.Current:0}/{config.ThirstMaximum:0}",
            $"Hunger: {survival.Hunger.Current:0}/{config.HungerMaximum:0}",
        ];

        const float lineHeight = 22f;
        float y = Main.screenHeight - 20f - lineHeight * lines.Length;
        foreach (string line in lines)
        {
            Utils.DrawBorderString(Main.spriteBatch, line, new Vector2(20f, y), Color.White);
            y += lineHeight;
        }

        return true;
    }
}
