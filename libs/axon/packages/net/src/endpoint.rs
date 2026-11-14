//! The iroh endpoint, bound to the machine's key.

use std::path::Path as FsPath;

use iroh::{endpoint::presets, Endpoint, RelayMode, SecretKey};

/// Where the endpoint finds peers.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum Mode {
    /// n0's relays and discovery: dial any machine by key, anywhere.
    N0,
    /// No relay, no discovery: direct addresses only. Tests, and machines on one network.
    Offline,
}

/// The protocol both ends must speak; a mismatch aborts the handshake.
pub const ALPN: &[u8] = b"axon/machine/1";

/// The machine key, written by the daemon. Read, never created: identity is the daemon's.
pub fn key(path: &FsPath) -> Result<SecretKey, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("machine key unreadable at {}: {e}", path.display()))?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|b: Vec<u8>| format!("machine key at {} is {} bytes, expected 32", path.display(), b.len()))?;
    Ok(SecretKey::from_bytes(&seed))
}

pub async fn bind(key: SecretKey, mode: Mode) -> Result<Endpoint, String> {
    let builder = match mode {
        Mode::N0 => Endpoint::builder(presets::N0),
        Mode::Offline => Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled),
    };
    builder
        .secret_key(key)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| format!("endpoint did not bind: {e}"))
}
