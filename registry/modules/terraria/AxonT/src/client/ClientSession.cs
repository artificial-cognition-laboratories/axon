#nullable enable

using System;
using System.Linq;
using System.Threading.Tasks;
using Terraria;
using Terraria.IO;

namespace AxonT;

/** Where the owned client currently is. Joining is a transition, not a fact. */
internal enum SessionState
{
    Menu,
    Joining,
    InWorld,
}

/**
 * The owned client's connection to a Terraria server.
 *
 * Joining is an effector action commanded over the bridge, never an environment
 * variable read at startup. tModLoader exposes no CLI join contract and no menu
 * tick hook a mod can rely on before a world exists, so every transition here is
 * queued onto the game thread explicitly.
 *
 * The call sequence mirrors Terraria's own Main.AutoJoin: resolve the address,
 * activate the dedicated player file, enter the connecting menu, open the socket.
 */
internal static class ClientSession
{
    /** Terraria's "connecting to server" menu. Main.AutoJoin sets exactly this. */
    private const int ConnectingMenuMode = 10;

    private static readonly object gate = new();
    private static SessionState state = SessionState.Menu;
    private static string? endpoint;

    internal static event Action<SessionState, string?>? Changed;

    internal static SessionState State
    {
        get { lock (gate) return state; }
    }

    internal static string? Endpoint
    {
        get { lock (gate) return endpoint; }
    }

    internal static void Enter(SessionState next, string? at = null)
    {
        lock (gate)
        {
            if (state == next && (at is null || at == endpoint))
                return;
            state = next;
            if (at is not null || next == SessionState.Menu)
                endpoint = next == SessionState.Menu ? null : at;
        }

        Discovery.Status($"session-{Describe(next)}", endpoint);
        Changed?.Invoke(next, endpoint);
    }

    internal static string Describe(SessionState value) => value switch
    {
        SessionState.Menu => "menu",
        SessionState.Joining => "joining",
        SessionState.InWorld => "in-world",
        _ => "unknown",
    };

    /**
     * Finds the dedicated character by name, the way Terraria's own AutoJoin
     * does: load the player list and match on it.
     *
     * Deliberately not Main.GetPlayerPathFromName — that builds a path for a
     * *new* character and uniquifies it, so asking it for an existing "Terry"
     * returns "Terry2.plr", a file that by definition does not exist.
     *
     * Runs on the game thread: it reads Main.PlayerList.
     */
    private static PlayerFileData ResolvePlayer(string? player)
    {
        var name = string.IsNullOrWhiteSpace(player)
            ? Environment.GetEnvironmentVariable("AXONT_PLAYER")
            : player;
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidOperationException("No player name was given and AXONT_PLAYER is unset.");

        if (name.EndsWith(".plr", StringComparison.OrdinalIgnoreCase))
            name = name[..^4];

        Main.LoadPlayers();
        var found = Main.PlayerList.FirstOrDefault(data => data.Name == name);
        if (found is null)
        {
            var available = Main.PlayerList.Count == 0
                ? "none"
                : string.Join(", ", Main.PlayerList.Select(data => data.Name));
            throw new InvalidOperationException(
                $"No character named '{name}' in this client's save directory. Available: {available}."
            );
        }

        return found;
    }

    /**
     * Commands a join and resolves once the attempt has been started on the game
     * thread. Reaching the world is a later, separate transition: TCP connect,
     * handshake and world load all happen after StartTcpClient returns.
     */
    internal static Task<string> JoinAsync(string host, int port, string? password, string? player)
    {
        // Joining is as much a reason to refuse as being in-world: two overlapping
        // attempts would both reach StartTcpClient.
        var current = State;
        if (current != SessionState.Menu)
            return Task.FromException<string>(new InvalidOperationException(
                $"Cannot join while {Describe(current)}; leave first."));

        return OnGameThreadAsync(() =>
        {
            // Resolved here rather than by the caller: it reads Main state, so
            // it belongs on the game thread with the rest of the transition.
            var data = ResolvePlayer(player);

            Enter(SessionState.Joining, $"{host}:{port}");

            if (!Netplay.SetRemoteIP(host))
                throw new InvalidOperationException($"Could not resolve {host}.");

            Netplay.ListenPort = port;
            Netplay.ServerPassword = password ?? "";
            data.SetAsActive();

            Main.menuMode = ConnectingMenuMode;
            Netplay.StartTcpClient();

            AxonTLog.Info($"AxonT commanded a join to {host}:{port} as {data.Name}.");
            return $"{host}:{port}";
        });
    }

    /**
     * Saves the character, then disconnects back to the menu.
     *
     * Saving is not a side effect of disconnecting — Terraria saves on "Save &
     * Exit", which this does not go through. Without it the .plr on disk is
     * whatever was last written, and the lab copying it back to the agent's
     * folder would silently roll the character back: its inventory, its
     * health, everything since.
     */
    internal static Task LeaveAsync()
    {
        return OnGameThreadAsync<object?>(() =>
        {
            AxonT.Input.Neutralize();
            if (Main.ActivePlayerFileData is { } active && State == SessionState.InWorld)
                Player.SavePlayer(active);
            Netplay.Disconnect = true;
            Main.menuMode = 0;
            return null;
        });
    }

    /**
     * Creates a new character in this client's save folder and returns its name.
     *
     * The lab calls this the first time an agent is embodied: the agent owns a
     * character from then on, and the lab copies it between the agent's folder
     * and whichever body it occupies. Refuses a name that already exists rather
     * than overwriting a character someone is attached to.
     */
    internal static Task<string> CreatePlayerAsync(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
            return Task.FromException<string>(new ArgumentException("create-player requires a name."));
        var trimmed = name.EndsWith(".plr", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name;

        return OnGameThreadAsync(() =>
        {
            Main.LoadPlayers();
            if (Main.PlayerList.Any(data => data.Name == trimmed))
                throw new InvalidOperationException($"A character named '{trimmed}' already exists here.");

            var player = new Player { name = trimmed };
            PlayerFileData.CreateAndSave(player);
            Main.LoadPlayers();
            AxonTLog.Info($"AxonT created character {trimmed}.");
            return trimmed;
        });
    }

    /**
     * Terraria's fields are game-thread state. Network workers must never touch
     * them directly, so every transition is marshalled and its failure is
     * returned to the caller rather than thrown into the game loop.
     */
    internal static Task<T> OnGameThreadAsync<T>(Func<T> work)
    {
        var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Main.QueueMainThreadAction(() =>
        {
            try { completion.TrySetResult(work()); }
            catch (Exception error)
            {
                Enter(SessionState.Menu);
                completion.TrySetException(error);
            }
        });
        return completion.Task;
    }
}
