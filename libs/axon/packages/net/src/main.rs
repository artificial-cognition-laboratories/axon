//! axon-net — the machine network's transport sidecar.
//!
//! The daemon runs one beside itself. It holds the machine's iroh endpoint and does two
//! things: on `net.sock` it opens streams to other machines by key, and for every stream
//! another machine opens it connects to the daemon's `remote.sock`, naming the verified
//! caller. It knows keys, connections and bytes. What a request means, and whether the
//! caller may make it, is the daemon's alone.

mod endpoint;
mod inbound;
mod log;
mod outbound;
mod pipe;
mod wire;

use std::{os::unix::fs::PermissionsExt, path::PathBuf};

use clap::Parser;
use iroh::protocol::Router;
use serde_json::json;
use tokio::net::UnixListener;

#[derive(Parser)]
#[command(name = "axon-net", version)]
enum Cli {
    /// Serve this machine on the network until stopped.
    Serve {
        /// The machine key: a 32-byte Ed25519 seed the daemon wrote.
        #[arg(long)]
        key: PathBuf,
        /// The daemon's root: `net.sock` is created here, `remote.sock` is expected here.
        #[arg(long)]
        root: PathBuf,
        #[arg(long, value_enum, default_value = "n0")]
        mode: endpoint::Mode,
        /// Milliseconds a dial may take before the machine is reported unreachable.
        #[arg(long, default_value_t = 5000)]
        dial_timeout: u64,
    },
}

#[tokio::main]
async fn main() {
    let Cli::Serve { key, root, mode, dial_timeout } = Cli::parse();
    if let Err(message) = serve(key, root, mode, std::time::Duration::from_millis(dial_timeout)).await {
        log::event("fatal", json!({ "message": message }));
        std::process::exit(1);
    }
}

async fn serve(key: PathBuf, root: PathBuf, mode: endpoint::Mode, dial_timeout: std::time::Duration) -> Result<(), String> {
    let endpoint = endpoint::bind(endpoint::key(&key)?, mode).await?;
    if matches!(mode, endpoint::Mode::N0) {
        endpoint.online().await;
    }
    let router = Router::builder(endpoint.clone())
        .accept(endpoint::ALPN, inbound::Inbound { daemon: root.join("remote.sock") })
        .spawn();
    let socket = root.join("net.sock");
    let listening = tokio::spawn(outbound::listen(endpoint.clone(), socket.clone(), dial_timeout));
    log::event("ready", json!({ "id": endpoint.id().to_string(), "socket": socket }));

    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| format!("signal: {e}"))?;
    let outcome = tokio::select! {
        _ = tokio::signal::ctrl_c() => Ok(()),
        _ = terminate.recv() => Ok(()),
        ended = listening => match ended {
            Ok(result) => result,
            Err(e) => Err(format!("net.sock listener panicked: {e}")),
        },
    };
    // Graceful close tells live peers we are going; it also waits out any dial still in
    // flight, which can take seconds. The daemon asked us to stop — bound it, and say so.
    match tokio::time::timeout(std::time::Duration::from_millis(500), router.shutdown()).await {
        Ok(closed) => closed.map_err(|e| format!("shutdown: {e}"))?,
        Err(_) => log::event("shutdown.forced", json!({ "after_ms": 500 })),
    }
    let _ = std::fs::remove_file(&socket);
    outcome
}

/// A unix listener only this user can reach. A stale socket from a killed process is
/// removed first — the daemon has already established no live sidecar owns it.
pub fn bind_private(path: &std::path::Path) -> Result<UnixListener, String> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("removing stale {}: {e}", path.display()))?;
    }
    let listener = UnixListener::bind(path).map_err(|e| format!("binding {}: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("securing {}: {e}", path.display()))?;
    Ok(listener)
}
