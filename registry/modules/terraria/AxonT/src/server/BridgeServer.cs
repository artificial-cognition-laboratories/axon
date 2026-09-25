#nullable enable

using System;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace AxonT;

/**
 * Loopback body host. Each connection gets a unique controller identity.
 * All writes share one gate: WebSocket permits one writer, even while a
 * heartbeat and a command acknowledgement are both active.
 */
internal sealed class BridgeServer : IDisposable
{
    internal static int Port
    {
        get
        {
            var raw = Environment.GetEnvironmentVariable("AXONT_BRIDGE_PORT");
            return int.TryParse(raw, out var port) && port is >= 1024 and <= 65535 ? port : 51337;
        }
    }
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly HttpListener listener = new();
    private readonly CancellationTokenSource stopping = new();
    private readonly string instanceId = Guid.NewGuid().ToString("D");
    private readonly LeasedInput input;
    private readonly BodySense body;
    private bool stopped;
    private bool disposed;

    internal BridgeServer(LeasedInput input, BodySense body)
    {
        this.input = input;
        this.body = body;
    }
    internal bool IsListening => listener.IsListening;

    internal void Start()
    {
        listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
        listener.Start();
        Discovery.Write(Port, instanceId);
        _ = Task.Run(AcceptLoopAsync);
        AxonTLog.Info($"AxonT listening at ws://127.0.0.1:{Port}/bridge (instance {instanceId}).");
    }

