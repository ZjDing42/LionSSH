use super::{emit, emit_remote, DropState};
use gtk::{gdk, glib, prelude::*, DestDefaults, TargetEntry, TargetFlags};
use std::sync::Arc;
fn remote_sources(
    state: &DropState,
    context: &gdk::DragContext,
) -> Option<Vec<crate::transfers::Location>> {
    context
        .drag_get_source_widget()
        .and_then(|widget| state.remote_sources(widget.as_ptr() as usize))
}

pub fn install(window: &tauri::WebviewWindow, state: Arc<DropState>) -> Result<(), String> {
    let owner = window.clone();
    window
        .with_webview(move |native| {
            let view = native.inner();
            view.drag_dest_set(
                DestDefaults::empty(),
                &[TargetEntry::new("text/uri-list", TargetFlags::OTHER_APP, 0)],
                gdk::DragAction::COPY | gdk::DragAction::MOVE,
            );
            view.drag_dest_set_track_motion(true);
            let motion_state = state.clone();
            let motion_window = owner.clone();
            view.connect_drag_motion(move |view, context, x, y, time| {
                if let Some(sources) = remote_sources(&motion_state, context) {
                    context.drag_status(
                        if motion_state.accepts_remote(x as f64, y as f64) {
                            gdk::DragAction::MOVE
                        } else {
                            gdk::DragAction::empty()
                        },
                        time,
                    );
                    emit_remote(&motion_window, "over", x as f64, y as f64, sources);
                    return true;
                }
                let accept = motion_state.accepts(x as f64, y as f64)
                    && view.drag_dest_find_target(context, None).is_some()
                    && context.actions().contains(gdk::DragAction::COPY);
                context.drag_status(
                    if accept {
                        gdk::DragAction::COPY
                    } else {
                        gdk::DragAction::empty()
                    },
                    time,
                );
                emit(&motion_window, "over", x as f64, y as f64, Vec::new());
                true
            });
            let drop_state = state.clone();
            let drop_window = owner.clone();
            view.connect_drag_drop(move |view, context, x, y, time| {
                if let Some(sources) = remote_sources(&drop_state, context) {
                    let accept = drop_state.accepts_remote(x as f64, y as f64);
                    if accept {
                        emit_remote(&drop_window, "drop", x as f64, y as f64, sources);
                    }
                    context.drag_finish(accept, false, time);
                    return true;
                }
                if drop_state.accepts(x as f64, y as f64) {
                    if let Some(target) = view.drag_dest_find_target(context, None) {
                        view.drag_get_data(context, &target, time);
                        return true;
                    }
                }
                context.drag_finish(false, false, time);
                true
            });
            let data_window = owner.clone();
            view.connect_drag_data_received(move |view, context, x, y, data, _, time| {
                let paths: Vec<_> = data
                    .uris()
                    .iter()
                    .filter_map(|uri| glib::filename_from_uri(uri).ok())
                    .filter(|(_, host)| {
                        host.as_ref()
                            .is_none_or(|h| h.is_empty() || h == "localhost")
                    })
                    .map(|(path, _)| path)
                    .collect();
                let accept =
                    state.accepts(x as f64, y as f64) && !paths.is_empty() && paths.len() <= 256;
                if accept {
                    emit(&data_window, "drop", x as f64, y as f64, paths);
                }
                context.drag_finish(accept, false, time);
                view.stop_signal_emission_by_name("drag-data-received");
            });
            view.connect_drag_leave(move |_, _, _| emit(&owner, "leave", 0.0, 0.0, Vec::new()));
        })
        .map_err(|e| e.to_string())
}
