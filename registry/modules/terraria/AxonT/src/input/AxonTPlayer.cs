#nullable enable

using Terraria;
using Terraria.ModLoader;

namespace AxonT;

/**
 * Projects leased controls and captures the owned client's body sample.
 *
 * Both hooks are gated on managed-client mode. Without that gate this silently
 * neutralizes the controls of any player whose client happens to have AxonT
 * enabled, because an unleased input state reads as "no keys held".
 */
public sealed class AxonTPlayer : ModPlayer
{
    public override void SetControls()
    {
        if (!AxonT.IsManagedClient || Player.whoAmI != Main.myPlayer)
            return;

        var input = AxonT.Input.Read();
        Player.controlLeft = input.Left;
        Player.controlRight = input.Right;
        Player.controlUp = input.Up;
        Player.controlDown = input.Down;
        Player.controlJump = input.Jump;
        Player.controlUseItem = input.UseItem;
        Player.controlUseTile = input.UseTile;
    }

    public override void PostUpdate()
    {
        if (!AxonT.IsManagedClient)
            return;

        AxonT.Body.Capture(Player);
    }
}
