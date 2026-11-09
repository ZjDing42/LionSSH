use super::Export;
use std::{
    mem::{size_of, ManuallyDrop},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use windows::{
    core::{implement, Error, IUnknown, IUnknownImpl, Interface, Ref, Result, BOOL, HRESULT},
    Win32::{
        Foundation::*,
        Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL},
        System::{
            Com::*, DataExchange::RegisterClipboardFormatW, Memory::*, Ole::*,
            SystemServices::MODIFIERKEYS_FLAGS,
        },
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, ReleaseCapture, VK_LBUTTON, VK_RBUTTON},
            Shell::*,
            WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON},
        },
    },
};

fn failure(error: impl ToString) -> Error {
    Error::new(E_FAIL, error.to_string())
}
fn open_stream(path: &Path) -> Result<IStream> {
    let wide: Vec<u16> = path
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    unsafe {
        SHCreateStreamOnFileEx(
            windows::core::PCWSTR(wide.as_ptr()),
            (STGM_READ | STGM_SHARE_DENY_WRITE).0,
            0,
            false,
            None,
        )
    }
}
fn format(id: u16, medium: TYMED) -> FORMATETC {
    FORMATETC {
        cfFormat: id,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: medium.0 as u32,
    }
}
unsafe fn memory(bytes: &[u8]) -> Result<STGMEDIUM> {
    let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len())?;
    let buffer = GlobalLock(handle);
    if buffer.is_null() {
        let _ = GlobalFree(Some(handle));
        return Err(Error::from_thread());
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), buffer.cast(), bytes.len());
    let _ = GlobalUnlock(handle);
    Ok(STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: STGMEDIUM_0 { hGlobal: handle },
        pUnkForRelease: ManuallyDrop::new(None),
    })
}

