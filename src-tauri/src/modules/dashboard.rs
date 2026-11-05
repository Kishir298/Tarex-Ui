use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use sysinfo::{Disks, ProcessRefreshKind, ProcessesToUpdate, System};

pub struct DashboardState(Arc<Mutex<Monitor>>);

impl Default for DashboardState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Monitor {
            system: System::new(),
            disks: Disks::new(),
            details_sampled: None,
            processes: Vec::new(),
        })))
    }
}

struct Monitor {
    system: System,
    disks: Disks,
    details_sampled: Option<Instant>,
    processes: Vec<Process>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    hostname: String,
    os: String,
    kernel: String,
    architecture: String,
    uptime: u64,
    cpu_name: String,
    cpu: Vec<f32>,
    memory_used: u64,
    memory_total: u64,
    swap_used: u64,
    swap_total: u64,
    processes: Vec<Process>,
    disks: Vec<Disk>,
}

#[derive(Serialize, Clone)]
struct Process {
    pid: u32,
    name: String,
    cpu: f32,
    memory: u64,
    started: u64,
}

#[derive(Serialize)]
struct Disk {
    mount: String,
    total: u64,
    available: u64,
}

impl Monitor {
    fn snapshot(&mut self) -> Snapshot {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        if self
            .details_sampled
            .is_none_or(|last| last.elapsed().as_secs() >= 15)
        {
            self.system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_cpu().with_memory(),
            );
            self.disks.refresh(true);
            let mut processes: Vec<_> = self
                .system
                .processes()
                .iter()
                .map(|(pid, p)| Process {
                    pid: pid.as_u32(),
                    name: p.name().to_string_lossy().into_owned(),
                    cpu: p.cpu_usage(),
                    memory: p.memory(),
                    started: p.start_time(),
                })
                .collect();
            processes
                .sort_unstable_by(|a, b| b.cpu.total_cmp(&a.cpu).then(b.memory.cmp(&a.memory)));
            processes.truncate(5);
            self.processes = processes;
            self.details_sampled = Some(Instant::now());
        }
        Snapshot {
            hostname: System::host_name().unwrap_or_else(|| "localhost".into()),
            os: System::name().unwrap_or_else(|| std::env::consts::OS.into()),
            kernel: System::kernel_version().unwrap_or_default(),
            architecture: std::env::consts::ARCH.into(),
            uptime: System::uptime(),
            cpu_name: self
                .system
                .cpus()
                .first()
                .map(|c| c.brand().to_owned())
                .unwrap_or_default(),
            cpu: self.system.cpus().iter().map(|c| c.cpu_usage()).collect(),
            memory_used: self.system.used_memory(),
            memory_total: self.system.total_memory(),
            swap_used: self.system.used_swap(),
            swap_total: self.system.total_swap(),
            processes: self.processes.clone(),
            disks: self
                .disks
                .iter()
                .map(|disk| Disk {
                    mount: disk.mount_point().to_string_lossy().into_owned(),
                    total: disk.total_space(),
                    available: disk.available_space(),
                })
                .collect(),
        }
    }
}

#[tauri::command]
pub async fn dashboard_snapshot(
    state: tauri::State<'_, DashboardState>,
    force_details: Option<bool>,
) -> Result<Snapshot, String> {
    let monitor = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        monitor
            .lock()
            .map_err(|e| e.to_string())
            .map(|mut m| {if force_details.unwrap_or(false){m.details_sampled=None;}m.snapshot()})
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_snapshot_has_bounded_processes_and_finite_rates() {
        let state = DashboardState::default();
        let s = state.0.lock().unwrap().snapshot();
        let details_sampled = state.0.lock().unwrap().details_sampled;
        state.0.lock().unwrap().snapshot();
        assert_eq!(state.0.lock().unwrap().details_sampled, details_sampled);
        assert!(s.processes.len() <= 5);
        assert!(s.memory_used <= s.memory_total);
        assert!(s
            .cpu
            .iter()
            .all(|c| c.is_finite() && (0.0..=100.0).contains(c)));
    }

}
