//! `net.sock` — where the daemon asks for streams to other machines, and for status.

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use iroh::{endpoint::Connection, Endpoint, EndpointAddr, EndpointId, TransportAddr};
use serde_json::json;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{unix::{OwnedReadHalf, OwnedWriteHalf}, UnixStream},
    sync::Mutex,
};

use crate::{
    endpoint::ALPN,
    log,
    pipe::pipe,
    wire::{Ask, Dialed, Path, Status},
};

/// Connections to peers, one per machine, reused across streams until they close.
type Peers = Arc<Mutex<HashMap<EndpointId, Connection>>>;

/// `dial_timeout`: how long a dial may take before the machine is reported unreachable.
/// Short on purpose — iroh's own limit is 30s, far too long for a person waiting on a list.
pub async fn listen(endpoint: Endpoint, socket: PathBuf, dial_timeout: Duration) -> Result<(), String> {
    let listener = crate::bind_private(&socket)?;
    let peers: Peers = Arc::default();
    loop {
        let (local, _) = listener.accept().await.map_err(|e| format!("net.sock accept: {e}"))?;
        let endpoint = endpoint.clone();
        let peers = peers.clone();
        tokio::spawn(async move {
            if let Err(message) = serve(endpoint, peers, local, dial_timeout).await {
                log::event("local.failed", json!({ "message": message }));
            }
        });
    }
}

async fn serve(endpoint: Endpoint, peers: Peers, local: UnixStream, dial_timeout: Duration) -> Result<(), String> {
    let (read, mut write) = local.into_split();
    let mut read = BufReader::new(read);
    let mut header = String::new();
    read.read_line(&mut header).await.map_err(|e| format!("reading header: {e}"))?;

    match serde_json::from_str::<Ask>(&header) {
        Ok(Ask::Status { status: true }) => finish(&mut read, write, &status(&endpoint)).await,
        Ok(Ask::Status { status: false }) => finish(&mut read, write, &Dialed::failed("NET_PROTOCOL", "status must be true")).await,
        Ok(Ask::Dial { dial, addrs }) => {
            let id: EndpointId = match dial.parse() {
                Ok(id) => id,
                Err(e) => return finish(&mut read, write, &Dialed::failed("NET_PROTOCOL", format!("not a machine key: {dial} ({e})"))).await,
            };
            let conn = match connect(&endpoint, &peers, id, addrs, dial_timeout).await {
                Ok(conn) => conn,
                Err(message) => {
                    log::event("dial.failed", json!({ "peer": id.to_string(), "message": message }));
                    return finish(&mut read, write, &Dialed::failed("NET_UNREACHABLE", message)).await;
                }
            };
            let (send, recv) = conn.open_bi().await.map_err(|e| format!("opening stream: {e}"))?;
            reply(&mut write, &Dialed::ok(path(&conn))).await?;
            pipe(read, write, send, recv).await
        }
        Err(e) => finish(&mut read, write, &Dialed::failed("NET_PROTOCOL", format!("unreadable header: {e}"))).await,
    }
}

/// A live connection to `id`, reused when one is open, dialed (with address hints) when not.
async fn connect(endpoint: &Endpoint, peers: &Peers, id: EndpointId, addrs: Vec<std::net::SocketAddr>, dial_timeout: Duration) -> Result<Connection, String> {
    let mut peers = peers.lock().await;
    if let Some(conn) = peers.get(&id) {
        if conn.close_reason().is_none() {
            return Ok(conn.clone());
        }
    }
    let target = EndpointAddr::from_parts(id, addrs.into_iter().map(TransportAddr::Ip));
    let conn = tokio::time::timeout(dial_timeout, endpoint.connect(target, ALPN))
        .await
        .map_err(|_| format!("no answer from {} within {}ms", id.fmt_short(), dial_timeout.as_millis()))?
        .map_err(|e| format!("could not reach {}: {e}", id.fmt_short()))?;
    log::event("connected", json!({ "peer": id.to_string(), "path": path(&conn) }));
    peers.insert(id, conn.clone());
    Ok(conn)
}

pub fn path(conn: &Connection) -> Path {
    match conn.paths().iter().find(|p| p.is_selected()) {
        Some(p) if p.is_relay() => Path::Relay,
        _ => Path::Direct,
    }
}

fn status(endpoint: &Endpoint) -> Status {
    let addr = endpoint.addr();
    let relay = addr.relay_urls().next().is_some();
    Status {
        id: endpoint.id().to_string(),
        addrs: addr.ip_addrs().copied().collect(),
        relay,
    }
}

async fn reply(write: &mut OwnedWriteHalf, value: &impl serde::Serialize) -> Result<(), String> {
    let mut line = serde_json::to_vec(value).map_err(|e| format!("encoding reply: {e}"))?;
    line.push(b'\n');
    write.write_all(&line).await.map_err(|e| format!("writing reply: {e}"))
}

/// A final answer — status, or a failure — then an orderly close. What the daemon already
/// sent after its header (a request body that will never be delivered) is drained first:
/// closing a unix socket with unread bytes resets it, and the daemon would lose the answer.
async fn finish(read: &mut BufReader<OwnedReadHalf>, mut write: OwnedWriteHalf, value: &impl serde::Serialize) -> Result<(), String> {
    reply(&mut write, value).await?;
    write.shutdown().await.map_err(|e| format!("closing: {e}"))?;
    tokio::io::copy(read, &mut tokio::io::sink()).await.map_err(|e| format!("draining: {e}"))?;
    Ok(())
}