#[implement(IDataObject, IDataObjectAsyncCapability)]
struct RemoteData {
    export: Arc<Export>,
    descriptors: u16,
    contents: u16,
    preferred: u16,
    asynchronous: AtomicBool,
    operation: Mutex<Option<IDataObject>>,
}
impl IDataObjectAsyncCapability_Impl for RemoteData_Impl {
    fn SetAsyncMode(&self, enabled: BOOL) -> Result<()> {
        self.asynchronous.store(enabled.as_bool(), Ordering::SeqCst);
        Ok(())
    }
    fn GetAsyncMode(&self) -> Result<BOOL> {
        Ok(self.asynchronous.load(Ordering::SeqCst).into())
    }
    fn StartOperation(&self, _: Ref<IBindCtx>) -> Result<()> {
        *self.operation.lock().unwrap() = Some(self.to_interface());
        Ok(())
    }
    fn InOperation(&self) -> Result<BOOL> {
        Ok(self.operation.lock().unwrap().is_some().into())
    }
    fn EndOperation(&self, _: HRESULT, _: Ref<IBindCtx>, _: u32) -> Result<()> {
        self.operation.lock().unwrap().take();
        Ok(())
    }
}
impl IDataObject_Impl for RemoteData_Impl {
    fn GetData(&self, input: *const FORMATETC) -> Result<STGMEDIUM> {
        if input.is_null() {
            return Err(E_POINTER.into());
        }
        let input = unsafe { &*input };
        self.QueryGetData(input).ok()?;
        if input.cfFormat == self.preferred {
            return unsafe { memory(&DROPEFFECT_COPY.0.to_le_bytes()) };
        }
        let entries = tauri::async_runtime::block_on(self.export.manifest()).map_err(failure)?;
        if input.cfFormat == self.descriptors {
            let mut bytes = vec![0u8; 4 + entries.len() * size_of::<FILEDESCRIPTORW>()];
            bytes[..4].copy_from_slice(&(entries.len() as u32).to_le_bytes());
            for (index, entry) in entries.iter().enumerate() {
                let name: Vec<u16> = entry.relative.to_string_lossy().encode_utf16().collect();
                if name.len() >= 260 {
                    return Err(failure("拖放路径过长，请使用下载按钮"));
                }
                let mut wide = [0u16; 260];
                wide[..name.len()].copy_from_slice(&name);
                let descriptor = FILEDESCRIPTORW {
                    dwFlags: (FD_ATTRIBUTES.0
                        | FD_UNICODE.0
                        | if entry.directory { 0 } else { FD_FILESIZE.0 })
                        as u32,
                    dwFileAttributes: if entry.directory {
                        FILE_ATTRIBUTE_DIRECTORY.0
                    } else {
                        FILE_ATTRIBUTE_NORMAL.0
                    },
                    nFileSizeHigh: (entry.size >> 32) as u32,
                    nFileSizeLow: entry.size as u32,
                    cFileName: wide,
                    ..Default::default()
                };
                unsafe {
                    std::ptr::write_unaligned(
                        bytes
                            .as_mut_ptr()
                            .add(4 + index * size_of::<FILEDESCRIPTORW>())
                            .cast(),
                        descriptor,
                    );
                }
            }
            return unsafe { memory(&bytes) };
        }
        let entry = entries
            .get(usize::try_from(input.lindex).map_err(|_| Error::from(DV_E_LINDEX))?)
            .ok_or_else(|| Error::from(DV_E_LINDEX))?;
        if entry.directory {
            return Err(DV_E_LINDEX.into());
        }
        tauri::async_runtime::block_on(self.export.materialize()).map_err(failure)?;
        let path = self.export.directory.path().join(&entry.relative);
        let stream: IStream = ExportStream {
            inner: open_stream(&path)?,
            path,
            export: self.export.clone(),
        }
        .into();
        Ok(STGMEDIUM {
            tymed: TYMED_ISTREAM.0 as u32,
            u: STGMEDIUM_0 {
                pstm: ManuallyDrop::new(Some(stream)),
            },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }
    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn QueryGetData(&self, input: *const FORMATETC) -> HRESULT {
        if input.is_null() {
            return E_POINTER;
        }
        let f = unsafe { &*input };
        if f.dwAspect != DVASPECT_CONTENT.0 {
            return DV_E_DVASPECT;
        }
        let medium = if f.cfFormat == self.contents {
            TYMED_ISTREAM
        } else if [self.descriptors, self.preferred].contains(&f.cfFormat) {
            TYMED_HGLOBAL
        } else {
            return DV_E_FORMATETC;
        };
        if f.tymed & medium.0 as u32 == 0 {
            DV_E_TYMED
        } else {
            S_OK
        }
    }
    fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, output: *mut FORMATETC) -> HRESULT {
        if !output.is_null() {
            unsafe {
                (*output).ptd = std::ptr::null_mut();
            }
        }
        DATA_S_SAMEFORMATETC
    }
    fn SetData(&self, _: *const FORMATETC, medium: *const STGMEDIUM, release: BOOL) -> Result<()> {
        if release.as_bool() && !medium.is_null() {
            unsafe {
                ReleaseStgMedium(medium.cast_mut());
            }
        }
        Ok(())
    }
    fn EnumFormatEtc(&self, direction: u32) -> Result<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        unsafe {
            SHCreateStdEnumFmtEtc(&[
                format(self.descriptors, TYMED_HGLOBAL),
                format(self.contents, TYMED_ISTREAM),
                format(self.preferred, TYMED_HGLOBAL),
            ])
        }
    }
    fn DAdvise(&self, _: *const FORMATETC, _: u32, _: Ref<IAdviseSink>) -> Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
    fn DUnadvise(&self, _: u32) -> Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

// Keep the cache alive until the receiver releases the final stream, including async Explorer copies.
#[implement(IStream)]
struct ExportStream {
    inner: IStream,
    path: PathBuf,
    export: Arc<Export>,
}
impl ISequentialStream_Impl for ExportStream_Impl {
    fn Read(&self, data: *mut core::ffi::c_void, size: u32, read: *mut u32) -> HRESULT {
        unsafe { self.inner.Read(data, size, Some(read)) }
    }
    fn Write(&self, _: *const core::ffi::c_void, _: u32, _: *mut u32) -> HRESULT {
        STG_E_ACCESSDENIED
    }
}
impl IStream_Impl for ExportStream_Impl {
    fn Seek(&self, offset: i64, origin: STREAM_SEEK, result: *mut u64) -> Result<()> {
        unsafe { self.inner.Seek(offset, origin, Some(result)) }
    }
    fn SetSize(&self, _: u64) -> Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }
    fn CopyTo(
        &self,
        target: Ref<IStream>,
        size: u64,
        read: *mut u64,
        written: *mut u64,
    ) -> Result<()> {
        unsafe {
            self.inner
                .CopyTo(target.as_ref(), size, Some(read), Some(written))
        }
    }
    fn Commit(&self, _: &STGC) -> Result<()> {
        Ok(())
    }
    fn Revert(&self) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Stat(&self, result: *mut STATSTG, flags: &STATFLAG) -> Result<()> {
        unsafe { self.inner.Stat(result, *flags) }
    }
    fn Clone(&self) -> Result<IStream> {
        let mut position = 0;
        unsafe {
            self.inner.Seek(0, STREAM_SEEK_CUR, Some(&mut position))?;
        }
        let inner = open_stream(&self.path)?;
        unsafe {
            inner.Seek(position as i64, STREAM_SEEK_SET, None)?;
        }
        Ok(ExportStream {
            inner,
            path: self.path.clone(),
            export: self.export.clone(),
        }
        .into())
    }
}
#[implement(IDropSource)]
struct Source;
impl IDropSource_Impl for Source_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape.as_bool() {
            DRAGDROP_S_CANCEL
        } else if keys.0 & 1 == 0 {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }
    fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}
