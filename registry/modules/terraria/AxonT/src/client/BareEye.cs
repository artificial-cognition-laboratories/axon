#nullable enable

using System.Collections.Generic;
using Terraria.ModLoader;
using Terraria.UI;

namespace AxonT;

/**
 * A managed client draws the WORLD, and nothing else.
 *
 * The interface is drawn for a player: hotbar, hearts, chat, cursor, our own
 * survival readout. None of it is in the world, and an agent that sees only
 * pixels has no way to know that — so it perceives the HUD as objects, learns
 * that its corners are full of things that move with its eye, and spends its
 * first minutes in every body discovering that they are not real.
 *
 * Removing the layers is the honest fix: what the interface DISPLAYS already
 * reaches the agent as interoception (health, mana, breath, hunger, thirst,
 * stamina, pain) on the body cable, where a creature feels it. A picture of a
 * heart is a convenience for a person with eyes on a screen.
 *
 * Gated on managed-client mode, so your own client is untouched.
 */
public sealed class BareEye : ModSystem
{
    public override void ModifyInterfaceLayers(List<GameInterfaceLayer> layers)
    {
        if (!AxonT.IsManagedClient)
            return;

        layers.Clear();
    }
}