    private async Task AcceptLoopAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            try
            {
                var context = await listener.GetContextAsync();
                _ = Task.Run(() => HandleAsync(context));
            }
            catch (HttpListenerException) when (stopping.IsCancellationRequested) { return; }
            catch (ObjectDisposedException) when (stopping.IsCancellationRequested) { return; }
            catch (Exception error)
            {
                AxonTLog.Error("AxonT listener failed while accepting a connection.", error);
                return;
            }
        }
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        if (context.Request.Url?.AbsolutePath != "/bridge")
        {
            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            context.Response.Close();
            return;
        }
        if (!context.Request.IsWebSocketRequest)
        {
            context.Response.StatusCode = (int)HttpStatusCode.UpgradeRequired;
            context.Response.Close();
            return;
        }

        var sessionId = Guid.NewGuid().ToString("D");
        // Deliberately never disposed. Detached work — the body stream, a join
        // that takes seconds — legitimately outlives this method and takes the
        // gate on its way out; disposing it here raced them into
        // ObjectDisposedException. A SemaphoreSlim whose AvailableWaitHandle is
        // never touched holds nothing to release, and this one never is.
        var writes = new SemaphoreSlim(1, 1);
        Action<SessionState, string?>? onSessionChanged = null;
        try
        {
            var upgrade = await context.AcceptWebSocketAsync(subProtocol: null);
            using var socket = upgrade.WebSocket;
            AxonTLog.Info($"AxonT accepted WebSocket session {sessionId}.");

            await SendAsync(socket, writes, new BridgeGreeting { InstanceId = instanceId });
            await SendAsync(socket, writes, Session());

            // The agent must be told it left a world, not left to infer it from
            // the body stream going quiet.
            onSessionChanged = (state, at) => Detached(SendAsync(socket, writes, Session()), "session packet");
            ClientSession.Changed += onSessionChanged;

            Detached(SendBodyAsync(socket, writes), "body stream");

            while (socket.State == WebSocketState.Open && !stopping.IsCancellationRequested)
            {
                var text = await ReceiveTextAsync(socket, stopping.Token);
                if (text is null) break;

                string? kind;
                try { kind = JsonSerializer.Deserialize<PacketKind>(text, Json)?.Type; }
                catch (JsonException)
                {
                    AxonTLog.Warn("AxonT rejected malformed agent JSON.");
                    continue;
                }

                switch (kind)
                {
                    case "input-state":
                        HandleInput(sessionId, text);
                        break;

                    // Commands are awaited off the receive loop: a join takes
                    // seconds, and input must keep flowing while it runs.
                    case "command":
                        Detached(HandleCommandAsync(socket, writes, text), "command");
                        break;

                    default:
                        AxonTLog.Warn($"AxonT rejected an unexpected agent packet: {kind ?? "untyped"}.");
                        break;
                }
            }

            // We do not await the body stream: closing the socket and
            // cancellation naturally end its loop. A session's disconnect is an
            // immediate stop.
            input.Release(sessionId);
            if (socket.State == WebSocketState.Open)
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "AxonT session ended", CancellationToken.None);
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (WebSocketException error) { AxonTLog.Warn($"AxonT WebSocket ended: {error.Message}"); }
        catch (Exception error) { AxonTLog.Error("AxonT could not serve a WebSocket client.", error); }
        finally
        {
            // Unsubscribed here, not on the happy path: ClientSession.Changed is
            // static and outlives every session, so a handler left behind by a
            // throw fires on the next world unload holding a dead socket — one
            // leaked per session, for the life of the client.
            if (onSessionChanged is not null) ClientSession.Changed -= onSessionChanged;
            input.Release(sessionId);
            AxonTLog.Info($"AxonT WebSocket session {sessionId} disconnected; input neutralized.");
        }
    }

    private static SessionPacket Session() => new()
    {
        ObservedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        State = ClientSession.Describe(ClientSession.State),
        Endpoint = ClientSession.Endpoint,
    };

    private void HandleInput(string sessionId, string text)
    {
        InputStatePacket? packet;
        try { packet = JsonSerializer.Deserialize<InputStatePacket>(text, Json); }
        catch (JsonException) { AxonTLog.Warn("AxonT rejected malformed input JSON."); return; }

        if (packet?.Keys is null)
        {
            AxonTLog.Warn("AxonT rejected an input packet with no control state.");
            return;
        }

        var next = new LeasedInputState(
            packet.Keys.Left, packet.Keys.Right, packet.Keys.Up, packet.Keys.Down,
            packet.Keys.Jump, packet.Keys.UseItem, packet.Keys.UseTile
        );
        if (!input.TrySet(sessionId, packet.Sequence, packet.LeaseMs, next, out var rejection))
            AxonTLog.Warn($"AxonT rejected input from {sessionId}: {rejection}");
    }

    /**
     * Runs one effector command and answers it. Every failure is reported back
     * over the socket the agent is already listening on; the status file is a
     * boot-time fallback, not the protocol.
     */
    private async Task HandleCommandAsync(WebSocket socket, SemaphoreSlim writes, string text)
    {
        CommandPacket? command;
        try { command = JsonSerializer.Deserialize<CommandPacket>(text, Json); }
        catch (JsonException) { AxonTLog.Warn("AxonT rejected malformed command JSON."); return; }
        if (command is null || string.IsNullOrEmpty(command.Id)) return;

        var result = new CommandResultPacket { Id = command.Id, Command = command.Command };
        try
        {
            switch (command.Command)
            {
                case "join":
                    if (string.IsNullOrWhiteSpace(command.Host))
                        throw new ArgumentException("join requires a host.");
                    if (command.Port is < 1 or > 65535)
                        throw new ArgumentException($"join requires a valid port, got {command.Port}.");

                    result.Endpoint = await ClientSession.JoinAsync(
                        command.Host, command.Port, command.Password, command.Player
                    );
                    break;

                case "leave":
                    await ClientSession.LeaveAsync();
                    break;
                case "create-player":
                    result.Result = await ClientSession.CreatePlayerAsync(command.Player);
                    break;

                case "say":
                    result.Result = await Actions.SayAsync(command.Text);
                    break;

                case "pvp":
                    result.Result = (await Actions.SetPvpAsync(command.Enabled)).ToString();
                    break;

                case "team":
                    result.Result = (await Actions.SetTeamAsync(command.Number)).ToString();
                    break;

                case "select-slot":
                    result.Result = (await Actions.SelectSlotAsync(command.Number)).ToString();
                    break;

                case "status":
                    break;

                default:
                    throw new ArgumentException($"Unknown command: {command.Command}");
            }
            result.Ok = true;
        }
        catch (Exception error)
        {
            result.Ok = false;
            result.Error = error.Message;
            AxonTLog.Warn($"AxonT command '{command.Command}' failed: {error}");
        }

        result.State = ClientSession.Describe(ClientSession.State);
        result.Endpoint ??= ClientSession.Endpoint;
        await SendAsync(socket, writes, result);
    }

    /**
     * Ships the latest main-thread body snapshot at 20 Hz. This worker never
     * reads Terraria objects directly; BodySense owns that boundary.
     */
    private async Task SendBodyAsync(WebSocket socket, SemaphoreSlim writes)
    {
        long sequence = 0;
        try
        {
            while (socket.State == WebSocketState.Open && !stopping.IsCancellationRequested)
            {
                var sample = body.Read();
                if (sample.Available)
                {
                    await SendAsync(socket, writes, new BodyPacket
                    {
                        Sequence = ++sequence,
                        ObservedAt = sample.ObservedAt,
                        Values =
                        [
                            sample.HealthCurrent, sample.HealthMaximum,
                            sample.ManaCurrent, sample.ManaMaximum,
                            sample.BreathCurrent, sample.BreathMaximum,
                            sample.HungerCurrent, sample.HungerMaximum,
                            sample.ThirstCurrent, sample.ThirstMaximum,
                            sample.StaminaCurrent, sample.StaminaMaximum,
                            sample.PainCurrent, sample.PainMaximum,
                            sample.PositionX, sample.PositionY,
                            sample.VelocityHorizontal, sample.VelocityVertical,
                            sample.InertialX, sample.InertialY,
                        ],
                        Labels =
                        [
                            "health.current", "health.maximum",
                            "mana.current", "mana.maximum",
                            "breath.current", "breath.maximum",
                            "hunger.current", "hunger.maximum",
                            "thirst.current", "thirst.maximum",
                            "stamina.current", "stamina.maximum",
                            "pain.current", "pain.maximum",
                            // position.* and velocity.* are the lab's ANSWER KEY
                            // and are dropped at the bridge plugin's door.
                            // What the organism gets is the inertial reading.
                            "position.x", "position.y",
                            "velocity.horizontal", "velocity.vertical",
                            "imu.x", "imu.y",
                        ],
                        Units =
                        [
                            "hp", "hp", "mana", "mana", "breath", "breath",
                            "hunger", "hunger", "thirst", "thirst", "stamina", "stamina",
                            "pain", "pain",
                            "px", "px", "px/tick", "px/tick",
                            "px/tick2", "px/tick2",
                        ],
                    });
                }
                await Task.Delay(TimeSpan.FromMilliseconds(50), stopping.Token);
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (WebSocketException) { }
        catch (Exception error)
        {
            // Anything else ended the body stream for good. Nobody awaits this
            // task, so without this the agent keeps a live socket that simply
            // never carries its body again. Said, and the session dropped so
            // the agent sees it.
            AxonTLog.Error("AxonT body stream failed; closing the session.", error);
            socket.Abort();
        }
    }

    /**
     * Runs work nobody awaits, and says so when it fails.
     *
     * Three things here deliberately outlive their caller: the body stream, a
     * command that takes seconds, and the session packet an event handler
     * sends. `_ = task` on any of them turns a real failure into an unobserved
     * exception nobody ever sees. This is the honest form of "not awaited".
     */
    private static void Detached(Task task, string what)
    {
        _ = task.ContinueWith(
            finished => AxonTLog.Error($"AxonT {what} failed.", finished.Exception!),
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default
        );
    }

    private static async Task SendAsync(WebSocket socket, SemaphoreSlim writes, object packet)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(packet, Json));
        await writes.WaitAsync();
        try
        {
            if (socket.State == WebSocketState.Open)
                await socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        finally { writes.Release(); }
    }

    /** Commands are deliberately bounded; fragmented/oversized payloads are refused. */
    private static async Task<string?> ReceiveTextAsync(WebSocket socket, CancellationToken token)
    {
        var buffer = new byte[4096];
        var result = await socket.ReceiveAsync(buffer, token);
        if (result.MessageType == WebSocketMessageType.Close) return null;
        if (result.MessageType != WebSocketMessageType.Text || !result.EndOfMessage)
            throw new WebSocketException(WebSocketError.InvalidMessageType);

        return Encoding.UTF8.GetString(buffer, 0, result.Count);
    }

    internal void Stop()
    {
        if (stopped) return;
        stopped = true;
        input.Neutralize();
        stopping.Cancel();
        listener.Stop();
        listener.Close();
        Discovery.Remove();
        AxonTLog.Info("AxonT listener stopped; input neutralized.");
    }

    public void Dispose()
    {
        if (disposed) return;
        Stop();
        disposed = true;
        stopping.Dispose();
    }
}

internal static class AxonTLog
{
    internal static void Info(string message) => AxonT.ModInstance?.Logger.Info(message);
    internal static void Warn(string message) => AxonT.ModInstance?.Logger.Warn(message);
    internal static void Error(string message, Exception error) => AxonT.ModInstance?.Logger.Error(message, error);
}
