//! A scripted `Runtime` for unit tests (test builds only). Every call is
//! recorded as one line; failures are given as the runtime's own words and
//! come back as `Error::Internal`, the way `run_ok` reports them.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Mutex;

use async_trait::async_trait;

use crate::error::{Error, Result};
use crate::model::ContainerDetail;
use crate::runtime::{ContainerSpec, ExecOutput, Mount, PortBinding, RawStats, Runtime};

pub(crate) struct FakeRuntime {
    pub calls: Mutex<Vec<String>>,
    /// `ps_state`: `Err(text)` fails, `Ok(None)` = no container,
    /// `Ok(Some(status))` = a container in that state.
    pub ps: std::result::Result<Option<String>, String>,
    /// One entry per `start`/`restart` call, in order: `Some(text)` fails
    /// with that text; calls past the end succeed.
    pub start_failures: Mutex<VecDeque<Option<String>>>,
    /// `set_pids_limit_unlimited` fails with this text.
    pub update_failure: Option<String>,
    /// `inspect_ports`: `Err(text)` = the inspect failed.
    pub ports: std::result::Result<Vec<PortBinding>, String>,
    pub pids_limit: Option<i64>,
    pub labels: Vec<(String, String)>,
    pub image: Option<String>,
    pub mounts: Vec<Mount>,
}

impl Default for FakeRuntime {
    fn default() -> Self {
        FakeRuntime {
            calls: Mutex::new(Vec::new()),
            ps: Ok(Some("exited".into())),
            start_failures: Mutex::new(VecDeque::new()),
            update_failure: None,
            ports: Ok(Vec::new()),
            pids_limit: Some(2048),
            labels: Vec::new(),
            image: Some("docker.io/itzg/minecraft-server:java21".into()),
            mounts: Vec::new(),
        }
    }
}

impl FakeRuntime {
    pub fn failing_starts(failures: &[Option<&str>]) -> Self {
        FakeRuntime {
            start_failures: Mutex::new(failures.iter().map(|f| f.map(str::to_string)).collect()),
            ..Default::default()
        }
    }

    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn log(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }

    fn next_start(&self) -> Result<()> {
        match self.start_failures.lock().unwrap().pop_front().flatten() {
            Some(text) => Err(Error::Internal(text)),
            None => Ok(()),
        }
    }
}

fn ok_output() -> ExecOutput {
    ExecOutput {
        stdout: String::new(),
        stderr: String::new(),
        exit_code: Some(0),
    }
}

#[async_trait]
impl Runtime for FakeRuntime {
    fn kind(&self) -> &'static str {
        "podman"
    }
    async fn ps_state(&self, name: &str) -> Result<ContainerDetail> {
        self.log(format!("ps {name}"));
        match &self.ps {
            Err(text) => Err(Error::Internal(text.clone())),
            Ok(status) => Ok(ContainerDetail {
                exists: status.is_some(),
                id: status.as_ref().map(|_| "abc".to_string()),
                status: status.clone(),
                created_at: None,
                started_at: None,
            }),
        }
    }
    async fn start(&self, name: &str) -> Result<()> {
        self.log(format!("start {name}"));
        self.next_start()
    }
    async fn stop(&self, name: &str) -> Result<()> {
        self.log(format!("stop {name}"));
        Ok(())
    }
    async fn restart(&self, name: &str) -> Result<()> {
        self.log(format!("restart {name}"));
        self.next_start()
    }
    async fn logs_tail(&self, _: &str, _: u32) -> Result<Vec<String>> {
        Ok(Vec::new())
    }
    async fn spawn_follow_logs(&self, _: &str) -> Result<tokio::process::Child> {
        unimplemented!()
    }
    async fn exec(&self, _: &str, _: &[&str]) -> Result<ExecOutput> {
        unimplemented!()
    }
    async fn run_with_volumes_from(&self, _: &str, _: &[&str]) -> Result<ExecOutput> {
        unimplemented!()
    }
    async fn cp_to(&self, _: &str, _: &Path, _: &str) -> Result<()> {
        unimplemented!()
    }
    async fn cp_from(&self, _: &str, _: &str, _: &Path) -> Result<()> {
        unimplemented!()
    }
    async fn stats(&self, _: &str) -> Result<RawStats> {
        unimplemented!()
    }
    async fn inspect_started_at(&self, _: &str) -> Result<Option<String>> {
        Ok(None)
    }
    async fn inspect_env(&self, _: &str) -> Result<Vec<(String, String)>> {
        Ok(Vec::new())
    }
    async fn run_detached(&self, _: &ContainerSpec) -> Result<ExecOutput> {
        unimplemented!()
    }
    async fn create(&self, spec: &ContainerSpec) -> Result<ExecOutput> {
        self.log(format!("create {}", spec.create_args().join(" ")));
        Ok(ok_output())
    }
    async fn remove_force(&self, name: &str, anonymous_volumes: bool) -> Result<()> {
        assert!(!anonymous_volumes, "tests never drop volumes");
        self.log(format!("rm {name}"));
        Ok(())
    }
    async fn inspect_mounts(&self, _: &str) -> Result<Vec<Mount>> {
        Ok(self.mounts.clone())
    }
    async fn remove_volume(&self, _: &str) -> Result<()> {
        panic!("tests never remove a volume")
    }
    async fn inspect_ports(&self, _: &str) -> Result<Vec<PortBinding>> {
        self.ports.clone().map_err(Error::Internal)
    }
    async fn inspect_pids_limit(&self, _: &str) -> Result<Option<i64>> {
        Ok(self.pids_limit)
    }
    async fn set_pids_limit_unlimited(&self, name: &str) -> Result<()> {
        self.log(format!("update --pids-limit=0 {name}"));
        match &self.update_failure {
            Some(text) => Err(Error::Internal(text.clone())),
            None => Ok(()),
        }
    }
    async fn inspect_labels(&self, _: &str) -> Result<Vec<(String, String)>> {
        Ok(self.labels.clone())
    }
    async fn inspect_image(&self, _: &str) -> Result<Option<String>> {
        Ok(self.image.clone())
    }
    async fn image_env(&self, _: &str) -> Result<Vec<(String, String)>> {
        Ok(Vec::new())
    }
    async fn rename(&self, old: &str, new: &str) -> Result<()> {
        self.log(format!("rename {old} {new}"));
        Ok(())
    }
    async fn machine_vm_type(&self) -> Option<String> {
        None
    }
    async fn machine_rootful(&self) -> Option<bool> {
        None
    }
    async fn machine_name(&self) -> Option<String> {
        None
    }
}
