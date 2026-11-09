//! Bounded streaming transfers, with owned partial files and resumable in-process jobs.
use crate::{
    files::{self, field},
    service::Service,
    ssh::Connection,
};
use russh_sftp::{
    client::{error::Error as SftpError, SftpSession},
    protocol::{OpenFlags, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::SeekFrom,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, AsyncWrite, AsyncWriteExt},
    sync::{Mutex as AsyncMutex, Notify, Semaphore},
};

const CHUNK: usize = 256 * 1024;
const REOPEN: &str = "\0resume";
trait FileIo: AsyncRead + AsyncWrite + AsyncSeek + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + AsyncSeek + Send + Unpin> FileIo for T {}
type Stream = Box<dyn FileIo>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location {
    pub profile_id: Option<String>,
    pub path: String,
}
impl Location {
    pub(crate) fn child(&self, name: &str) -> Result<Self, String> {
        files::valid_name(name)?;
        let path = if self.profile_id.is_some() {
            files::join(&self.path, name)
        } else {
            let mut components = Path::new(name).components();
            if !matches!(components.next(), Some(std::path::Component::Normal(_)))
                || components.next().is_some()
                || cfg!(windows)
                    && (name.contains([':', '\\', '*', '?', '"', '<', '>', '|'])
                        || name.ends_with(['.', ' ']))
            {
                return Err(format!("本地系统不支持这个文件名：{name}"));
            }
            Path::new(&self.path)
                .join(name)
                .to_string_lossy()
                .into_owned()
        };
        Ok(Self {
            profile_id: self.profile_id.clone(),
            path,
        })
    }
    pub(crate) fn name(&self) -> Result<String, String> {
        if self.profile_id.is_some() {
            Ok(files::name(&self.path).into())
        } else {
            Path::new(&self.path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .ok_or("无法传输文件系统根目录".into())
        }
    }
    fn parent(&self) -> Self {
        Self {
            profile_id: self.profile_id.clone(),
            path: if self.profile_id.is_some() {
                files::parent(&self.path).into()
            } else {
                Path::new(&self.path)
                    .parent()
                    .unwrap_or(Path::new(&self.path))
                    .to_string_lossy()
                    .into_owned()
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: Option<u64>,
    kind: u8,
}
enum Disk {
    Local,
    Remote(Arc<SftpSession>, Arc<Connection>),
}
impl Disk {
    async fn connect(service: &Service, at: &Location) -> Result<Self, String> {
        files::valid_path(&at.path)?;
        if let Some(id) = &at.profile_id {
            Ok(Self::Remote(
                service.files.session(service, id).await?,
                service.file_connection(id)?,
            ))
        } else {
            if !Path::new(&at.path).is_absolute() {
                return Err("本地路径必须是绝对路径".into());
            }
            Ok(Self::Local)
        }
    }
    async fn canonical(&self, path: &str) -> Result<String, String> {
        match self {
            Self::Local => fs::canonicalize(path)
                .await
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| e.to_string()),
            Self::Remote(s, _) => s.canonicalize(path).await.map_err(|e| e.to_string()),
        }
    }
    async fn stat(&self, path: &str) -> Result<Option<Stamp>, String> {
        match self {
            Self::Local => match fs::symlink_metadata(path).await {
                Ok(m) => Ok(Some(Stamp {
                    size: m.len(),
                    modified: m
                        .modified()
                        .ok()
                        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
                        .map(|v| v.as_nanos().min(u64::MAX as u128) as u64),
                    kind: if m.is_symlink() {
                        2
                    } else if m.is_dir() {
                        1
                    } else if m.is_file() {
                        0
                    } else {
                        3
                    },
                })),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            Self::Remote(s, _) => match s.symlink_metadata(path).await {
                Ok(m) => Ok(Some(Stamp {
                    size: m.size.unwrap_or(0),
                    modified: m.mtime.map(u64::from),
                    kind: if m.is_symlink() {
                        2
                    } else if m.is_dir() {
                        1
                    } else if m.is_regular() {
                        0
                    } else {
                        3
                    },
                })),
                Err(SftpError::Status(s)) if s.status_code == StatusCode::NoSuchFile => Ok(None),
                Err(e) => Err(e.to_string()),
            },
        }
    }
    async fn list(&self, path: &str) -> Result<Vec<String>, String> {
        match self {
            Self::Local => {
                let mut directory = fs::read_dir(path).await.map_err(|e| e.to_string())?;
                let mut names = Vec::new();
                while let Some(entry) = directory.next_entry().await.map_err(|e| e.to_string())? {
                    names.push(
                        entry
                            .file_name()
                            .into_string()
                            .map_err(|_| "文件名不是有效的 Unicode")?,
                    );
                }
                Ok(names)
            }
            Self::Remote(s, _) => Ok(s
                .read_dir(path)
                .await
                .map_err(|e| e.to_string())?
                .map(|e| e.file_name())
                .collect()),
        }
    }
    async fn open(&self, path: &str, write: bool, create: bool) -> Result<Stream, String> {
        match self {
            Self::Local => Ok(Box::new(
                fs::OpenOptions::new()
                    .read(true)
                    .write(write)
                    .create_new(create)
                    .open(path)
                    .await
                    .map_err(|e| e.to_string())?,
            )),
            Self::Remote(s, _) => Ok(Box::new(
                s.open_with_flags(
                    path,
                    OpenFlags::READ
                        | if write {
                            OpenFlags::WRITE
                        } else {
                            OpenFlags::empty()
                        }
                        | if create {
                            OpenFlags::CREATE | OpenFlags::EXCLUDE
                        } else {
                            OpenFlags::empty()
                        },
                )
                .await
                .map_err(|e| e.to_string())?,
            )),
        }
    }
    async fn mkdir(&self, path: &str) -> Result<(), String> {
        if let Some(m) = self.stat(path).await? {
            return if m.kind == 1 {
                Ok(())
            } else {
                Err("目标目录被文件或符号链接占用".into())
            };
        }
        match self {
            Self::Local => fs::create_dir(path).await.map_err(|e| e.to_string()),
            Self::Remote(s, _) => s.create_dir(path).await.map_err(|e| e.to_string()),
        }
    }
    async fn remove(&self, path: &str) -> Result<(), String> {
        match self {
            Self::Local => fs::remove_file(path).await.map_err(|e| e.to_string()),
            Self::Remote(s, _) => s.remove_file(path).await.map_err(|e| e.to_string()),
        }
    }
    async fn rename(&self, from: &str, to: &str, replace: bool) -> Result<(), String> {
        match self {
            Self::Local => fs::rename(from, to).await.map_err(|e| e.to_string()),
            Self::Remote(s, c) => {
                if replace {
                    c.replace_sftp(from, to).await
                } else {
                    s.rename(from, to).await.map_err(|e| e.to_string())
                }
            }
        }
    }
    async fn link_target(&self, path: &str) -> Result<String, String> {
        match self {
            Self::Local => fs::read_link(path)
                .await
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| e.to_string()),
            Self::Remote(s, _) => s.read_link(path).await.map_err(|e| e.to_string()),
        }
    }
    async fn symlink(&self, target: &str, path: &str, directory: bool) -> Result<(), String> {
        match self {
            Self::Remote(s, _) => s.symlink(target, path).await.map_err(|e| e.to_string()),
            Self::Local => {
                #[cfg(unix)]
                {
                    let _ = directory;
                    tokio::fs::symlink(target, path)
                        .await
                        .map_err(|e| e.to_string())
                }
                #[cfg(windows)]
                {
                    if directory {
                        tokio::fs::symlink_dir(target, path).await
                    } else {
                        tokio::fs::symlink_file(target, path).await
                    }
                    .map_err(|e| e.to_string())
                }
            }
        }
    }
}

#[derive(Clone)]
struct Step {
    source: Location,
    target: Location,
    stamp: Stamp,
    offset: u64,
    part: Option<Location>,
    approved: bool,
    baseline: Option<Stamp>,
    skipped: bool,
}
#[derive(Default)]
struct Plan {
    steps: Vec<Step>,
    index: usize,
    completed: u64,
    skipped: u64,
    prepared: bool,
}
struct Job {
    id: String,
    source: Location,
    target: Location,
    batch: String,
    created: Instant,
    state: Mutex<Value>,
    desired: AtomicU8,
    running: AtomicBool,
    wake: Notify,
    decision: Mutex<Option<String>>,
    plan: AsyncMutex<Plan>,
}
pub struct Transfers {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    decisions: Mutex<HashMap<String, String>>,
    slots: Arc<Semaphore>,
}
impl Transfers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            jobs: Mutex::new(HashMap::new()),
            decisions: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(3)),
        })
    }
    pub fn list(&self) -> Value {
        let mut jobs: Vec<_> = self
            .jobs
            .lock()
            .unwrap()
            .values()
            .map(|j| j.state.lock().unwrap().clone())
            .collect();
        jobs.sort_by_key(|v| v["createdAt"].as_u64());
        json!(jobs)
    }
    pub fn stop(&self) {
        for job in self.jobs.lock().unwrap().values() {
            job.desired.store(2, Ordering::SeqCst);
            job.wake.notify_one();
        }
    }
    pub async fn wait(&self, ids: &[String]) -> Result<(), String> {
        let jobs: Vec<_> = {
            let all = self.jobs.lock().unwrap();
            ids.iter()
                .map(|id| all.get(id).cloned().ok_or("传输任务不存在"))
                .collect::<Result<_, _>>()?
        };
        loop {
            let mut complete = true;
            for job in &jobs {
                let state = job.state.lock().unwrap();
                match state["status"].as_str().unwrap_or("") {
                    "completed" => {}
                    "cancelled" => return Err("传输已取消".into()),
                    "failed" => return Err(state["error"].as_str().unwrap_or("传输失败").into()),
                    _ => complete = false,
                }
            }
            if complete {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    pub async fn enqueue(
        self: &Arc<Self>,
        service: &Arc<Service>,
        args: &Value,
    ) -> Result<Value, String> {
        let sources: Vec<Location> =
            serde_json::from_value(args["sources"].clone()).map_err(|_| "传输来源无效")?;
        let mut target: Location =
            serde_json::from_value(args["target"].clone()).map_err(|_| "传输目标无效")?;
        if sources.is_empty() || sources.len() > 256 {
            return Err("每批请选择 1–256 个项目".into());
        }
        let disk = Disk::connect(service, &target).await?;
        target.path = disk.canonical(&target.path).await?;
        if disk.stat(&target.path).await?.is_none_or(|s| s.kind != 1) {
            return Err("目标必须是文件夹".into());
        }
        let batch = uuid::Uuid::new_v4().to_string();
        let mut pending = Vec::new();
        let single_name = if sources.len() == 1 {
            args["name"].as_str().map(str::to_owned)
        } else {
            None
        };
        for mut source in sources {
            if source.profile_id.is_none() && target.profile_id.is_none() {
                return Err("不支持本地文件间复制".into());
            }
            let disk = Disk::connect(service, &source).await?;
            // Canonicalize only the parent so symlinks themselves remain copyable.
            let label = source.name()?;
            source = Location {
                profile_id: source.profile_id.clone(),
                path: disk.canonical(&source.parent().path).await?,
            }
            .child(&label)?;
            let destination = target.child(single_name.as_deref().unwrap_or(&label))?;
            let stamp = disk.stat(&source.path).await?.ok_or("来源文件已不存在")?;
            if source.profile_id == destination.profile_id
                && stamp.kind == 1
                && destination
                    .path
                    .starts_with(&format!("{}/", source.path.trim_end_matches('/')))
            {
                return Err("不能将文件夹复制到自身或其子目录".into());
            }
            let id = uuid::Uuid::new_v4().to_string();
            let direction = if source.profile_id.is_none() {
                "upload"
            } else if destination.profile_id.is_none() {
                "download"
            } else {
                "copy"
            };
            let state = json!({"id":id,"name":label,"source":source,"target":destination,"direction":direction,"status":"queued","total":null,"transferred":0,"skipped":0,"nativeDrop":args["nativeDrop"] == true,"speed":0,"elapsed":0,"remaining":null,"error":null,"createdAt":crate::service::now(),"currentPath":source.path});
            pending.push(Arc::new(Job {
                id,
                source,
                target: destination,
                batch: batch.clone(),
                created: Instant::now(),
                state: Mutex::new(state),
                desired: AtomicU8::new(0),
                running: AtomicBool::new(false),
                wake: Notify::new(),
                decision: Mutex::new(None),
                plan: AsyncMutex::new(Plan::default()),
            }));
        }
        {
            let mut jobs = self.jobs.lock().unwrap();
            if jobs.len() + pending.len() > 512 {
                return Err("传输记录已满，请清除已完成任务".into());
            }
            for job in &pending {
                jobs.insert(job.id.clone(), job.clone());
            }
        }
        let ids: Vec<_> = pending.iter().map(|j| j.id.clone()).collect();
        for job in pending {
            service.file_event(job.state.lock().unwrap().clone());
            self.start(service, job);
        }
        Ok(json!(ids))
    }
    pub fn control(
        self: &Arc<Self>,
        service: &Arc<Service>,
        args: &Value,
    ) -> Result<Value, String> {
        let id = field(args, "id")?;
        let job = self
            .jobs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("传输任务不存在")?;
        let status = job.state.lock().unwrap()["status"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        if ["completed", "cancelled"].contains(&status.as_str())
            && field(args, "action")? != "dismiss"
        {
            return Err("传输任务已经结束".into());
        }
        match field(args, "action")? {
            "pause" => {
                job.desired.store(1, Ordering::SeqCst);
                job.update(service, "paused", None);
            }
            "resume" | "retry" => {
                job.desired.store(0, Ordering::SeqCst);
                job.update(service, "queued", None);
                self.start(service, job.clone());
            }
            "cancel" => {
                job.desired.store(2, Ordering::SeqCst);
                self.start(service, job.clone());
            }
            "resolve" => {
                let decision = field(args, "decision")?;
                if !["overwrite", "skip", "keep"].contains(&decision) {
                    return Err("同名文件选项无效".into());
                }
                if args["all"] == true {
                    self.decisions
                        .lock()
                        .unwrap()
                        .insert(job.batch.clone(), decision.into());
                }
                *job.decision.lock().unwrap() = Some(decision.into());
            }
            "dismiss" => {
                if !["completed", "cancelled"].contains(&status.as_str())
                    || job.running.load(Ordering::SeqCst)
                {
                    return Err("请先取消任务再清除记录".into());
                }
                self.jobs.lock().unwrap().remove(id);
                service.file_event(json!({"removed":id}));
                return Ok(Value::Null);
            }
            _ => return Err("不支持的传输操作".into()),
        }
        job.wake.notify_one();
        Ok(Value::Null)
    }
    fn start(self: &Arc<Self>, service: &Arc<Service>, job: Arc<Job>) {
        if job.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let owner = self.clone();
        let service = Arc::downgrade(service);
        tokio::spawn(async move {
            let Some(service) = service.upgrade() else {
                return;
            };
            let mut plan = job.plan.lock().await;
            let outcome = owner.drive(&service, &job, &mut plan).await;
            job.running.store(false, Ordering::SeqCst);
            if job.desired.load(Ordering::SeqCst) == 2 {
                for step in &plan.steps {
                    if let Some(part) = &step.part {
                        if let Ok(disk) = Disk::connect(&service, part).await {
                            let _ = disk.remove(&part.path).await;
                        }
                    }
                }
                job.update(&service, "cancelled", None);
            } else {
                match outcome {
                    Ok(()) => job.update(&service, "completed", None),
                    Err(error) => job.update(&service, "failed", Some(error)),
                }
            }
        });
    }
    async fn drive(
        &self,
        service: &Arc<Service>,
        job: &Job,
        plan: &mut Plan,
    ) -> Result<(), String> {
        job.ready().await?;
        if !plan.prepared {
            loop {
                match self.prepare(service, job, plan).await {
                    Ok(()) => break,
                    Err(error) if error == REOPEN => job.ready().await?,
                    Err(error) => {
                        Self::reconnect(service, job, [&job.source, &job.target], error).await?
                    }
                }
            }
        }
        while plan.index < plan.steps.len() {
            job.ready().await?;
            let step = &mut plan.steps[plan.index];
            let old_target = step.target.path.clone();
            // Connection loss keeps the exact acknowledged offset and waits for the existing SSH reconnect flow.
            let result = self.copy_step(service, job, step, plan.completed).await;
            match result {
                Ok(()) => {
                    let directory = step.stamp.kind == 1;
                    let skipped = step.skipped;
                    let new_target = step.target.path.clone();
                    if step.stamp.kind == 0 {
                        if skipped {
                            plan.skipped += step.stamp.size;
                        } else {
                            plan.completed += step.stamp.size;
                        }
                    }
                    plan.index += 1;
                    if directory && (skipped || old_target != new_target) {
                        let separator = if job.target.profile_id.is_some() {
                            '/'
                        } else {
                            std::path::MAIN_SEPARATOR
                        };
                        let prefix = format!("{old_target}{separator}");
                        if skipped {
                            while plan.index < plan.steps.len()
                                && plan.steps[plan.index].target.path.starts_with(&prefix)
                            {
                                if plan.steps[plan.index].stamp.kind == 0 {
                                    plan.skipped += plan.steps[plan.index].stamp.size;
                                }
                                plan.index += 1;
                            }
                        } else {
                            for next in &mut plan.steps[plan.index..] {
                                if next.target.path.starts_with(&prefix) {
                                    next.target.path = format!(
                                        "{new_target}{}",
                                        &next.target.path[old_target.len()..]
                                    );
                                }
                            }
                        }
                    }
                    job.state.lock().unwrap()["skipped"] = json!(plan.skipped);
                    job.progress(service, plan.completed, 0.);
                }
                Err(error) => {
                    if job.desired.load(Ordering::SeqCst) == 2 {
                        return Err(error);
                    }
                    if error == REOPEN {
                        job.ready().await?;
                        continue;
                    }
                    Self::reconnect(service, job, [&step.source, &step.target], error).await?;
                }
            }
        }
        Ok(())
    }
    async fn reconnect(
        service: &Service,
        job: &Job,
        locations: [&Location; 2],
        error: String,
    ) -> Result<(), String> {
        if job.desired.load(Ordering::SeqCst) == 2 {
            return Err(error);
        }
        for location in locations {
            if let Some(id) = &location.profile_id {
                service.files.invalidate(id);
            }
        }
        if locations.iter().all(|location| {
            location
                .profile_id
                .as_ref()
                .is_none_or(|id| service.file_connection(id).is_ok())
        }) {
            return Err(error);
        }
        job.update(service, "waiting", Some(error));
        loop {
            job.ready().await?;
            if locations.iter().all(|location| {
                location
                    .profile_id
                    .as_ref()
                    .is_none_or(|id| service.file_connection(id).is_ok())
            }) {
                return Ok(());
            }
            tokio::select! { _ = tokio::time::sleep(Duration::from_secs(1)) => {}, _ = job.wake.notified() => {} }
        }
    }
    async fn prepare(&self, service: &Service, job: &Job, plan: &mut Plan) -> Result<(), String> {
        let _slot = self.slot(job).await?;
        job.update(service, "scanning", None);
        let source = Disk::connect(service, &job.source).await?;
        let mut stack = vec![(job.source.clone(), job.target.clone())];
        let mut steps = Vec::new();
        let mut total = 0u64;
        while let Some((from, to)) = stack.pop() {
            if job.desired.load(Ordering::SeqCst) == 1 {
                return Err(REOPEN.into());
            }
            job.ready().await?;
            let stamp = source.stat(&from.path).await?.ok_or("来源已不存在")?;
            if stamp.kind == 3 {
                return Err(format!("不能传输特殊文件：{}", from.path));
            }
            if stamp.kind == 1 {
                for name in source.list(&from.path).await?.into_iter().rev() {
                    stack.push((from.child(&name)?, to.child(&name)?));
                }
            } else if stamp.kind == 0 {
                total = total.checked_add(stamp.size).ok_or("传输大小溢出")?;
            }
            steps.push(Step {
                source: from,
                target: to,
                stamp,
                offset: 0,
                part: None,
                approved: false,
                baseline: None,
                skipped: false,
            });
            if steps.len() + stack.len() > 1_000_000 {
                return Err("目录项目过多，请分批传输".into());
            }
        }
        plan.steps = steps;
        plan.prepared = true;
        job.state.lock().unwrap()["total"] = json!(total);

        Ok(())
    }
    async fn slot(&self, job: &Job) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
        loop {
            job.ready().await?;
            tokio::select! {
                permit = self.slots.clone().acquire_owned() => {
                    let permit = permit.map_err(|_| "传输队列已关闭")?;
                    if job.desired.load(Ordering::SeqCst) == 0 { return Ok(permit); }
                }
                _ = job.wake.notified() => {}
            }
        }
    }
    async fn copy_step(
        &self,
        service: &Arc<Service>,
        job: &Job,
        step: &mut Step,
        completed: u64,
    ) -> Result<(), String> {
        let _slot = self.slot(job).await?;
        let source = Disk::connect(service, &step.source).await?;
        let target = Disk::connect(service, &step.target).await?;
        if source.stat(&step.source.path).await?.as_ref() != Some(&step.stamp) {
            return Err("来源文件已变化，无法安全续传；请取消任务并重新传输".into());
        }
        if target
            .stat(&step.target.parent().path)
            .await?
            .is_none_or(|s| s.kind != 1)
        {
            return Err("目标父目录不存在或被符号链接替换".into());
        }
        if target.canonical(&step.target.parent().path).await? != step.target.parent().path {
            return Err("目标父目录已被符号链接替换".into());
        }
        if !step.approved {
            let existing = target.stat(&step.target.path).await?;
            if let Some(existing) = existing.as_ref() {
                job.state.lock().unwrap()["currentPath"] = json!(step.target.path);
                let decision = self.conflict(service, job).await?;
                if decision == "skip" {
                    step.skipped = true;
                    return Ok(());
                }
                if decision == "keep" {
                    let original = step.target.clone();
                    for index in 1..10000 {
                        let label = original.name()?;
                        let (stem, extension) = if step.stamp.kind == 1 {
                            (label.as_str(), "")
                        } else {
                            label
                                .rsplit_once('.')
                                .filter(|(s, _)| !s.is_empty())
                                .map(|(s, e)| (s, e))
                                .unwrap_or((&label, ""))
                        };
                        let name = format!(
                            "{stem} ({index}){}",
                            if extension.is_empty() {
                                String::new()
                            } else {
                                format!(".{extension}")
                            }
                        );
                        let candidate = original.parent().child(&name)?;
                        if target.stat(&candidate.path).await?.is_none() {
                            step.target = candidate;
                            if step.source.profile_id == job.source.profile_id
                                && step.source.path == job.source.path
                            {
                                job.state.lock().unwrap()["target"] = json!(step.target);
                            }
                            break;
                        }
                        if index == 9999 {
                            return Err("无法找到可用的文件名".into());
                        }
                    }
                } else {
                    if (existing.kind == 1) != (step.stamp.kind == 1) {
                        return Err("不能用文件覆盖文件夹，请选择保留两份".into());
                    }
                    if step.source.profile_id == step.target.profile_id
                        && step.source.path == step.target.path
                    {
                        return Err("不能覆盖来源文件本身，请选择保留两份".into());
                    }
                    step.baseline = Some(existing.clone());
                }
            }
            step.approved = true;
        }
        if step.stamp.kind == 1 {
            return target.mkdir(&step.target.path).await;
        }
        if step.stamp.kind == 2 {
            let link = source.link_target(&step.source.path).await?;
            let part = step
                .target
                .parent()
                .child(&format!(".lion-{}.part", uuid::Uuid::new_v4()))?;
            let directory = if let Ok(resolved) = source.canonical(&step.source.path).await {
                source.stat(&resolved).await?.is_some_and(|m| m.kind == 1)
            } else {
                false
            };
            target.symlink(&link, &part.path, directory).await?;
            step.part = Some(part.clone());
            target
                .rename(&part.path, &step.target.path, step.baseline.is_some())
                .await?;
            step.part = None;
            return Ok(());
        }
        job.update(service, "running", None);
        job.state.lock().unwrap()["currentPath"] = json!(step.source.path);
        let mut reader = source.open(&step.source.path, false, false).await?;
        let mut writer = if let Some(part) = &step.part {
            let partial = target
                .stat(&part.path)
                .await?
                .ok_or("续传临时文件已不存在")?;
            if partial.kind != 0 || partial.size < step.offset || partial.size > step.stamp.size {
                return Err("续传临时文件已变化".into());
            }
            let mut writer = target.open(&part.path, true, false).await?;
            // Validate every acknowledged byte before resuming, not just a timestamp or the last block.
            if hash_prefix(&mut reader, step.offset, job).await?
                != hash_prefix(&mut writer, step.offset, job).await?
            {
                return Err("续传内容与来源不一致，请取消后重新传输".into());
            }
            writer
        } else {
            let part = step
                .target
                .parent()
                .child(&format!(".lion-{}.part", uuid::Uuid::new_v4()))?;
            let writer = target.open(&part.path, true, true).await?;
            step.part = Some(part);
            writer
        };
        reader
            .seek(SeekFrom::Start(step.offset))
            .await
            .map_err(|e| e.to_string())?;
        writer
            .seek(SeekFrom::Start(step.offset))
            .await
            .map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; CHUNK];
        let mut report = Instant::now();
        let mut report_bytes = step.offset;
        while step.offset < step.stamp.size {
            if job.desired.load(Ordering::SeqCst) == 1 {
                writer.flush().await.map_err(|e| e.to_string())?;
                return Err(REOPEN.into());
            }
            job.ready().await?;
            let length = (step.stamp.size - step.offset).min(CHUNK as u64) as usize;
            let count = reader
                .read(&mut buffer[..length])
                .await
                .map_err(|e| e.to_string())?;
            if count == 0 {
                return Err("来源文件在传输期间缩短".into());
            }
            writer
                .write_all(&buffer[..count])
                .await
                .map_err(|e| e.to_string())?;
            writer.flush().await.map_err(|e| e.to_string())?;
            step.offset += count as u64;
            if report.elapsed() >= Duration::from_millis(150) || step.offset == step.stamp.size {
                job.progress(
                    service,
                    completed + step.offset,
                    (step.offset - report_bytes) as f64 / report.elapsed().as_secs_f64().max(0.001),
                );
                report = Instant::now();
                report_bytes = step.offset;
            }
        }
        writer.shutdown().await.map_err(|e| e.to_string())?;
        drop(writer);
        if job.desired.load(Ordering::SeqCst) == 1 {
            return Err(REOPEN.into());
        }
        job.ready().await?;
        if source.stat(&step.source.path).await?.as_ref() != Some(&step.stamp) {
            return Err("来源文件在传输期间变化，目标文件未替换".into());
        }
        if target.stat(&step.target.path).await? != step.baseline {
            return Err("目标文件在传输期间变化，目标文件未替换".into());
        }
        let part = step.part.as_ref().unwrap();
        target
            .rename(&part.path, &step.target.path, step.baseline.is_some())
            .await?;
        step.part = None;
        Ok(())
    }
    async fn conflict(&self, service: &Service, job: &Job) -> Result<String, String> {
        if let Some(value) = self.decisions.lock().unwrap().get(&job.batch).cloned() {
            return Ok(value);
        }
        job.update(service, "conflict", None);
        loop {
            let notified = job.wake.notified();
            job.ready().await?;
            if let Some(value) = job.decision.lock().unwrap().take() {
                return Ok(value);
            }
            if let Some(value) = self.decisions.lock().unwrap().get(&job.batch).cloned() {
                return Ok(value);
            }
            tokio::select! { _ = notified => {}, _ = tokio::time::sleep(Duration::from_millis(250)) => {} }
        }
    }
}
impl Job {
    async fn ready(&self) -> Result<(), String> {
        loop {
            let notified = self.wake.notified();
            match self.desired.load(Ordering::SeqCst) {
                0 => return Ok(()),
                2 => return Err("传输已取消".into()),
                _ => notified.await,
            }
        }
    }
    fn update(&self, service: &Service, status: &str, error: Option<String>) {
        let value = {
            let mut state = self.state.lock().unwrap();
            state["status"] = json!(if ["running", "scanning", "waiting"].contains(&status)
                && self.desired.load(Ordering::SeqCst) == 1
            {
                "paused"
            } else {
                status
            });
            state["error"] = json!(error);
            state["elapsed"] = json!(self.created.elapsed().as_secs_f64());
            if status != "running" {
                state["speed"] = json!(0);
                state["remaining"] = Value::Null;
            }
            state.clone()
        };
        service.file_event(value);
    }
    fn progress(&self, service: &Service, transferred: u64, speed: f64) {
        let value = {
            let mut state = self.state.lock().unwrap();
            state["transferred"] = json!(transferred);
            state["speed"] = json!(speed);
            state["elapsed"] = json!(self.created.elapsed().as_secs_f64());
            state["remaining"] =
                json!(state["total"]
                    .as_u64()
                    .filter(|_| speed > 0.)
                    .map(|total| total
                        .saturating_sub(transferred)
                        .saturating_sub(state["skipped"].as_u64().unwrap_or(0))
                        as f64
                        / speed));
            state.clone()
        };
        service.file_event(value);
    }
}
async fn hash_prefix(file: &mut Stream, length: u64, job: &Job) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(0))
        .await
        .map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut remaining = length;
    let mut buffer = vec![0; CHUNK];
    while remaining > 0 {
        if job.desired.load(Ordering::SeqCst) == 1 {
            return Err(REOPEN.into());
        }
        job.ready().await?;
        let cap = remaining.min(CHUNK as u64) as usize;
        let count = file
            .read(&mut buffer[..cap])
            .await
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("续传文件长度不匹配".into());
        }
        hash.update(&buffer[..count]);
        remaining -= count as u64;
    }
    Ok(hash.finalize().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_names_cannot_escape_local_download_directory() {
        let root = Location {
            profile_id: None,
            path: std::env::temp_dir().to_string_lossy().into_owned(),
        };
        for bad in ["..", "../escape", "/escape"] {
            assert!(root.child(bad).is_err());
        }
        if cfg!(windows) {
            for bad in ["C:\\escape", "a\\b", "file:stream", "a."] {
                assert!(root.child(bad).is_err());
            }
        }
        assert!(root.child("中文.py").is_ok());
    }
}
