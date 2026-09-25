#nullable enable

using System;
using System.IO;
using System.Text.Json;

namespace AxonT;

/** Writes public, local endpoint metadata. It intentionally contains no token. */
internal static class Discovery
{
    internal static string PathForCurrentUser()
    {
        var configured = Environment.GetEnvironmentVariable("AXONT_DISCOVERY_PATH");
        if (!string.IsNullOrWhiteSpace(configured))
            return configured;

        var home = Environment.GetEnvironmentVariable("HOME");
        if (string.IsNullOrWhiteSpace(home))
            throw new InvalidOperationException("AxonT needs HOME to write discovery metadata.");

        return System.IO.Path.Combine(
            home,
            ".local",
            "state",
            "terry",
            "terraria-bridge.json"
        );
    }

    internal static void Write(int port, string instanceId)
    {
        var path = PathForCurrentUser();
        var directory = System.IO.Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException("Discovery path has no parent directory.");

        Directory.CreateDirectory(directory);

        var discovery = new
        {
            protocol = AxonT.ProtocolVersion,
            instanceId,
            endpoint = $"ws://127.0.0.1:{port}/bridge",
        };

        File.WriteAllText(path, JsonSerializer.Serialize(discovery, new JsonSerializerOptions
        {
            WriteIndented = true,
        }) + Environment.NewLine);
    }

    internal static void Status(string state, string? detail = null, string? error = null)
    {
        var path = Environment.GetEnvironmentVariable("AXONT_STATUS_PATH");
        if (string.IsNullOrWhiteSpace(path))
            path = System.IO.Path.Combine(
                System.IO.Path.GetDirectoryName(PathForCurrentUser()) ?? ".",
                "status.json"
            );

        var directory = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
            Directory.CreateDirectory(directory);

        var status = new
        {
            instanceId = Environment.GetEnvironmentVariable("AXONT_INSTANCE_ID") ?? "unknown",
            state,
            detail,
            error,
            at = DateTimeOffset.UtcNow.ToString("O"),
        };
        File.WriteAllText(path, JsonSerializer.Serialize(status, new JsonSerializerOptions
        {
            WriteIndented = true,
        }) + Environment.NewLine);
    }

    internal static void Remove()
    {
        var path = PathForCurrentUser();
        if (File.Exists(path))
            File.Delete(path);
    }
}
