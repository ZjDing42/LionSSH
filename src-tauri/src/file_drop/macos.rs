use super::{emit, emit_remote, DropState};
use objc2::{
    runtime::{AnyClass, AnyObject, Bool, Imp, ProtocolObject, Sel},
    sel, ClassType,
};
use objc2_app_kit::{
    NSDragOperation, NSDraggingInfo, NSFilePromiseReceiver, NSPasteboardTypeFileURL, NSView,
};
use objc2_foundation::{NSArray, NSURL};
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};

// The app has one webview; only its NSDraggingDestination callbacks change.
// Preserve its runtime class: changing isa after NSView initialization breaks
// AppKit's computed-property registrations and aborts on Apple Silicon.
static OWNER: OnceLock<(tauri::WebviewWindow, Arc<DropState>)> = OnceLock::new();
fn remote_sources(
    state: &DropState,
    info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Option<Vec<crate::transfers::Location>> {
    unsafe { info.draggingSource() }.and_then(|_| state.remote_sources(0))
}
fn paths(info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
    unsafe {
        info.draggingPasteboard()
            .readObjectsForClasses_options(&NSArray::arrayWithObject(NSURL::class()), None)
    }
    .map(|objects| {
        objects
            .iter()
            .filter_map(|o| o.downcast::<NSURL>().ok())
            .filter(|url| url.isFileURL())
            .filter_map(|url| url.path())
            .map(|path| PathBuf::from(path.to_string()))
            .collect()
    })
    .unwrap_or_default()
}
fn position(this: &AnyObject, info: &ProtocolObject<dyn NSDraggingInfo>) -> (f64, f64) {
    let view = unsafe { &*(this as *const AnyObject as *const NSView) };
    let point = view.convertPoint_fromView(unsafe { info.draggingLocation() }, None);
    let bounds = view.bounds();
    (
        point.x - bounds.origin.x,
        if view.isFlipped() {
            point.y - bounds.origin.y
        } else {
            bounds.origin.y + bounds.size.height - point.y
        },
    )
}
extern "C-unwind" fn motion(
    this: &AnyObject,
    _: Sel,
    info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
    let Some((window, state)) = OWNER.get() else {
        return NSDragOperation::None;
    };
    let (x, y) = position(this, info);
    if let Some(sources) = remote_sources(state, info) {
        emit_remote(window, "over", x, y, sources);
        return if state.accepts_remote(x, y) {
            NSDragOperation::Copy
        } else {
            NSDragOperation::None
        };
    }
    emit(window, "over", x, y, Vec::new());
    if state.accepts(x, y)
        && unsafe { info.draggingSourceOperationMask() }.contains(NSDragOperation::Copy)
        && !paths(info).is_empty()
    {
        NSDragOperation::Copy
    } else {
        NSDragOperation::None
    }
}
extern "C-unwind" fn drop(
    this: &AnyObject,
    _: Sel,
    info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
    let Some((window, state)) = OWNER.get() else {
        return Bool::NO;
    };
    let (x, y) = position(this, info);
    if let Some(sources) = remote_sources(state, info) {
        if state.accepts_remote(x, y) {
            emit_remote(window, "drop", x, y, sources);
            // The remote move awaits confirmation. Cancel the native promises
            // so the source releases them without creating local downloads.
            return Bool::NO;
        }
        return Bool::NO;
    }
    let paths = paths(info);
    if state.accepts(x, y) && !paths.is_empty() && paths.len() <= 256 {
        emit(window, "drop", x, y, paths);
        Bool::YES
    } else {
        Bool::NO
    }
}
extern "C-unwind" fn leave(_: &AnyObject, _: Sel, _: &ProtocolObject<dyn NSDraggingInfo>) {
    if let Some((window, _)) = OWNER.get() {
        emit(window, "leave", 0.0, 0.0, Vec::new());
    }
}
pub fn install(window: &tauri::WebviewWindow, state: Arc<DropState>) -> Result<(), String> {
    OWNER
        .set((window.clone(), state))
        .map_err(|_| "文件拖放已经初始化")?;
    window
        .with_webview(move |native| unsafe {
            let object = &*(native.inner() as *const AnyObject);
            let class = object.class();
            type Motion = extern "C-unwind" fn(
                &AnyObject,
                Sel,
                &ProtocolObject<dyn NSDraggingInfo>,
            ) -> NSDragOperation;
            type Drop =
                extern "C-unwind" fn(&AnyObject, Sel, &ProtocolObject<dyn NSDraggingInfo>) -> Bool;
            type Leave = extern "C-unwind" fn(&AnyObject, Sel, &ProtocolObject<dyn NSDraggingInfo>);
            // Wry implements all four methods. Replace them on the concrete
            // class without changing its superclass, ivars or NSView state.
            for (selector, implementation) in [
                (
                    sel!(draggingEntered:),
                    std::mem::transmute::<Motion, Imp>(motion),
                ),
                (
                    sel!(draggingUpdated:),
                    std::mem::transmute::<Motion, Imp>(motion),
                ),
                (
                    sel!(performDragOperation:),
                    std::mem::transmute::<Drop, Imp>(drop),
                ),
                (
                    sel!(draggingExited:),
                    std::mem::transmute::<Leave, Imp>(leave),
                ),
            ] {
                let method = class
                    .instance_method(selector)
                    .expect("Wry drag destination method");
                objc2::ffi::class_replaceMethod(
                    class as *const AnyClass as *mut AnyClass,
                    selector,
                    implementation,
                    objc2::ffi::method_getTypeEncoding(method),
                );
            }
            let view = &*(native.inner() as *const NSView);
            let promises = NSFilePromiseReceiver::readableDraggedTypes();
            let types: Vec<_> = promises.iter().collect();
            let mut references: Vec<_> = types.iter().map(|kind| &**kind).collect();
            references.push(NSPasteboardTypeFileURL);
            view.registerForDraggedTypes(&NSArray::from_slice(&references));
        })
        .map_err(|e| e.to_string())
}
