//! SFTP operations reuse authenticated SSH transports. File bytes never enter the store.
use crate::{service::Service, ssh::Connection, transfers::Transfers};
use base64::{engine::general_purpose::STANDARD, Engine};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex as AsyncMutex,
};

pub const TEXT_LIMIT: usize = 5 * 1024 * 1024;
const PREVIEW_LIMIT: u64 = 20 * 1024 * 1024;
type CachedSession = Arc<AsyncMutex<Option<(Arc<Connection>, Arc<SftpSession>)>>>;

pub struct FileManager {
    sessions: Mutex<HashMap<String, CachedSession>>,
    pub download_directory: Mutex<Option<std::path::PathBuf>>,
    #[cfg(target_os = "linux")]
    pub drag_caches: Mutex<Vec<Arc<tempfile::TempDir>>>,
    pub transfers: Arc<Transfers>,
}

pub fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("缺少文件参数：{key}"))
}
pub fn valid_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 32768 || path.contains('\0') {
        return Err("文件路径无效".into());
    }
    Ok(())
}
pub fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.len() > 255
        || name.contains(['/', '\0'])
    {
        return Err("文件名无效".into());
    }
    Ok(())
}
pub fn join(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}
pub fn parent(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(p, _)| if p.is_empty() { "/" } else { p })
        .unwrap_or(".")
}
pub fn name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

