//! Two real sidecars, offline, dialing each other over loopback. The "daemon" on the
//! receiving machine is a plain listener on its `remote.sock` that answers with what it
//! was told — enough to prove the pipe, the verified caller and the failure paths.

use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
};

struct Machine {
    root: PathBuf,
    sidecar: Child,
}

impl Machine {
    fn boot(name: &str) -> Machine {
        let root = std::env::temp_dir().join(format!("axn-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let seed: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(31).wrapping_add(name.len() as u8 * 7 + name.as_bytes()[0]));
        std::fs::write(root.join("machine.key"), seed).unwrap();
        let sidecar = Command::new(env!("CARGO_BIN_EXE_axon-net"))
            .args(["serve", "--mode", "offline", "--dial-timeout", "1000", "--key"])
            .arg(root.join("machine.key"))
            .arg("--root")
            .arg(&root)
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !root.join("net.sock").exists() {
            assert!(started.elapsed() < Duration::from_secs(10), "{name}: sidecar never listened");
            std::thread::sleep(Duration::from_millis(20));
        }
        Machine { root, sidecar }
    }

    fn net(&self) -> PathBuf {
        self.root.join("net.sock")
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        let _ = self.sidecar.kill();
        let _ = self.sidecar.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// One header line out, one line back, then the connection is the stream.
async fn ask(socket: &Path, header: Value) -> (Value, BufReader<UnixStream>) {
    let mut stream = UnixStream::connect(socket).await.unwrap();
    stream.write_all(format!("{header}\n").as_bytes()).await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    (serde_json::from_str(&line).unwrap(), reader)
}

/// The receiving daemon: answer each stream with its header and the request it carried.
fn daemon(root: &Path) {
    let listener = UnixListener::bind(root.join("remote.sock")).unwrap();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stream);
                let mut header = String::new();
                reader.read_line(&mut header).await.unwrap();
                let mut request = String::new();
                reader.read_to_string(&mut request).await.unwrap();
                let mut stream = reader.into_inner();
                let answer = serde_json::json!({ "header": serde_json::from_str::<Value>(&header).unwrap(), "request": request });
                stream.write_all(answer.to_string().as_bytes()).await.unwrap();
                stream.shutdown().await.unwrap();
            });
        }
    });
}

#[tokio::test]
async fn a_request_crosses_to_another_machine_naming_its_verified_caller() {
    let laptop = Machine::boot("laptop");
    let homelab = Machine::boot("homelab");
    daemon(&homelab.root);

    let (me, _) = ask(&laptop.net(), serde_json::json!({ "status": true })).await;
    let (them, _) = ask(&homelab.net(), serde_json::json!({ "status": true })).await;
    assert_eq!(them["relay"], false, "offline mode must not use a relay");

    let (dialed, mut stream) = ask(&laptop.net(), serde_json::json!({ "dial": them["id"], "addrs": them["addrs"] })).await;
    assert_eq!(dialed, serde_json::json!({ "ok": true, "path": "direct" }));

    stream.get_mut().write_all(br#"{"path":["machine","state"]}"#).await.unwrap();
    stream.get_mut().shutdown().await.unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    let answer: Value = serde_json::from_str(&answer).unwrap();

    assert_eq!(answer["header"]["from"], me["id"], "the receiver is told who called, proven by the handshake");
    assert_eq!(answer["request"], r#"{"path":["machine","state"]}"#);
}

#[tokio::test]
async fn an_unreachable_machine_fails_fast_with_a_code() {
    let laptop = Machine::boot("lonely");
    // A real key whose machine is not running: boot one, read its id, stop it.
    let gone = Machine::boot("gone");
    let (them, _) = ask(&gone.net(), serde_json::json!({ "status": true })).await;
    drop(gone);
    let started = Instant::now();

    let (dialed, _) = ask(&laptop.net(), serde_json::json!({ "dial": them["id"], "addrs": them["addrs"] })).await;

    assert_eq!(dialed["ok"], false);
    assert_eq!(dialed["fault"]["code"], "NET_UNREACHABLE", "{dialed}");
    assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
}

#[tokio::test]
async fn a_key_that_is_not_a_key_is_a_protocol_fault() {
    let laptop = Machine::boot("pedant");

    let (dialed, _) = ask(&laptop.net(), serde_json::json!({ "dial": "0b84f0b5d0e9d8e3c6a1f6b4e2d7c9a8b3f1e6d5c4a2b9e8f7d6c5b4a3f2e1d0" })).await;

    assert_eq!(dialed["fault"]["code"], "NET_PROTOCOL", "{dialed}");
}

#[tokio::test]
async fn a_malformed_header_is_refused_not_ignored() {
    let laptop = Machine::boot("strict");

    let (answer, _) = ask(&laptop.net(), serde_json::json!({ "hello": "world" })).await;

    assert_eq!(answer["ok"], false);
    assert_eq!(answer["fault"]["code"], "NET_PROTOCOL");
}

#[tokio::test]
async fn a_machine_whose_daemon_is_down_ends_the_stream_rather_than_hanging() {
    let laptop = Machine::boot("caller");
    let homelab = Machine::boot("daemonless");

    let (them, _) = ask(&homelab.net(), serde_json::json!({ "status": true })).await;
    let (dialed, mut stream) = ask(&laptop.net(), serde_json::json!({ "dial": them["id"], "addrs": them["addrs"] })).await;
    assert_eq!(dialed["ok"], true);

    stream.get_mut().write_all(b"{}").await.unwrap();
    stream.get_mut().shutdown().await.unwrap();
    let mut answer = String::new();
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut answer)).await;

    assert!(read.is_ok(), "the stream must end when the far daemon is not listening");
    assert_eq!(answer, "", "and carry nothing that could be mistaken for an answer");
}
