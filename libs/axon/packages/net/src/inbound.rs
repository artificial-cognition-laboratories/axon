//! Streams from other machines, handed to the daemon on `remote.sock` with the caller's
//! verified key. Whether the caller may do anything is the daemon's decision, not this one.

use std::path::PathBuf;

use iroh::{
    endpoint::Connection,
    protocol::{AcceptError, ProtocolHandler},
};
use serde_json::json;
use tokio::{io::AsyncWriteExt, net::UnixStream};

use crate::{log, outbound::path, pipe::pipe, wire::From};

#[derive(Debug, Clone)]
pub struct Inbound {
    /// The daemon's `remote.sock`.
    pub daemon: PathBuf,
}

impl ProtocolHandler for Inbound {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let peer = conn.remote_id();
        log::event("accepted", json!({ "peer": peer.to_string(), "path": path(&conn) }));
        while let Ok((send, recv)) = conn.accept_bi().await {
            let daemon = self.daemon.clone();
            let header = From { from: peer.to_string(), path: path(&conn) };
            tokio::spawn(async move {
                if let Err(message) = hand(daemon, header, send, recv).await {
                    log::event("inbound.failed", json!({ "peer": peer.to_string(), "message": message }));
                }
            });
        }
        Ok(())
    }
}

/// One inbound stream, onto one daemon connection. If the daemon is not listening the
/// stream is reset, so the caller sees a failure rather than a silence.
async fn hand(daemon: PathBuf, header: From, mut send: iroh::endpoint::SendStream, recv: iroh::endpoint::RecvStream) -> Result<(), String> {
    let local = match UnixStream::connect(&daemon).await {
        Ok(local) => local,
        Err(e) => {
            let _ = send.reset(1u32.into());
            return Err(format!("daemon not listening on {}: {e}", daemon.display()));
        }
    };
    let (read, mut write) = local.into_split();
    let mut line = serde_json::to_vec(&header).map_err(|e| format!("encoding header: {e}"))?;
    line.push(b'\n');
    write.write_all(&line).await.map_err(|e| format!("writing header: {e}"))?;
    pipe(read, write, send, recv).await
}
