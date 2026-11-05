use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_CONNECTIONS: usize = 256;
const MAX_PROCESS_NAME: usize = 128;
const COOLDOWN: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    id: String,
    process_name: Option<String>,
    pid: Option<u32>,
    local_address: String,
    local_port: u16,
    remote_address: String,
    remote_port: u16,
    state: &'static str,
    loopback: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    connections: Vec<Connection>,
    total: usize,
    truncated: bool,
    sampled_at: u64,
    partial: bool,
}

type SnapshotResult = Result<Snapshot, String>;
type NativeResult = Result<(Vec<Result<RawConnection, ()>>, bool), String>;

struct Cached {
    completed_at: Instant,
    result: SnapshotResult,
}

impl Cached {
    fn fresh(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.completed_at) < COOLDOWN
    }
}

#[derive(Default)]
pub struct ConnectionsState(Arc<tokio::sync::Mutex<Option<Cached>>>);

impl ConnectionsState {
    async fn snapshot_with<F>(&self, collect: F) -> SnapshotResult
    where
        F: FnOnce() -> SnapshotResult + Send + 'static,
    {
        let mut cache = self.0.clone().lock_owned().await;
        if let Some(cached) = cache.as_ref().filter(|cached| cached.fresh(Instant::now())) {
            return cached.result.clone();
        }
        // The worker owns the guard: a dropped IPC future cannot trigger a second scan.
        tauri::async_runtime::spawn_blocking(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(collect))
                .unwrap_or_else(|_| Err("TCP connection collection failed".into()));
            *cache = Some(Cached {
                completed_at: Instant::now(),
                result: result.clone(),
            });
            result
        })
        .await
        .map_err(|_| "TCP connection worker failed".to_owned())?
    }
}

#[tauri::command]
pub async fn network_connections(state: tauri::State<'_, ConnectionsState>) -> SnapshotResult {
    state.snapshot_with(collect_snapshot).await
}

#[derive(Clone)]
struct RawConnection {
    pid: Option<u32>,
    local: SocketAddr,
    remote: SocketAddr,
    state: &'static str,
}

fn is_loopback(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => address.is_loopback(),
        IpAddr::V6(address) => {
            address.is_loopback() || address.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback())
        }
    }
}

fn state_priority(state: &str) -> u8 {
    match state {
        "ESTABLISHED" => 0,
        "SYN_SENT" => 1,
        "SYN_RECEIVED" => 2,
        "CLOSE_WAIT" => 3,
        "FIN_WAIT_1" => 4,
        "FIN_WAIT_2" => 5,
        "CLOSING" => 6,
        "LAST_ACK" => 7,
        "TIME_WAIT" => 8,
        "DELETE_TCB" => 9,
        _ => 10,
    }
}

fn normalize(
    entries: impl IntoIterator<Item = Result<RawConnection, ()>>,
    sampled_at: u64,
    mut partial: bool,
) -> Snapshot {
    let mut rows = Vec::new();
    for entry in entries {
        let raw = match entry {
            Ok(raw) => raw,
            Err(()) => {
                partial = true;
                continue;
            }
        };
        if raw.remote.port() == 0 || matches!(raw.state, "LISTEN" | "CLOSED") {
            continue;
        }
        let pid = raw.pid.filter(|pid| *pid != 0);
        partial |= pid.is_none() || raw.state == "UNKNOWN";
        rows.push(Connection {
            id: format!(
                "tcp:{}>{}:{}",
                raw.local,
                raw.remote,
                pid.map_or_else(|| "?".into(), |pid| pid.to_string())
            ),
            process_name: None,
            pid,
            local_address: raw.local.ip().to_string(),
            local_port: raw.local.port(),
            remote_address: raw.remote.ip().to_string(),
            remote_port: raw.remote.port(),
            state: raw.state,
            loopback: is_loopback(raw.remote.ip()) || is_loopback(raw.local.ip()),
        });
    }
    // Shared descriptors can repeat a socket; state changes must not change its identity.
    rows.sort_unstable_by(|a, b| {
        a.id.cmp(&b.id)
            .then(state_priority(a.state).cmp(&state_priority(b.state)))
    });
    rows.dedup_by(|a, b| a.id == b.id);
    rows.sort_unstable_by(|a, b| {
        a.loopback
            .cmp(&b.loopback)
            .then(state_priority(a.state).cmp(&state_priority(b.state)))
            .then(a.id.cmp(&b.id))
    });
    let total = rows.len();
    rows.truncate(MAX_CONNECTIONS);
    Snapshot {
        connections: rows,
        total,
        truncated: total > MAX_CONNECTIONS,
        sampled_at,
        partial,
    }
}

