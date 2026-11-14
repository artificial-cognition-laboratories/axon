//! Joining a local unix connection to one QUIC stream, both directions, until each side ends.

use iroh::endpoint::{RecvStream, SendStream};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

/// Copy local→peer and peer→local concurrently. Each direction ends on its own EOF and
/// half-closes the other side, so a request/response exchange finishes cleanly.
pub async fn pipe<R, W>(mut local_read: R, mut local_write: W, mut send: SendStream, mut recv: RecvStream) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let outbound = async {
        tokio::io::copy(&mut local_read, &mut send).await.map_err(|e| format!("local→peer: {e}"))?;
        send.finish().map_err(|e| format!("finishing peer stream: {e}"))
    };
    let inbound = async {
        tokio::io::copy(&mut recv, &mut local_write).await.map_err(|e| format!("peer→local: {e}"))?;
        local_write.shutdown().await.map_err(|e| format!("closing local stream: {e}"))
    };
    let (a, b) = tokio::join!(outbound, inbound);
    a.and(b)
}
