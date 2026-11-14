//! The header lines on the two local sockets — the whole of the sidecar's protocol with
//! the daemon. After a header, a connection carries the peer's bytes unchanged.

use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

/// What the daemon asks on `net.sock`, in the first line of a connection.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Ask {
    /// Open a stream to the machine with this key; `addrs` are direct addresses to try first.
    Dial {
        dial: String,
        #[serde(default)]
        addrs: Vec<SocketAddr>,
    },
    /// Report this endpoint: its key, its direct addresses, whether it is on a relay.
    Status { status: bool },
}

/// How a stream reached its peer, as far as this side can see.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Path {
    Direct,
    Relay,
}

/// The sidecar's answer to `Ask::Dial`, before any peer bytes.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Dialed {
    Ok { ok: bool, path: Path },
    Failed { ok: bool, fault: Fault },
}

/// A failure with a code the daemon maps into its error map.
#[derive(Debug, Serialize)]
pub struct Fault {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct Status {
    pub id: String,
    pub addrs: Vec<SocketAddr>,
    pub relay: bool,
}

/// What the sidecar tells the daemon on `remote.sock`, before an inbound peer's bytes.
#[derive(Debug, Serialize)]
pub struct From {
    /// The caller's key, proven by the QUIC handshake.
    pub from: String,
    pub path: Path,
}

impl Dialed {
    pub fn ok(path: Path) -> Self {
        Dialed::Ok { ok: true, path }
    }
    pub fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Dialed::Failed { ok: false, fault: Fault { code, message: message.into() } }
    }
}
