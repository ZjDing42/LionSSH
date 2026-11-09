use super::{emit, emit_remote, DropState};
use crate::transfers::Location;
use std::{
    ffi::OsString,
    os::windows::ffi::OsStringExt,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use windows::{
    core::{implement, IUnknown, Interface, Ref, BOOL},
    Win32::{
        Foundation::{HWND, LPARAM, POINT, POINTL},
        Graphics::Gdi::ScreenToClient,
        System::{
            Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
            Ole::{
                IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
                CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE, DROPEFFECT_NONE,
            },
            SystemServices::MODIFIERKEYS_FLAGS,
        },
        UI::{
            Shell::{DragQueryFileW, HDROP},
            WindowsAndMessaging::EnumChildWindows,
        },
    },
};

fn paths(data: Ref<'_, IDataObject>) -> Option<Vec<PathBuf>> {
    let format = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    unsafe {
        let mut medium = data.as_ref()?.GetData(&format).ok()?;
        let drop = HDROP(medium.u.hGlobal.0);
        let count = DragQueryFileW(drop, u32::MAX, None);
        let result = if count == 0 || count > 256 {
            None
        } else {
            Some(
                (0..count)
                    .map(|index| {
                        let length = DragQueryFileW(drop, index, None) as usize;
                        let mut wide = vec![0; length + 1];
                        DragQueryFileW(drop, index, Some(&mut wide));
                        PathBuf::from(OsString::from_wide(&wide[..length]))
                    })
                    .collect(),
            )
        };
        ReleaseStgMedium(&mut medium);
        result
    }
}
#[implement(IDropTarget)]
struct Target {
    window: tauri::WebviewWindow,
    state: Arc<DropState>,
    valid: AtomicBool,
    remote: Mutex<Option<Vec<Location>>>,
}
impl Target {
    fn point(&self, point: &POINTL) -> (f64, f64) {
        let mut point = POINT {
            x: point.x,
            y: point.y,
        };
        if let Ok(hwnd) = self.window.hwnd() {
            let _ = unsafe { ScreenToClient(hwnd, &mut point) };
        }
        let scale = self.state.scale();
        (point.x as f64 / scale, point.y as f64 / scale)
    }
    fn effect(&self, point: &POINTL, effect: *mut DROPEFFECT, kind: &str) -> bool {
        let (x, y) = self.point(point);
        let remote = self.remote.lock().unwrap().clone();
        let desired = if remote.is_some() {
            DROPEFFECT_MOVE
        } else {
            DROPEFFECT_COPY
        };
        let accept = self.valid.load(Ordering::Relaxed)
            && if remote.is_some() {
                self.state.accepts_remote(x, y)
            } else {
                self.state.accepts(x, y)
            }
            && unsafe { (*effect).0 & desired.0 != 0 };
        unsafe {
            *effect = if accept { desired } else { DROPEFFECT_NONE };
        }
        if let Some(sources) = remote {
            emit_remote(&self.window, kind, x, y, sources);
        } else {
            emit(
                &self.window,
                if self.valid.load(Ordering::Relaxed) {
                    kind
                } else {
                    "leave"
                },
                x,
                y,
                Vec::new(),
            );
        }
        accept
    }
}
#[allow(non_snake_case)]
impl IDropTarget_Impl for Target_Impl {
    fn DragEnter(
        &self,
        data: Ref<'_, IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let remote = data
            .as_ref()
            .and_then(|data| data.cast::<IUnknown>().ok())
            .and_then(|identity| self.state.remote_sources(identity.as_raw() as usize));
        self.valid
            .store(remote.is_some() || paths(data).is_some(), Ordering::Relaxed);
        *self.remote.lock().unwrap() = remote;
        self.effect(point, effect, "enter");
        Ok(())
    }
    fn DragOver(
        &self,
        _: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        self.effect(point, effect, "over");
        Ok(())
    }
    fn DragLeave(&self) -> windows::core::Result<()> {
        self.valid.store(false, Ordering::Relaxed);
        self.remote.lock().unwrap().take();
        emit(&self.window, "leave", 0.0, 0.0, Vec::new());
        Ok(())
    }
    fn Drop(
        &self,
        data: Ref<'_, IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if self.effect(point, effect, "over") {
            if let Some(sources) = self.remote.lock().unwrap().clone() {
                let (x, y) = self.point(point);
                emit_remote(&self.window, "drop", x, y, sources);
            } else if let Some(paths) = paths(data) {
                let (x, y) = self.point(point);
                emit(&self.window, "drop", x, y, paths);
            } else {
                unsafe {
                    *effect = DROPEFFECT_NONE;
                }
            }
        }
        self.DragLeave()
    }
}
pub fn install(window: &tauri::WebviewWindow, state: Arc<DropState>) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let mut handles = vec![hwnd];
    unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
        (*(data.0 as *mut Vec<HWND>)).push(hwnd);
        true.into()
    }
    unsafe {
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(collect),
            LPARAM(&mut handles as *mut _ as isize),
        );
    }
    let mut registered = state.handles.lock().unwrap();
    for handle in handles {
        let target: IDropTarget = Target {
            window: window.clone(),
            state: state.clone(),
            valid: AtomicBool::new(false),
            remote: Mutex::new(None),
        }
        .into();
        unsafe {
            let _ = RevokeDragDrop(handle);
            if RegisterDragDrop(handle, &target).is_ok() {
                registered.push(handle.0 as isize);
            }
        }
    }
    if registered.is_empty() {
        Err("无法注册文件拖放区域".into())
    } else {
        Ok(())
    }
}
pub fn uninstall(state: &DropState) {
    for handle in state.handles.lock().unwrap().drain(..) {
        let _ = unsafe { RevokeDragDrop(HWND(handle as _)) };
    }
}
