#nullable enable

using Terraria;
using Terraria.ModLoader;

namespace AxonT;

/**
 * Item consumption is a GlobalItem hook, not a ModPlayer one, so this is the
 * only place that routes "an item was consumed" into the eating player's
 * survival stats.
 */
public sealed class SurvivalItem : GlobalItem
{
    public override void OnConsumeItem(Item item, Player player) =>
        player.GetModPlayer<SurvivalPlayer>().Hunger.OnConsumeItem(item, ModContent.GetInstance<SurvivalConfig>());
}
