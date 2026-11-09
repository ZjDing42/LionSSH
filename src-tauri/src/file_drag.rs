//! Native file promises. Network work begins when the drop target requests file contents.
use crate::{files, service::Service, transfers::Location};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

pub struct ExportEntry {
    pub relative: PathBuf,
    pub directory: bool,
    pub size: u64,
}
pub struct Export {
    pub service: Arc<Service>,
    pub sources: Vec<Location>,
    pub directory: Arc<tempfile::TempDir>,
    pub entries: tokio::sync::OnceCell<Result<Vec<ExportEntry>, String>>,
    prepared: tokio::sync::OnceCell<Result<(), String>>,
}
impl Export {
    pub async fn manifest(&self) -> Result<&Vec<ExportEntry>, String> {
        self.entries
            .get_or_init(|| async {
                let mut result = Vec::new();
                let root = Location {
                    profile_id: None,
                    path: self.directory.path().to_string_lossy().into_owned(),
                };
                let mut stack = Vec::new();
                let mut names = std::collections::HashSet::new();
                for source in &self.sources {
                    let name = source.name()?;
                    if !names.insert(name.clone()) {
                        return Err("拖出的项目含有重复名称，请分开拖放".into());
                    }
                    stack.push((source.clone(), root.child(&name)?));
                }
                while let Some((source, local)) = stack.pop() {
                    let session = self
                        .service
                        .files
                        .session(
                            &self.service,
                            source.profile_id.as_ref().ok_or("只能拖出服务器文件")?,
                        )
                        .await?;
                    let metadata = session
                        .symlink_metadata(source.path.clone())
                        .await
                        .map_err(|e| e.to_string())?;
                    if !metadata.is_dir() && !metadata.is_regular() {
                        return Err(format!(
                            "请使用下载按钮传输符号链接或特殊项目：{}",
                            source.path
                        ));
                    }
                    result.push(ExportEntry {
                        relative: PathBuf::from(&local.path)
                            .strip_prefix(self.directory.path())
                            .map_err(|e| e.to_string())?
                            .to_owned(),
                        directory: metadata.is_dir(),
                        size: metadata.size.unwrap_or(0),
                    });
                    if metadata.is_dir() {
                        for entry in session
                            .read_dir(source.path.clone())
                            .await
                            .map_err(|e| e.to_string())?
                        {
                            let name = entry.file_name();
                            files::valid_name(&name)?;
                            stack.push((source.child(&name)?, local.child(&name)?));
                        }
                    }
                    if result.len() + stack.len() > 100_000 {
                        return Err("拖出的目录过大，请使用下载按钮".into());
                    }
                }
                Ok(result)
            })
            .await
            .as_ref()
            .map_err(Clone::clone)
    }
    pub async fn materialize(&self) -> Result<(), String> {
        self.prepared.get_or_init(|| async {
            let value = self.service.files.transfers.enqueue(&self.service, &json!({"sources":self.sources,"target":{"profileId":null,"path":self.directory.path()},"nativeDrop":true})).await?;
            let ids: Vec<String> = serde_json::from_value(value).map_err(|e| e.to_string())?;
            self.service.files.transfers.wait(&ids).await
        }).await.clone()
    }
}

pub async fn start(
    window: tauri::WebviewWindow,
    service: Arc<Service>,
    sources: Vec<Location>,
) -> Result<(), String> {
    if sources.is_empty() || sources.len() > 256 {
        return Err("每次拖放请选择 1–256 个项目".into());
    }
    for source in &sources {
        files::valid_path(&source.path)?;
        service.file_connection(source.profile_id.as_ref().ok_or("只能拖出服务器文件")?)?;
    }
    #[cfg(target_os = "macos")]
    {
        use tauri::{Listener, Manager};
        use tauri_plugin_dragout::{DragItem, DragOptions};
        let state = window
            .state::<Arc<crate::file_drop::DropState>>()
            .inner()
            .clone();
        let _remote = state.begin_remote(0, sources.clone());
        let mut items = Vec::new();
        for source in sources {
            let service = service.clone();
            items.push(DragItem::promise(source.name()?, move |destination| {
                tauri::async_runtime::block_on(async {
                    let parent = destination.parent().ok_or("拖放目标无效")?;
                    let name = destination.file_name().ok_or("拖放名称无效")?.to_string_lossy();
                    let value = service.files.transfers.enqueue(&service, &json!({"sources":[source],"target":{"profileId":null,"path":parent},"name":name})).await?;
                    let ids: Vec<String> = serde_json::from_value(value).map_err(|e| e.to_string())?;
                    service.files.transfers.wait(&ids).await
                })
            }));
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let listener = window
            .app_handle()
            .once(tauri_plugin_dragout::EVENT_ENDED, move |_| {
                let _ = sender.send(());
            });
        let result = tauri_plugin_dragout::start_drag(
            &window,
            items,
            DragOptions {
                allow_self_drop: true,
                ..Default::default()
            },
        );
        if let Err(error) = result {
            window.app_handle().unlisten(listener);
            return Err(error.to_string());
        }
        let result = receiver.await.map_err(|_| "拖放窗口已关闭".to_string());
        window.app_handle().unlisten(listener);
        return result;
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        let export = Arc::new(Export {
            service,
            sources,
            directory: Arc::new(
                tempfile::Builder::new()
                    .prefix("lion-drag-")
                    .tempdir()
                    .map_err(|e| e.to_string())?,
            ),
            entries: tokio::sync::OnceCell::new(),
            prepared: tokio::sync::OnceCell::new(),
        });
        #[cfg(windows)]
        {
            use tauri::Manager;
            let drop_state = window
                .state::<Arc<crate::file_drop::DropState>>()
                .inner()
                .clone();
            // OLE must share the UI thread's input queue. A worker-thread drag can
            // miss mouse-up and retain capture, blocking Explorer's later drags.
            let (sender, receiver) = tokio::sync::oneshot::channel();
            window
                .run_on_main_thread(move || {
                    let _ = sender.send(windows::start(export, drop_state));
                })
                .map_err(|error| error.to_string())?;
            receiver.await.map_err(|_| "拖放窗口已关闭".to_string())?
        }
        #[cfg(target_os = "linux")]
        {
            linux::start(window, export).await
        }
    }
}
