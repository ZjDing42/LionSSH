use super::Export;
use gtk::{gdk, glib, prelude::*, TargetEntry, TargetFlags, TargetList};
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub async fn start(window: tauri::WebviewWindow, export: Arc<Export>) -> Result<(), String> {
    let owner = window.clone();
    let state = window
        .state::<Arc<crate::file_drop::DropState>>()
        .inner()
        .clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let Ok(widget) = owner.gtk_window() else {
                let _ = sender.send(Err("拖放窗口已关闭".to_string()));
                return;
            };
            let remote = Arc::new(Mutex::new(Some(
                state.begin_remote(widget.as_ptr() as usize, export.sources.clone()),
            )));
            let finished = Arc::new(Mutex::new(Some(sender)));
            let targets =
                TargetList::new(&[TargetEntry::new("text/uri-list", TargetFlags::OTHER_APP, 0)]);
            let handlers = Arc::new(Mutex::new(Vec::new()));
            let data_export = export.clone();
            let data_handler = widget.connect_drag_data_get(move |_, _, selection, _, _| {
                let export = data_export.clone();
                let (tx, rx) = std::sync::mpsc::sync_channel(1);
                tauri::async_runtime::spawn(async move {
                    let result = export.materialize().await;
                    let _ = tx.send(result);
                });
                // Pump a nested GTK loop while the background queue streams bytes, keeping progress/control responsive.
                let loop_ = glib::MainLoop::new(None, false);
                let wake = loop_.clone();
                let result = Arc::new(Mutex::new(None));
                let slot = result.clone();
                glib::timeout_add_local(std::time::Duration::from_millis(30), move || {
                    match rx.try_recv() {
                        Ok(value) => {
                            *slot.lock().unwrap() = Some(value);
                            wake.quit();
                            glib::ControlFlow::Break
                        }
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                            *slot.lock().unwrap() = Some(Err("拖放下载已结束".into()));
                            wake.quit();
                            glib::ControlFlow::Break
                        }
                        _ => glib::ControlFlow::Continue,
                    }
                });
                loop_.run();
                if result.lock().unwrap().as_ref().is_some_and(Result::is_ok) {
                    // URI receivers may read after drag-end. Only downloaded
                    // exports need retaining; a drop back into the tree does not.
                    data_export
                        .service
                        .files
                        .drag_caches
                        .lock()
                        .unwrap()
                        .push(data_export.directory.clone());
                    let uris: Vec<_> = data_export
                        .sources
                        .iter()
                        .filter_map(|source| source.name().ok())
                        .filter_map(|name| {
                            glib::filename_to_uri(data_export.directory.path().join(name), None)
                                .ok()
                        })
                        .collect();
                    selection.set_uris(&uris.iter().map(|s| s.as_str()).collect::<Vec<_>>());
                }
            });
            handlers.lock().unwrap().push(data_handler);
            let cleanup = handlers.clone();
            let end_handler = widget.connect_drag_end(move |widget, _| {
                remote.lock().unwrap().take();
                if let Some(sender) = finished.lock().unwrap().take() {
                    let _ = sender.send(Ok(()));
                }
                for handler in cleanup.lock().unwrap().drain(..) {
                    widget.disconnect(handler);
                }
            });
            handlers.lock().unwrap().push(end_handler);
            widget.drag_begin_with_coordinates(
                &targets,
                gdk::DragAction::COPY | gdk::DragAction::MOVE,
                1,
                None::<&gdk::Event>,
                -1,
                -1,
            );
        })
        .map_err(|e| e.to_string())?;
    receiver.await.map_err(|_| "拖放窗口已关闭".to_string())?
}
