use super::{emit, emit_remote, DropState};
use objc2::{
    runtime::{AnyObject, Bool, ClassBuilder, ProtocolObject, Sel},
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

// The app has one webview. The subclass adds no ivars and preserves Wry's
// layout/deallocation; only NSDraggingDestination callbacks are replaced.
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
            let mut class = ClassBuilder::new(c"LionFileDropWebView", object.class())
                .expect("unique file drop class");
            class.add_method(
                sel!(draggingEntered:),
                motion as extern "C-unwind" fn(_, _, _) -> _,
            );
            class.add_method(
                sel!(draggingUpdated:),
                motion as extern "C-unwind" fn(_, _, _) -> _,
            );
            class.add_method(
                sel!(performDragOperation:),
                drop as extern "C-unwind" fn(_, _, _) -> _,
            );
            class.add_method(
                sel!(draggingExited:),
                leave as extern "C-unwind" fn(_, _, _),
            );
            AnyObject::set_class(object, class.register());
            let view = &*(native.inner() as *const NSView);
            let promises = NSFilePromiseReceiver::readableDraggedTypes();
            let types: Vec<_> = promises.iter().collect();
            let mut references: Vec<_> = types.iter().map(|kind| &**kind).collect();
            references.push(NSPasteboardTypeFileURL);
            view.registerForDraggedTypes(&NSArray::from_slice(&references));
        })
        .map_err(|e| e.to_string())
}
