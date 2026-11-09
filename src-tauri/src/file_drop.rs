//! Native drop acceptance follows the visible file tree, not the whole webview.
use crate::transfers::Location;
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    scale: f64,
    #[serde(default)]
    move_allowed: bool,
    #[serde(default)]
    move_rows: Vec<MoveRow>,
}
#[derive(Clone, Deserialize)]
struct MoveRow {
    top: f64,
    bottom: f64,
    allowed: bool,
}
#[derive(Default)]
pub struct DropState {
    region: Mutex<Option<Region>>,
    remote: Mutex<Option<(usize, Vec<Location>)>>,
    #[cfg(windows)]
    handles: Mutex<Vec<isize>>,
}
impl DropState {
    pub fn update(&self, region: Option<Region>) -> Result<(), String> {
        if region.as_ref().is_some_and(|r| {
            ![r.left, r.top, r.right, r.bottom, r.scale]
                .iter()
                .all(|v| v.is_finite())
                || r.left < 0.0
                || r.top < 0.0
                || r.right < r.left
                || r.bottom < r.top
                || r.scale <= 0.0
                || r.scale > 8.0
                || r.move_rows.len() > 10_000
                || r.move_rows.iter().any(|row| {
                    !row.top.is_finite() || !row.bottom.is_finite() || row.top > row.bottom
                })
        }) {
            return Err("拖放区域无效".into());
        }
        *self.region.lock().unwrap() = region;
        Ok(())
    }
    fn accepts(&self, x: f64, y: f64) -> bool {
        self.region
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|r| x >= r.left && x < r.right && y >= r.top && y < r.bottom)
    }
    fn accepts_remote(&self, x: f64, y: f64) -> bool {
        self.region.lock().unwrap().as_ref().is_some_and(|r| {
            x >= r.left
                && x < r.right
                && y >= r.top
                && y < r.bottom
                && r.move_rows
                    .iter()
                    .find(|row| y >= row.top && y < row.bottom)
                    .map(|row| row.allowed)
                    .unwrap_or(r.move_allowed)
        })
    }
    pub fn begin_remote(self: &Arc<Self>, identity: usize, sources: Vec<Location>) -> RemoteDrag {
        *self.remote.lock().unwrap() = Some((identity, sources));
        RemoteDrag {
            state: self.clone(),
            identity,
        }
    }
    fn remote_sources(&self, identity: usize) -> Option<Vec<Location>> {
        self.remote
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(id, _)| *id == identity)
            .map(|(_, sources)| sources.clone())
    }
    #[cfg(windows)]
    fn scale(&self) -> f64 {
        self.region
            .lock()
            .unwrap()
            .as_ref()
            .map(|r| r.scale)
            .unwrap_or(1.0)
    }
}
pub struct RemoteDrag {
    state: Arc<DropState>,
    identity: usize,
}
impl Drop for RemoteDrag {
    fn drop(&mut self) {
        let mut remote = self.state.remote.lock().unwrap();
        if remote.as_ref().is_some_and(|(id, _)| *id == self.identity) {
            remote.take();
        }
    }
}
fn emit_remote(window: &tauri::WebviewWindow, kind: &str, x: f64, y: f64, sources: Vec<Location>) {
    let _ = window.emit(
        "lion:file-drop",
        json!({"type":kind,"x":x,"y":y,"paths":[],"sources":sources,"logical":true}),
    );
}
fn emit(window: &tauri::WebviewWindow, kind: &str, x: f64, y: f64, paths: Vec<std::path::PathBuf>) {
    let _ = window.emit(
        "lion:file-drop",
        json!({"type":kind,"x":x,"y":y,"paths":paths,"logical":true}),
    );
}
pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    let state = Arc::new(DropState::default());
    window.app_handle().manage(state.clone());
    #[cfg(windows)]
    return windows::install(window, state);
    #[cfg(target_os = "linux")]
    return linux::install(window, state);
    #[cfg(target_os = "macos")]
    return macos::install(window, state);
}
pub fn uninstall(window: &tauri::Window) {
    #[cfg(windows)]
    if let Some(state) = window.app_handle().try_state::<Arc<DropState>>() {
        windows::uninstall(&state);
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_visible_tree_accepts_drops() {
        let state = DropState::default();
        assert!(!state.accepts(20.0, 20.0));
        state
            .update(Some(Region {
                left: 10.0,
                top: 20.0,
                right: 310.0,
                bottom: 800.0,
                scale: 1.5,
                move_allowed: false,
                move_rows: Vec::new(),
            }))
            .unwrap();
        assert!(state.accepts(10.0, 20.0));
        assert!(!state.accepts(310.0, 21.0));
        assert!(!state.accepts(100.0, 19.0));
        assert!(!state.accepts(100.0, 800.0));
        state.update(None).unwrap();
        assert!(!state.accepts(20.0, 30.0));
    }
    #[test]
    fn returning_remote_drag_keeps_identity_and_only_accepts_valid_move_rows() {
        let state = Arc::new(DropState::default());
        state.update(Some(serde_json::from_value(json!({
            "left":10,"top":20,"right":310,"bottom":800,"scale":1,
            "moveAllowed":false,
            "moveRows":[{"top":40,"bottom":70,"allowed":true},{"top":70,"bottom":100,"allowed":false}]
        })).unwrap())).unwrap();
        let source = Location {
            profile_id: Some("server".into()),
            path: "/home/tester/A".into(),
        };
        let drag = state.begin_remote(42, vec![source]);
        assert!(state.remote_sources(41).is_none());
        assert_eq!(state.remote_sources(42).unwrap()[0].path, "/home/tester/A");
        assert!(!state.accepts_remote(400.0, 50.0)); // Outside: the OS can download.
        assert!(state.accepts_remote(100.0, 50.0)); // Back over another folder: move.
        assert!(!state.accepts_remote(100.0, 80.0)); // Source/self/descendants are rejected.
        assert!(!state.accepts_remote(100.0, 110.0)); // Moving to the same parent is rejected.
        assert!(state.accepts(100.0, 110.0)); // External uploads still accept tree whitespace.
        assert_eq!(state.remote_sources(42).unwrap().len(), 1);
        state.update(None).unwrap();
        assert!(!state.accepts_remote(100.0, 50.0));
        drop(drag);
        assert!(state.remote_sources(42).is_none());
    }
}
