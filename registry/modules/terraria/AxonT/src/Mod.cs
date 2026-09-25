#nullable enable

using System;
using Terraria;
using Terraria.ModLoader;

namespace AxonT;

/**
 * Terraria-side body host.
 *
 * The bridge exists only in an explicitly managed agent client, and it starts as
 * soon as content is set up — at the menu, before any world exists. Joining a
 * server is a command that arrives over this cable, so the cable cannot be gated
 * on being in a world: that ordering is a deadlock.
 *
 * The discovery record therefore means "this client is reachable". Whether it is
 * embodied is carried continuously by the session packet instead.
 */
public sealed class AxonT : ModSystem
{
    internal const int ProtocolVersion = 0;
    internal static Mod? ModInstance { get; private set; }
    internal static LeasedInput Input { get; } = new();
    internal static BodySense Body { get; } = new();

    private BridgeServer? bridge;

    /**
     * Everything this mod does is confined to an agent-owned client. The user's
     * own client may have AxonT enabled — building it through the GUI does
     * exactly that — and must be left completely untouched.
     */
    internal static bool IsManagedClient =>
        string.Equals(Environment.GetEnvironmentVariable("AXONT_MANAGED_CLIENT"), "1", StringComparison.Ordinal);

    public override void PostSetupContent()
    {
        ModInstance = Mod;
        if (!IsManagedClient)
        {
            Mod.Logger.Info("AxonT loaded without managed-client mode; bridge disabled.");
            return;
        }

        try
        {
            bridge ??= new BridgeServer(Input, Body);
            bridge.Start();
            Discovery.Status("bridge-listening", $"port={BridgeServer.Port}");
            Mod.Logger.Info(
                $"AxonT is reachable at the menu on port {BridgeServer.Port}; " +
                $"discovery: {Discovery.PathForCurrentUser()}"
            );
        }
        catch (Exception error)
        {
            bridge?.Dispose();
            bridge = null;
            Discovery.Status("bridge-failed", null, error.ToString());
            Mod.Logger.Error("AxonT could not start its managed body host.", error);
        }
    }

    public override void OnWorldLoad()
    {
        if (!IsManagedClient)
            return;

        ClientSession.Enter(SessionState.InWorld, ClientSession.Endpoint);
    }

    public override void OnWorldUnload()
    {
        if (!IsManagedClient)
            return;

        // The last body sample described a player that no longer exists. Holding
        // it would feed the agent a confident lie for as long as it stayed at the menu.
        Input.Neutralize();
        Body.Clear();
        ClientSession.Enter(SessionState.Menu);
    }

    public override void Unload()
    {
        Input.Neutralize();
        bridge?.Dispose();
        bridge = null;
        ModInstance = null;
    }
}
