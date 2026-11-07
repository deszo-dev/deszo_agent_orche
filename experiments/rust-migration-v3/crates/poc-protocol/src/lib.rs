use serde::{Deserialize, Serialize};

pub const MAX_HOST_FRAME: usize = 16 * 1024;
pub const MAX_WORKER_REQUEST: usize = 128 * 1024;
pub const MAX_WORKER_RESPONSE: usize = 128 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum HostRequest {
    GetEnvironment {
        request_id: String,
    },
    RecordEvidence {
        request_id: String,
        case: String,
        outcome: String,
        detail: String,
        elapsed_us: Option<u64>,
    },
    StartWorker {
        request_id: String,
        variant: WorkerVariant,
    },
    StopWorker {
        request_id: String,
        generation_id: String,
        reason: String,
    },
    Finish {
        request_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum HostResponse {
    Environment {
        request_id: String,
        paths: ProbePaths,
        host_pid: u32,
        host_pipe_name: String,
        network_address: String,
        child_exe: String,
    },
    WorkerStarted {
        request_id: String,
        generation_id: String,
        read_handle: u64,
        write_handle: u64,
        pid: u32,
        appcontainer_name: String,
        startup_ms: u64,
        working_set_kb: u64,
    },
    WorkerStopped {
        request_id: String,
        generation_id: String,
        exit_code: u32,
        elapsed_ms: u64,
        cpu_us: u64,
        working_set_kb: u64,
        active_processes_after_stop: u32,
    },
    Acknowledged {
        request_id: String,
    },
    Refused {
        request_id: String,
        code: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerVariant {
    A,
    B,
    Fault,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum WorkerRequest {
    Normalize {
        generation_id: String,
        request_id: String,
        raw: String,
    },
    ScorePlan {
        generation_id: String,
        request_id: String,
        candidates: Vec<PlanCandidate>,
    },
    ProbeResources {
        generation_id: String,
        request_id: String,
        paths: ProbePaths,
        host_pid: u32,
        core_pid: u32,
        host_pipe_name: String,
        network_address: String,
        child_exe: String,
    },
    FaultProbe {
        generation_id: String,
        request_id: String,
        mode: String,
    },
    Shutdown {
        generation_id: String,
        request_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum WorkerResponse {
    Normalized {
        generation_id: String,
        request_id: String,
        records: Vec<NormalizedRecord>,
    },
    PlanScores {
        generation_id: String,
        request_id: String,
        scores: Vec<PlanScore>,
    },
    ResourceProbe {
        generation_id: String,
        request_id: String,
        identity: WorkerIdentity,
        results: Vec<ResourceProbeResult>,
    },
    FaultObserved {
        generation_id: String,
        request_id: String,
        observation: String,
    },
    Stopped {
        generation_id: String,
        request_id: String,
    },
    Error {
        generation_id: String,
        request_id: String,
        code: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerIdentity {
    pub is_appcontainer: bool,
    pub appcontainer_sid: String,
    pub capability_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NormalizedRecord {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlanCandidate {
    pub id: String,
    pub estimated_cost: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlanScore {
    pub id: String,
    pub score: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProbePaths {
    pub host_private: String,
    pub host_private_dir: String,
    pub engine_store: String,
    pub engine_store_dir: String,
    pub test_workspace: String,
    pub test_workspace_dir: String,
    pub ungranted_file: String,
    pub ungranted_dir: String,
    pub other_worker_private: String,
    pub other_worker_private_dir: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResourceProbeResult {
    pub resource: String,
    pub outcome: String,
    pub os_error: Option<u32>,
    pub observation: Option<String>,
}

