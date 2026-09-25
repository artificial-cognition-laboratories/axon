#nullable enable

using System;
using System.Threading.Tasks;
using Terraria;
using Terraria.Chat;
using Terraria.ID;

namespace AxonT;

/**
 * Discrete acts, as opposed to continuous control.
 *
 * Holding a key is motor output and belongs on the input lease. Speaking,
 * toggling PvP or picking a hotbar slot are single events with no duration —
 * they are commands, in the same family as joining a server, and they are
 * invoked rather than held.
 *
 * Everything here touches Terraria state, so everything here runs on the game
 * thread and refuses outright unless there is a body to act with.
 */
internal static class Actions
{
    private const int HotbarSlots = 10;

    private static void RequireBody()
    {
        if (ClientSession.State != SessionState.InWorld)
            throw new InvalidOperationException("Not in a world; there is no body to act with.");
    }

    /** Says something in multiplayer chat, as this client's player. */
    internal static Task<string> SayAsync(string? text)
    {
        var message = text?.Trim();
        if (string.IsNullOrEmpty(message))
            throw new ArgumentException("say requires something to say.");
        if (message.Length > 500)
            throw new ArgumentException($"say is limited to 500 characters, got {message.Length}.");

        return ClientSession.OnGameThreadAsync(() =>
        {
            RequireBody();
            ChatHelper.SendChatMessageFromClient(new ChatMessage(message));
            AxonTLog.Info($"AxonT said: {message}");
            return message;
        });
    }

    /**
     * Opts in or out of player-versus-player damage.
     *
     * The flag is local until the server is told, so the broadcast is part of
     * the act rather than an afterthought — a client that believes it is
     * hostile while nobody else does is worse than one that never toggled.
     */
    internal static Task<bool> SetPvpAsync(bool enabled)
    {
        return ClientSession.OnGameThreadAsync(() =>
        {
            RequireBody();
            Main.LocalPlayer.hostile = enabled;
            NetMessage.SendData(MessageID.TogglePVP, number: Main.myPlayer);
            AxonTLog.Info($"AxonT set pvp={enabled}.");
            return enabled;
        });
    }

    /** Joins a team: 0 none, 1 red, 2 green, 3 blue, 4 yellow, 5 pink. */
    internal static Task<int> SetTeamAsync(int team)
    {
        if (team is < 0 or > 5)
            throw new ArgumentException($"team must be 0..5, got {team}.");

        return ClientSession.OnGameThreadAsync(() =>
        {
            RequireBody();
            Main.LocalPlayer.team = team;
            NetMessage.SendData(MessageID.PlayerTeam, number: Main.myPlayer);
            AxonTLog.Info($"AxonT joined team {team}.");
            return team;
        });
    }

    /**
     * Chooses which hotbar slot is held.
     *
     * This is what makes the existing useItem control mean different things:
     * the motor lease presses the button, this decides what the button does.
     */
    internal static Task<int> SelectSlotAsync(int slot)
    {
        if (slot is < 0 || slot >= HotbarSlots)
            throw new ArgumentException($"slot must be 0..{HotbarSlots - 1}, got {slot}.");

        return ClientSession.OnGameThreadAsync(() =>
        {
            RequireBody();
            Main.LocalPlayer.selectedItem = slot;
            return slot;
        });
    }
}