pub fn start(
    export: Arc<Export>,
    drop_state: Arc<crate::file_drop::DropState>,
) -> std::result::Result<(), String> {
    static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
    if DRAG_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("已有拖放操作正在进行".into());
    }
    struct DragGuard;
    impl Drop for DragGuard {
        fn drop(&mut self) {
            DRAG_ACTIVE.store(false, Ordering::SeqCst);
        }
    }
    let _guard = DragGuard;
    unsafe {
        // IPC can arrive after the user releases the mouse; never start a phantom drag.
        let primary = if GetSystemMetrics(SM_SWAPBUTTON) == 0 {
            VK_LBUTTON
        } else {
            VK_RBUTTON
        };
        if GetAsyncKeyState(primary.0 as i32) >= 0 {
            return Ok(());
        }
        OleInitialize(None).map_err(|e| e.to_string())?;
        let _ = ReleaseCapture();
        let sources = export.sources.clone();
        let data: IDataObject = RemoteData {
            export,
            descriptors: RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW) as u16,
            contents: RegisterClipboardFormatW(CFSTR_FILECONTENTS) as u16,
            preferred: RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT) as u16,
            asynchronous: AtomicBool::new(true),
            operation: Mutex::new(None),
        }
        .into();
        let identity = data.cast::<IUnknown>().map_err(|e| e.to_string())?;
        let _remote = drop_state.begin_remote(identity.as_raw() as usize, sources);
        let source: IDropSource = Source.into();
        let mut effect = DROPEFFECT_NONE;
        let result = DoDragDrop(
            &data,
            &source,
            DROPEFFECT_COPY | DROPEFFECT_MOVE,
            &mut effect,
        );
        let _ = ReleaseCapture();
        drop(data);
        drop(source);
        drop(identity);
        drop(_remote);
        OleUninitialize();
        result.ok().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{file_drag::ExportEntry, service::Service};
    use windows::core::Interface;

    #[test]
    fn virtual_files_expose_unicode_descriptors_and_keep_streams_alive() {
        unsafe {
            OleInitialize(None).unwrap();
            let directory = Arc::new(tempfile::tempdir().unwrap());
            let cache = directory.path().to_owned();
            std::fs::create_dir(cache.join("文件夹")).unwrap();
            std::fs::write(cache.join("文件夹/hello.txt"), b"payload").unwrap();
            let data_directory = tempfile::tempdir().unwrap();
            let export = Arc::new(Export {
                service: Service::open(
                    data_directory.path().to_owned(),
                    "light",
                    Arc::new(|_, _| {}),
                ),
                sources: vec![],
                directory,
                entries: tokio::sync::OnceCell::new_with(Some(Ok(vec![
                    ExportEntry {
                        relative: "文件夹".into(),
                        directory: true,
                        size: 0,
                    },
                    ExportEntry {
                        relative: "文件夹/hello.txt".into(),
                        directory: false,
                        size: 7,
                    },
                ]))),
                prepared: tokio::sync::OnceCell::new_with(Some(Ok(()))),
            });
            let descriptors = RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW) as u16;
            let contents = RegisterClipboardFormatW(CFSTR_FILECONTENTS) as u16;
            let data: IDataObject = RemoteData {
                export,
                descriptors,
                contents,
                preferred: RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT) as u16,
                asynchronous: AtomicBool::new(true),
                operation: Mutex::new(None),
            }
            .into();
            // Ask the real Windows folder handler whether it accepts these
            // virtual entries, without opening a window or performing a drop.
            let destination = tempfile::tempdir().unwrap();
            let folder: IShellItem = SHCreateItemFromParsingName(
                &windows::core::HSTRING::from(destination.path().as_os_str()),
                None,
            )
            .unwrap();
            let target: IDropTarget = folder.BindToHandler(None, &BHID_SFUIObject).unwrap();
            let mut effect = DROPEFFECT_COPY | DROPEFFECT_MOVE;
            target
                .DragEnter(&data, MODIFIERKEYS_FLAGS(1), POINTL::default(), &mut effect)
                .unwrap();
            target.DragLeave().unwrap();
            assert_eq!(
                effect, DROPEFFECT_COPY,
                "Windows accepts a folder with nested files"
            );
            drop(target);
            drop(folder);
            let asynchronous = data.cast::<IDataObjectAsyncCapability>().unwrap();
            assert!(asynchronous.GetAsyncMode().unwrap().as_bool());
            asynchronous.StartOperation(None).unwrap();
            assert!(asynchronous.InOperation().unwrap().as_bool());
            asynchronous
                .EndOperation(S_OK, None, DROPEFFECT_COPY.0)
                .unwrap();
            assert!(!asynchronous.InOperation().unwrap().as_bool());
            drop(asynchronous);
            let mut descriptor_medium = data.GetData(&format(descriptors, TYMED_HGLOBAL)).unwrap();
            let bytes = GlobalLock(descriptor_medium.u.hGlobal).cast::<u8>();
            assert_eq!(std::ptr::read_unaligned(bytes.cast::<u32>()), 2);
            let descriptor = std::ptr::read_unaligned(
                bytes
                    .add(4 + size_of::<FILEDESCRIPTORW>())
                    .cast::<FILEDESCRIPTORW>(),
            );
            let length = descriptor.nFileSizeLow;
            let name = descriptor.cFileName;
            assert_eq!(length, 7);
            assert!(String::from_utf16_lossy(&name).starts_with("文件夹/hello.txt"));
            let _ = GlobalUnlock(descriptor_medium.u.hGlobal);
            ReleaseStgMedium(&mut descriptor_medium);
            let mut requested = format(contents, TYMED_ISTREAM);
            requested.lindex = 1;
            let mut medium = data.GetData(&requested).unwrap();
            let stream = medium.u.pstm.as_ref().unwrap().clone();
            ReleaseStgMedium(&mut medium);
            drop(data);
            assert!(cache.exists());
            let mut bytes = [0u8; 7];
            let mut count = 0;
            stream
                .Read(bytes.as_mut_ptr().cast(), 7, Some(&mut count))
                .ok()
                .unwrap();
            assert_eq!(count, 7);
            assert_eq!(&bytes, b"payload");
            let clone = stream.Clone().unwrap();
            drop(stream);
            assert!(cache.exists());
            drop(clone);
            assert!(!cache.exists());
            OleUninitialize();
        }
    }
}
