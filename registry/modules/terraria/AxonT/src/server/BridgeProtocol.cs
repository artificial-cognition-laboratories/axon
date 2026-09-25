#nullable enable

namespace AxonT;

/** Just enough of any agent packet to route it; the family owns the rest. */
public sealed class PacketKind
{
    public string Type { get; set; } = "";
}

public sealed class BridgeGreeting
{
    public string Type { get; set; } = "bridge-ready";
    public int Protocol { get; set; } = AxonT.ProtocolVersion;
    public string InstanceId { get; set; } = "";
}

/**
 * One atomic interoceptive/proprioceptive sample. Values, labels, and units are
 * intentionally carried together: an agent must never guess a component's meaning
 * from a channel name.
 */
public sealed class BodyPacket
{
    public string Type { get; set; } = "body";
    public long Sequence { get; set; }
    public long ObservedAt { get; set; }
    public string Profile { get; set; } = "terraria.body.v0";
    public float[] Values { get; set; } = [];
    public string[] Labels { get; set; } = [];
    public string[] Units { get; set; } = [];
}

/** Wire representation of one full leased keyboard-equivalent state. */
public sealed class InputStatePacket
{
    public string Type { get; set; } = "";
    public long Sequence { get; set; }
    public int LeaseMs { get; set; }
    public InputKeys? Keys { get; set; }
}

public sealed class InputKeys
{
    public bool Left { get; set; }
    public bool Right { get; set; }
    public bool Up { get; set; }
    public bool Down { get; set; }
    public bool Jump { get; set; }
    public bool UseItem { get; set; }
    public bool UseTile { get; set; }
}

/**
 * An effector command. Joining a server is an action the agent takes, in the
 * same wire family as input: it is never inferred from startup environment.
 */
public sealed class CommandPacket
{
    public string Type { get; set; } = "";
    public string Id { get; set; } = "";
    public string Command { get; set; } = "";
    public string? Host { get; set; }
    public int Port { get; set; }
    public string? Password { get; set; }
    public string? Player { get; set; }
    public string? Text { get; set; }
    public bool Enabled { get; set; }
    public int Number { get; set; }
}

/** Correlated outcome of one command. Failure carries its reason, not a log line. */
public sealed class CommandResultPacket
{
    public string Type { get; set; } = "command-result";
    public string Id { get; set; } = "";
    public string Command { get; set; } = "";
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string State { get; set; } = "";
    public string? Endpoint { get; set; }
    /** Whatever the command produced, when it produced something. */
    public string? Result { get; set; }
}

/**
 * Where the client is. Sent on connect and on every transition so the agent can
 * perceive that it is not yet embodied, rather than inferring it from silence.
 */
public sealed class SessionPacket
{
    public string Type { get; set; } = "session";
    public long ObservedAt { get; set; }
    public string State { get; set; } = "";
    public string? Endpoint { get; set; }
}