fn selected_pids(snapshot: &Snapshot) -> Vec<u32> {
    snapshot
        .connections
        .iter()
        .filter_map(|row| row.pid)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn apply_process_names(snapshot: &mut Snapshot, names: &HashMap<u32, String>) {
    for row in &mut snapshot.connections {
        row.process_name = row.pid.and_then(|pid| names.get(&pid)).and_then(|name| {
            let name: String = name
                .chars()
                .filter(|character| !character.is_control())
                .take(MAX_PROCESS_NAME)
                .collect();
            (!name.is_empty()).then_some(name)
        });
        snapshot.partial |= row.process_name.is_none();
    }
}

#[cfg(not(target_os = "macos"))]
fn process_names(pids: &[u32]) -> HashMap<u32, String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    let pids: Vec<_> = pids.iter().copied().map(Pid::from_u32).collect();
    let mut system = System::new();
    if !pids.is_empty() {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
    }
    system
        .processes()
        .iter()
        .map(|(pid, process)| (pid.as_u32(), process.name().to_string_lossy().into_owned()))
        .collect()
}

#[cfg(target_os = "macos")]
fn process_names(pids: &[u32]) -> HashMap<u32, String> {
    // sysinfo's macOS refresh reads KERN_PROCARGS2 even with cmd/environ disabled.
    pids.iter()
        .filter_map(|pid| {
            let name = libproc::libproc::proc_pid::name(i32::try_from(*pid).ok()?).ok()?;
            Some((*pid, name))
        })
        .collect()
}