impl FileManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            download_directory: Mutex::new(None),
            #[cfg(target_os = "linux")]
            drag_caches: Mutex::new(Vec::new()),
            transfers: Transfers::new(),
        })
    }
    pub fn stop(&self) {
        self.transfers.stop();
        self.sessions.lock().unwrap().clear();
    }
    pub fn invalidate(&self, profile: &str) {
        self.sessions.lock().unwrap().remove(profile);
    }

    pub async fn session(
        &self,
        service: &Service,
        profile: &str,
    ) -> Result<Arc<SftpSession>, String> {
        let connection = service.file_connection(profile)?;
        let cache = self
            .sessions
            .lock()
            .unwrap()
            .entry(profile.into())
            .or_insert_with(|| Arc::new(AsyncMutex::new(None)))
            .clone();
        let mut cached = cache.lock().await;
        if let Some((owner, session)) = cached.as_ref() {
            if Arc::ptr_eq(owner, &connection) {
                return Ok(session.clone());
            }
        }
        let session = Arc::new(connection.open_sftp().await?);
        *cached = Some((connection, session.clone()));
        Ok(session)
    }

    pub async fn request(
        self: &Arc<Self>,
        service: &Arc<Service>,
        action: &str,
        args: &Value,
    ) -> Result<Value, String> {
        match action {
            "transfers" => return Ok(self.transfers.list()),
            "transfer" => return self.transfers.enqueue(service, args).await,
            "control" => return self.transfers.control(service, args),
            _ => {}
        }
        let profile = field(args, "profileId")?;
        let session = self.session(service, profile).await?;
        let path = args["path"].as_str().unwrap_or(".");
        valid_path(path)?;
        let path = if path == "~" {
            ".".into()
        } else if let Some(tail) = path.strip_prefix("~/") {
            join(
                &session.canonicalize(".").await.map_err(|e| e.to_string())?,
                tail,
            )
        } else {
            path.to_owned()
        };
        let result = match action {
            "list" => list(&session, &path).await,
            "complete" => {
                let (directory, prefix) = path
                    .rsplit_once('/')
                    .map(|(p, n)| (if p.is_empty() { "/" } else { p }, n))
                    .unwrap_or((".", path.as_str()));
                let directory = session
                    .canonicalize(directory)
                    .await
                    .map_err(|e| e.to_string())?;
                let mut choices = Vec::new();
                for entry in session
                    .read_dir(directory.clone())
                    .await
                    .map_err(|e| e.to_string())?
                {
                    let label = entry.file_name();
                    if !label.starts_with(prefix) || valid_name(&label).is_err() {
                        continue;
                    }
                    let candidate = join(&directory, &label);
                    let directory = entry.file_type().is_dir()
                        || entry.file_type().is_symlink()
                            && session
                                .metadata(candidate.clone())
                                .await
                                .is_ok_and(|m| m.is_dir());
                    if directory {
                        choices.push(candidate);
                    }
                }
                choices.sort();
                choices.truncate(100);
                Ok(json!(choices))
            }
            "read" => read(&session, &path).await,
            "save" => {
                save(
                    &session,
                    service.file_connection(profile)?.as_ref(),
                    &path,
                    args,
                )
                .await
            }
            "create" => {
                let label = field(args, "name")?;
                valid_name(label)?;
                let target = join(&path, label);
                if args["directory"] == true {
                    session
                        .create_dir(target.clone())
                        .await
                        .map_err(|e| e.to_string())?;
                } else {
                    session
                        .open_with_flags(
                            target.clone(),
                            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                        )
                        .await
                        .map_err(|e| e.to_string())?
                        .shutdown()
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Ok(json!({"path":target}))
            }
            "rename" => {
                let label = field(args, "name")?;
                valid_name(label)?;
                let target = join(parent(&path), label);
                if target != path {
                    if session
                        .try_exists(target.clone())
                        .await
                        .map_err(|e| e.to_string())?
                    {
                        return Err("目标名称已经存在".into());
                    }
                    session
                        .rename(path.clone(), target.clone())
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Ok(json!({"path":target}))
            }
            "move" => move_entry(&session, &path, field(args, "target")?).await,
            "delete" => delete_entry(&session, &path).await,
            _ => Err("不支持的文件操作".into()),
        };
        if result.is_err() {
            self.sessions.lock().unwrap().remove(profile);
        }
        result
    }
}

// Resolve the parent only: moving/deleting a symlink acts on the link itself.
async fn entry_path(session: &SftpSession, path: &str) -> Result<String, String> {
    valid_path(path)?;
    let path = path.trim_end_matches('/');
    valid_name(name(path))?;
    let directory = session
        .canonicalize(parent(path))
        .await
        .map_err(|e| e.to_string())?;
    Ok(join(&directory, name(path)))
}

async fn move_entry(session: &SftpSession, path: &str, target: &str) -> Result<Value, String> {
    let source = entry_path(session, path).await?;
    valid_path(target)?;
    let target = session
        .canonicalize(target)
        .await
        .map_err(|e| e.to_string())?;
    if !session
        .metadata(target.clone())
        .await
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("移动目标必须是文件夹".into());
    }
    let metadata = session
        .symlink_metadata(source.clone())
        .await
        .map_err(|e| e.to_string())?;
    if metadata.is_dir() && (target == source || target.starts_with(&format!("{source}/"))) {
        return Err("不能将文件夹移动到自身或其子目录".into());
    }
    let destination = join(&target, name(&source));
    if source != destination {
        match session.symlink_metadata(destination.clone()).await {
            Ok(_) => return Err("目标名称已经存在，移动未执行".into()),
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile => {}
            Err(error) => return Err(error.to_string()),
        }
        // Standard SFTP rename refuses existing destinations; never overwrite.
        session
            .rename(source, destination.clone())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(json!({"path":destination}))
}

async fn delete_entry(session: &SftpSession, path: &str) -> Result<Value, String> {
    let path = entry_path(session, path).await?;
    let mut pending = vec![path.clone()];
    let mut entries = Vec::new();
    while let Some(current) = pending.pop() {
        // Reject changes to intermediate directories instead of following a new symlink.
        if entry_path(session, &current).await? != current {
            return Err("目录路径已改变，请刷新后重试".into());
        }
        let metadata = session
            .symlink_metadata(current.clone())
            .await
            .map_err(|e| e.to_string())?;
        if metadata.is_dir() {
            for entry in session
                .read_dir(current.clone())
                .await
                .map_err(|e| e.to_string())?
            {
                let label = entry.file_name();
                valid_name(&label)?;
                pending.push(join(&current, &label));
            }
        }
        entries.push((current, metadata.is_dir()));
        if entries.len() + pending.len() > 100_000 {
            return Err("目录项目过多，请分批删除".into());
        }
    }
    for (current, directory) in entries.into_iter().rev() {
        if entry_path(session, &current).await? != current {
            return Err("目录路径已改变，请刷新后重试".into());
        }
        if directory {
            session.remove_dir(current).await
        } else {
            session.remove_file(current).await
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(json!({"path":path}))
}

async fn list(session: &SftpSession, path: &str) -> Result<Value, String> {
    let path = session
        .canonicalize(path)
        .await
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for entry in session
        .read_dir(path.clone())
        .await
        .map_err(|e| e.to_string())?
    {
        let label = entry.file_name();
        if valid_name(&label).is_err() {
            continue;
        }
        let metadata = entry.metadata();
        let entry_path = join(&path, &label);
        let directory = metadata.is_dir()
            || metadata.is_symlink()
                && session
                    .metadata(entry_path.clone())
                    .await
                    .is_ok_and(|m| m.is_dir());
        entries.push(json!({"name":label,"path":entry_path,"directory":directory,"symlink":metadata.is_symlink(),"size":metadata.size,"modified":metadata.mtime}));
    }
    entries.sort_by(|a, b| {
        b["directory"]
            .as_bool()
            .cmp(&a["directory"].as_bool())
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(json!({"path":path,"entries":entries}))
}

async fn bytes(session: &SftpSession, path: &str, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = session.metadata(path).await.map_err(|e| e.to_string())?;
    if !metadata.is_regular() {
        return Err("只能打开普通文件".into());
    }
    if metadata.size.is_some_and(|size| size > limit) {
        return Err("文件超过预览大小限制，请下载后打开".into());
    }
    let file = session.open(path).await.map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut result)
        .await
        .map_err(|e| e.to_string())?;
    if result.len() as u64 > limit {
        return Err("文件超过预览大小限制，请下载后打开".into());
    }
    Ok(result)
}
fn image_type(data: &[u8], path: &str) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if data.starts_with(b"BM") {
        Some("image/bmp")
    } else if data.starts_with(b"\0\0\x01\0") {
        Some("image/x-icon")
    } else if path.to_ascii_lowercase().ends_with(".svg")
        && std::str::from_utf8(data).is_ok_and(|s| s.contains("<svg"))
    {
        Some("image/svg+xml")
    } else {
        None
    }
}
fn decode(data: &[u8]) -> Result<(String, &'static str), String> {
    if data.starts_with(b"\xff\xfe") || data.starts_with(b"\xfe\xff") {
        if data.len() % 2 != 0 {
            return Err("UTF-16 文件长度无效".into());
        }
        let le = data.starts_with(b"\xff\xfe");
        let words: Vec<_> = data[2..]
            .chunks_exact(2)
            .map(|p| {
                if le {
                    u16::from_le_bytes([p[0], p[1]])
                } else {
                    u16::from_be_bytes([p[0], p[1]])
                }
            })
            .collect();
        return String::from_utf16(&words)
            .map(|s| (s, if le { "utf16le" } else { "utf16be" }))
            .map_err(|_| "无法解码文本，请下载后打开".into());
    }
    if data.contains(&0) {
        return Err("二进制文件，请下载后打开".into());
    }
    let (content, encoding) = if data.starts_with(b"\xef\xbb\xbf") {
        (&data[3..], "utf8bom")
    } else {
        (data, "utf8")
    };
    String::from_utf8(content.to_vec())
        .map(|s| (s, encoding))
        .map_err(|_| "文本编码不受支持，请下载后打开".into())
}
async fn read(session: &SftpSession, path: &str) -> Result<Value, String> {
    let data = bytes(session, path, PREVIEW_LIMIT).await?;
    if let Some(mime) = image_type(&data, path) {
        return Ok(
            json!({"kind":"image","data":format!("data:{mime};base64,{}",STANDARD.encode(&data)),"size":data.len()}),
        );
    }
    if data.len() > TEXT_LIMIT {
        return Err("文本超过 5 MiB 编辑限制，请下载后打开".into());
    }
    let (text, encoding) = decode(&data)?;
    Ok(
        json!({"kind":"text","text":text,"encoding":encoding,"revision":digest(&data),"size":data.len()}),
    )
}
async fn save(
    session: &SftpSession,
    connection: &Connection,
    path: &str,
    args: &Value,
) -> Result<Value, String> {
    let text = field(args, "text")?;
    // UTF-16 text can expand by 3/2 in the UTF-8 JSON request. The encoded
    // file size below remains the actual editing limit for every encoding.
    if text.len() > TEXT_LIMIT * 3 / 2 {
        return Err("文本超过 5 MiB 编辑限制".into());
    }
    let data: Vec<u8> = match field(args, "encoding")? {
        "utf8" => text.as_bytes().to_vec(),
        "utf8bom" => [b"\xef\xbb\xbf".as_slice(), text.as_bytes()].concat(),
        "utf16le" => b"\xff\xfe"
            .iter()
            .copied()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect(),
        "utf16be" => b"\xfe\xff"
            .iter()
            .copied()
            .chain(text.encode_utf16().flat_map(u16::to_be_bytes))
            .collect(),
        _ => return Err("文本编码不受支持".into()),
    };
    if data.len() > TEXT_LIMIT {
        return Err("编码后的文本超过 5 MiB 编辑限制".into());
    }
    if digest(&bytes(session, path, TEXT_LIMIT as u64).await?) != field(args, "revision")? {
        return Err("服务器上的文件已被修改，请重新打开文件后合并修改".into());
    }
    // Resolve a symlink before replacing, preserving the link itself.
    let target = session
        .canonicalize(path)
        .await
        .map_err(|e| e.to_string())?;
    let metadata = session
        .metadata(target.clone())
        .await
        .map_err(|e| e.to_string())?;
    let temp = join(
        parent(&target),
        &format!(".lion-edit-{}", uuid::Uuid::new_v4()),
    );
    let outcome = async {
        let mut file = session
            .open_with_flags_and_attributes(
                temp.clone(),
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                russh_sftp::protocol::FileAttributes {
                    permissions: metadata.permissions,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        file.write_all(&data).await.map_err(|e| e.to_string())?;
        file.shutdown().await.map_err(|e| e.to_string())?;
        if digest(&bytes(session, &target, TEXT_LIMIT as u64).await?) != field(args, "revision")? {
            return Err("保存期间远程文件发生变化，请重新打开后合并修改".into());
        }
        connection
            .replace_sftp(&temp, &target)
            .await
            .map_err(|e| format!("无法安全替换文件，原文件已保留：{e}"))?;
        Ok(json!({"revision":digest(&data),"size":data.len()}))
    }
    .await;
    if outcome.is_err() {
        let _ = session.remove_file(temp).await;
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_and_encoding_validation() {
        for name in ["", ".", "..", "a/b", "a\0b"] {
            assert!(valid_name(name).is_err());
        }
        assert!(valid_name("中文 ' $(x).py").is_ok());
        assert_eq!(join("/", "data"), "/data");
        assert_eq!(parent("/a"), "/");
        assert_eq!(
            decode(b"\xef\xbb\xbfhello\r\n").unwrap(),
            ("hello\r\n".into(), "utf8bom")
        );
        assert_eq!(decode(b"\xff\xfeA\0").unwrap(), ("A".into(), "utf16le"));
        assert!(decode(b"\0binary").is_err());
    }
}