fn collect_snapshot() -> SnapshotResult {
    let sampled_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is before the Unix epoch".to_owned())?
        .as_millis() as u64;
    let (entries, partial) = native::collect()?;
    let mut snapshot = normalize(entries, sampled_at, partial);
    let names = process_names(&selected_pids(&snapshot));
    apply_process_names(&mut snapshot, &names);
    Ok(snapshot)
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
mod native {
    use super::*;
    use netstat2::{AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState};

    fn state_name(state: TcpState) -> &'static str {
        match state {
            TcpState::Closed => "CLOSED",
            TcpState::Listen => "LISTEN",
            TcpState::SynSent => "SYN_SENT",
            TcpState::SynReceived => "SYN_RECEIVED",
            TcpState::Established => "ESTABLISHED",
            TcpState::FinWait1 => "FIN_WAIT_1",
            TcpState::FinWait2 => "FIN_WAIT_2",
            TcpState::CloseWait => "CLOSE_WAIT",
            TcpState::Closing => "CLOSING",
            TcpState::LastAck => "LAST_ACK",
            TcpState::TimeWait => "TIME_WAIT",
            TcpState::DeleteTcb => "DELETE_TCB",
            TcpState::Unknown => "UNKNOWN",
        }
    }

    pub(super) fn collect() -> NativeResult {
        #[cfg(target_os = "linux")]
        std::fs::read_dir("/proc").map_err(|_| "Cannot read the process table".to_owned())?;
        let sockets = netstat2::iterate_sockets_info(
            AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6,
            ProtocolFlags::TCP,
        )
        .map_err(|error| format!("Cannot read TCP connections: {error}"))?;
        let mut entries = Vec::new();
        let mut errors = 0;
        for socket in sockets {
            let socket = match socket {
                Ok(socket) => socket,
                Err(_) => {
                    entries.push(Err(()));
                    errors += 1;
                    // netstat2 can yield the same netlink receive failure repeatedly.
                    if errors >= 32 {
                        break;
                    }
                    continue;
                }
            };
            if let ProtocolSocketInfo::Tcp(tcp) = socket.protocol_socket_info {
                let pids = if socket.associated_pids.is_empty() {
                    vec![None]
                } else {
                    socket.associated_pids.into_iter().map(Some).collect()
                };
                for pid in pids {
                    entries.push(Ok(RawConnection {
                        pid,
                        local: SocketAddr::new(tcp.local_addr, tcp.local_port),
                        remote: SocketAddr::new(tcp.remote_addr, tcp.remote_port),
                        state: state_name(tcp.state),
                    }));
                }
            }
        }
        // Linux's PID attachment silently skips inaccessible /proc entries.
        Ok((entries, cfg!(target_os = "linux")))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn maps_native_states_without_display_aliases() {
            assert_eq!(state_name(TcpState::SynReceived), "SYN_RECEIVED");
            assert_eq!(state_name(TcpState::FinWait1), "FIN_WAIT_1");
            assert_eq!(state_name(TcpState::FinWait2), "FIN_WAIT_2");
            assert_eq!(state_name(TcpState::CloseWait), "CLOSE_WAIT");
            assert_eq!(state_name(TcpState::Unknown), "UNKNOWN");
        }
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use libproc::libproc::net_info::{InSIAddr, SocketFDInfo};
    use std::mem::size_of;
    use std::net::{Ipv4Addr, Ipv6Addr};

    const MAX_PIDS: usize = 131_072;
    const MAX_FDS: usize = 65_536;

    fn state_name(state: i32) -> &'static str {
        match state {
            0 => "CLOSED",
            1 => "LISTEN",
            2 => "SYN_SENT",
            3 => "SYN_RECEIVED",
            4 => "ESTABLISHED",
            5 => "CLOSE_WAIT",
            6 => "FIN_WAIT_1",
            7 => "CLOSING",
            8 => "LAST_ACK",
            9 => "FIN_WAIT_2",
            10 => "TIME_WAIT",
            _ => "UNKNOWN",
        }
    }

    fn address(value: InSIAddr, family: i32) -> IpAddr {
        // The caller validates the socket family before reading these union members.
        unsafe {
            if family == libc::AF_INET {
                IpAddr::V4(Ipv4Addr::from(value.ina_46.i46a_addr4.s_addr.to_ne_bytes()))
            } else {
                IpAddr::V6(Ipv6Addr::from(value.ina_6.s6_addr))
            }
        }
    }

    fn decode(info: SocketFDInfo, pid: u32) -> Option<RawConnection> {
        if info.psi.soi_kind != 2
            || info.psi.soi_protocol != libc::IPPROTO_TCP
            || !matches!(info.psi.soi_family, libc::AF_INET | libc::AF_INET6)
        {
            return None;
        }
        // soi_kind == SOCKINFO_TCP selects the initialized TCP member.
        let tcp = unsafe { info.psi.soi_proto.pri_tcp };
        Some(RawConnection {
            pid: Some(pid),
            local: SocketAddr::new(
                address(tcp.tcpsi_ini.insi_laddr, info.psi.soi_family),
                u16::from_be(tcp.tcpsi_ini.insi_lport as u16),
            ),
            remote: SocketAddr::new(
                address(tcp.tcpsi_ini.insi_faddr, info.psi.soi_family),
                u16::from_be(tcp.tcpsi_ini.insi_fport as u16),
            ),
            state: state_name(tcp.tcpsi_state),
        })
    }

    pub(super) fn collect() -> NativeResult {
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return Err("Cannot read the process table".into());
        }
        let mut partial = false;
        let capacity = (count as usize).saturating_add(256).min(MAX_PIDS);
        let mut pids = vec![0i32; capacity];
        let count = unsafe {
            libc::proc_listallpids(
                pids.as_mut_ptr().cast(),
                (pids.len() * size_of::<i32>()) as i32,
            )
        };
        if count <= 0 {
            return Err("Cannot read the process table".into());
        }
        partial |= count as usize >= pids.len();
        pids.truncate(count as usize);
        let mut entries = Vec::new();
        for pid in pids.into_iter().filter(|pid| *pid > 0) {
            let size = unsafe {
                libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0)
            };
            if size <= 0 {
                partial = true;
                continue;
            }
            let capacity = (size as usize / size_of::<libc::proc_fdinfo>())
                .saturating_add(32)
                .min(MAX_FDS);
            let mut fds = vec![
                libc::proc_fdinfo {
                    proc_fd: 0,
                    proc_fdtype: 0
                };
                capacity
            ];
            let size = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDLISTFDS,
                    0,
                    fds.as_mut_ptr().cast(),
                    (fds.len() * size_of::<libc::proc_fdinfo>()) as i32,
                )
            };
            if size <= 0 {
                partial = true;
                continue;
            }
            partial |= size as usize >= fds.len() * size_of::<libc::proc_fdinfo>();
            let count = size as usize / size_of::<libc::proc_fdinfo>();
            for fd in fds.into_iter().take(count).filter(|fd| fd.proc_fdtype == 2) {
                // Unlike netstat2's macOS path, zero/short reads never reach a union read.
                let mut info = std::mem::MaybeUninit::<SocketFDInfo>::zeroed();
                let read = unsafe {
                    libc::proc_pidfdinfo(
                        pid,
                        fd.proc_fd,
                        libproc::libproc::file_info::PIDFDInfoFlavor::SocketInfo as i32,
                        info.as_mut_ptr().cast(),
                        size_of::<SocketFDInfo>() as i32,
                    )
                };
                if read as usize != size_of::<SocketFDInfo>() {
                    entries.push(Err(()));
                    continue;
                }
                if let Some(row) = decode(unsafe { info.assume_init() }, pid as u32) {
                    entries.push(Ok(row));
                }
            }
        }
        Ok((entries, partial))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn maps_darwin_states_and_decodes_ipv6_network_order_ports() {
            let expected = [
                "CLOSED",
                "LISTEN",
                "SYN_SENT",
                "SYN_RECEIVED",
                "ESTABLISHED",
                "CLOSE_WAIT",
                "FIN_WAIT_1",
                "CLOSING",
                "LAST_ACK",
                "FIN_WAIT_2",
                "TIME_WAIT",
            ];
            for (value, name) in expected.iter().enumerate() {
                assert_eq!(state_name(value as i32), *name);
            }
            assert_eq!(state_name(99), "UNKNOWN");
            let mut info = SocketFDInfo::default();
            info.psi.soi_kind = 2;
            info.psi.soi_protocol = libc::IPPROTO_TCP;
            info.psi.soi_family = libc::AF_INET6;
            let mut tcp = libproc::libproc::net_info::TcpSockInfo {
                tcpsi_state: 4,
                ..Default::default()
            };
            tcp.tcpsi_ini.insi_lport = 43210u16.to_be() as i32;
            tcp.tcpsi_ini.insi_fport = 443u16.to_be() as i32;
            tcp.tcpsi_ini.insi_laddr.ina_6 = libc::in6_addr {
                s6_addr: Ipv6Addr::LOCALHOST.octets(),
            };
            let remote: Ipv6Addr = "2001:db8::7".parse().unwrap();
            tcp.tcpsi_ini.insi_faddr.ina_6 = libc::in6_addr {
                s6_addr: remote.octets(),
            };
            info.psi.soi_proto.pri_tcp = tcp;
            let row = decode(info, 7).unwrap();
            assert_eq!(row.local, "[::1]:43210".parse().unwrap());
            assert_eq!(row.remote, "[2001:db8::7]:443".parse().unwrap());
            assert_eq!(row.state, "ESTABLISHED");
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod native {
    use super::*;

    pub(super) fn collect() -> NativeResult {
        Err("TCP connection snapshots are unavailable on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn row(local: &str, remote: &str, state: &'static str, pid: Option<u32>) -> RawConnection {
        RawConnection {
            pid,
            local: local.parse().unwrap(),
            remote: remote.parse().unwrap(),
            state,
        }
    }

    fn fixture() -> Snapshot {
        normalize(
            [Ok(row(
                "127.0.0.1:3000",
                "127.0.0.1:4000",
                "ESTABLISHED",
                Some(42),
            ))],
            123,
            false,
        )
    }

    #[test]
    fn filters_listeners_closed_and_unconnected_entries_but_retains_closing() {
        let states = [
            "LISTEN",
            "CLOSED",
            "ESTABLISHED",
            "SYN_SENT",
            "SYN_RECEIVED",
            "CLOSE_WAIT",
            "FIN_WAIT_1",
            "FIN_WAIT_2",
            "CLOSING",
            "LAST_ACK",
            "TIME_WAIT",
            "DELETE_TCB",
        ];
        let mut rows: Vec<_> = states
            .iter()
            .enumerate()
            .map(|(i, state)| {
                Ok(row(
                    &format!("192.0.2.1:{}", 1000 + i),
                    "198.51.100.1:443",
                    state,
                    Some(1),
                ))
            })
            .collect();
        rows.push(Ok(row(
            "127.0.0.1:4000",
            "0.0.0.0:0",
            "ESTABLISHED",
            Some(1),
        )));
        let snapshot = normalize(rows, 123, false);
        assert_eq!(snapshot.total, states.len() - 2);
        assert!(!snapshot.partial);
        assert!(!snapshot.truncated);
        assert_eq!(snapshot.connections[0].state, "ESTABLISHED");
        assert_eq!(snapshot.connections.last().unwrap().state, "DELETE_TCB");
    }

    #[test]
    fn stable_ids_deduplicate_descriptors_and_sort_before_truncating() {
        let mut rows: Vec<_> = (0..MAX_CONNECTIONS + 20)
            .map(|i| {
                Ok(row(
                    &format!("127.0.0.1:{}", 1000 + i),
                    "127.0.0.1:9000",
                    "ESTABLISHED",
                    Some(i as u32 + 1),
                ))
            })
            .collect();
        let external = row("192.0.2.2:7000", "198.51.100.2:443", "CLOSE_WAIT", Some(42));
        rows.push(Ok(external.clone()));
        rows.push(Ok(external.clone()));
        let snapshot = normalize(rows.clone(), 7, false);
        rows.reverse();
        assert_eq!(snapshot, normalize(rows, 7, false));
        assert_eq!(snapshot.connections.len(), MAX_CONNECTIONS);
        assert_eq!(snapshot.total, MAX_CONNECTIONS + 21);
        assert!(snapshot.truncated);
        assert!(!snapshot.connections[0].loopback);
        let mut changed = external.clone();
        changed.state = "ESTABLISHED";
        let before = normalize([Ok(external)], 7, false);
        let after = normalize([Ok(changed)], 8, false);
        assert_eq!(before.connections[0].id, after.connections[0].id);
        assert!(selected_pids(&snapshot).len() <= MAX_CONNECTIONS);
    }

    #[test]
    fn ipv6_and_mapped_loopback_have_unambiguous_endpoint_ids() {
        let snapshot = normalize(
            [
                Ok(row("[::1]:1000", "[::1]:2000", "ESTABLISHED", Some(1))),
                Ok(row(
                    "[::ffff:127.0.0.1]:1000",
                    "[::ffff:127.0.0.1]:2000",
                    "ESTABLISHED",
                    Some(1),
                )),
                Ok(row(
                    "[2001:db8::1]:1000",
                    "[2001:db8::2]:443",
                    "ESTABLISHED",
                    Some(1),
                )),
            ],
            1,
            false,
        );
        assert!(!snapshot.connections[0].loopback);
        assert_eq!(snapshot.connections[0].remote_address, "2001:db8::2");
        assert!(snapshot.connections[0].id.contains("[2001:db8::2]:443"));
        assert!(snapshot.connections[1..].iter().all(|row| row.loopback));
        assert_eq!(
            snapshot
                .connections
                .iter()
                .map(|row| &row.id)
                .collect::<BTreeSet<_>>()
                .len(),
            3
        );
    }

    #[test]
    fn missing_owners_names_and_entry_errors_are_partial_not_fake_empty() {
        let mut snapshot = normalize(
            [
                Err(()),
                Ok(row(
                    "192.0.2.1:1000",
                    "198.51.100.1:443",
                    "ESTABLISHED",
                    None,
                )),
                Ok(row(
                    "192.0.2.1:1001",
                    "198.51.100.1:443",
                    "ESTABLISHED",
                    Some(5),
                )),
            ],
            1,
            false,
        );
        assert!(snapshot.partial);
        assert_eq!(snapshot.total, 2);
        apply_process_names(
            &mut snapshot,
            &HashMap::from([(5, format!("\n{}\0", "A".repeat(300)))]),
        );
        assert!(snapshot.connections.iter().any(|row| row
            .process_name
            .as_ref()
            .is_some_and(|name| name.len() == MAX_PROCESS_NAME)));
        let mut snapshot = fixture();
        apply_process_names(&mut snapshot, &HashMap::new());
        assert!(snapshot.partial);
        assert_eq!(snapshot.connections[0].process_name, None);
    }

    #[test]
    fn serializes_exact_camel_case_contract_with_nullable_owner() {
        let value = serde_json::to_value(fixture()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert_eq!(value["sampledAt"], 123);
        let row = &value["connections"][0];
        assert_eq!(row.as_object().unwrap().len(), 9);
        assert_eq!(row["processName"], serde_json::Value::Null);
        assert_eq!(row["localAddress"], "127.0.0.1");
        assert_eq!(row["localPort"], 3000);
        assert_eq!(row["remoteAddress"], "127.0.0.1");
        assert_eq!(row["remotePort"], 4000);
        assert_eq!(row["state"], "ESTABLISHED");
    }

    #[test]
    fn cache_cooldown_includes_errors_and_expires_at_five_seconds() {
        let now = Instant::now();
        let cached = Cached {
            completed_at: now,
            result: Err("Unavailable".into()),
        };
        assert!(cached.fresh(now + COOLDOWN - Duration::from_nanos(1)));
        assert!(!cached.fresh(now + COOLDOWN));
        tauri::async_runtime::block_on(async {
            let state = ConnectionsState::default();
            assert!(state.0.lock().await.is_none());
            assert_eq!(
                state.snapshot_with(|| Err("Unavailable".into())).await,
                Err("Unavailable".into())
            );
            assert_eq!(
                state
                    .snapshot_with(|| panic!("Cached failures must not rescan"))
                    .await,
                Err("Unavailable".into())
            );
            state.0.lock().await.as_mut().unwrap().completed_at = Instant::now() - COOLDOWN;
            assert!(state.snapshot_with(|| Ok(fixture())).await.is_ok());
        });
    }

    #[test]
    fn concurrent_requests_share_one_blocking_scan_and_success_cache() {
        tauri::async_runtime::block_on(async {
            let state = ConnectionsState::default();
            let calls = Arc::new(AtomicUsize::new(0));
            let requests = (0..16).map(|_| {
                let calls = calls.clone();
                state.snapshot_with(move || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(fixture())
                })
            });
            let results = futures_util::future::join_all(requests).await;
            assert!(results.iter().all(|result| result == &Ok(fixture())));
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn cancelled_request_keeps_the_worker_guard_and_caches_its_result() {
        tauri::async_runtime::block_on(async {
            let state = Arc::new(ConnectionsState::default());
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, finish) = std::sync::mpsc::channel();
            let worker_state = state.clone();
            let request = tauri::async_runtime::spawn(async move {
                worker_state
                    .snapshot_with(move || {
                        started.send(()).unwrap();
                        finish.recv().unwrap();
                        Ok(fixture())
                    })
                    .await
            });
            ready.await.unwrap();
            request.abort();
            assert!(request.await.is_err());
            assert!(state.0.try_lock().is_err());
            release.send(()).unwrap();
            assert_eq!(
                state
                    .snapshot_with(|| panic!("Cancellation must not allow another scan"))
                    .await,
                Ok(fixture())
            );
        });
    }

    #[test]
    fn native_snapshot_finds_only_the_isolated_loopback_endpoints_under_test() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server_address = listener.local_addr().unwrap();
        let client = TcpStream::connect(server_address).unwrap();
        let client_address = client.local_addr().unwrap();
        let (_server, _) = listener.accept().unwrap();
        let (rows, partial) = native::collect().expect("Native socket collection failed");
        let isolated = rows.into_iter().filter(|row| {
            row.as_ref().is_ok_and(|row| {
                row.local == client_address
                    && row.remote == server_address
                    && row.pid == Some(std::process::id())
            })
        });
        let mut snapshot = normalize(isolated, 1, partial);
        assert_eq!(
            snapshot.total, 1,
            "Isolated loopback connection was not found"
        );
        assert!(snapshot.connections[0].loopback);
        assert_eq!(snapshot.connections[0].state, "ESTABLISHED");
        let names = process_names(&selected_pids(&snapshot));
        apply_process_names(&mut snapshot, &names);
        assert!(snapshot.connections[0].process_name.is_some());
    }
}
