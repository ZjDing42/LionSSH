use super::*;

pub(super) struct ConnectionTest {
    pub profile: Value,
    pub trust: ssh::TrustSender,
    pub cancel: CancellationToken,
}

struct TestGuard {
    service: Arc<Service>,
    id: String,
}
impl Drop for TestGuard {
    fn drop(&mut self) {
        if let Some(test) = self
            .service
            .connection_tests
            .lock()
            .unwrap()
            .remove(&self.id)
        {
            test.cancel.cancel();
        }
        self.service.host_keys.lock().unwrap().remove(&self.id);
    }
}

impl Service {
    pub(super) fn cancel_connection_test(&self, id: &str) -> Result<(), String> {
        validate_test_id(id)?;
        let tests = self.connection_tests.lock().unwrap();
        if let Some(test) = tests.get(id) {
            test.cancel.cancel();
        } else {
            // IPC requests can start out of order. Remember a bounded number of
            // early cancellations so closing the drawer cannot start a late test.
            let mut cancelled = self.cancelled_connection_tests.lock().unwrap();
            cancelled.retain(|(key, time)| key != id && time.elapsed().as_secs() < 120);
            if cancelled.len() >= 64 {
                cancelled.remove(0);
            }
            cancelled.push((id.to_owned(), std::time::Instant::now()));
        }
        self.host_keys.lock().unwrap().remove(id);
        Ok(())
    }

    pub(super) async fn test_connection(self: &Arc<Self>, args: &[Value]) -> Reply {
        let id = string_argument(args, 0, "测试标识")?.to_owned();
        validate_test_id(&id)?;
        let input = argument(args, 1, "设备配置")?;
        if !input.is_object() {
            return Err("设备配置不能为空".into());
        }
        let through = args
            .get(3)
            .filter(|v| !v.is_null())
            .map(|v| v.as_str().ok_or("跳板机标识格式不正确"))
            .transpose()?;
        let mut draft = input.clone();
        if let Some(hop_id) = through {
            let hops = model::jump_hosts(input);
            let index = hops
                .iter()
                .position(|hop| hop["id"] == hop_id)
                .ok_or("跳板机不存在")?;
            draft = hops[index].clone();
            if !draft.is_object() {
                return Err("跳板机配置格式不正确".into());
            }
            draft["id"] = input["id"].clone();
            draft["jumpHosts"] = json!(&hops[..index]);
        }
        if draft["name"].as_str().unwrap_or("").trim().is_empty() {
            draft["name"] = json!("连接测试");
        }
        draft["tunnels"] = json!([]);
        draft["gpu"] = json!({"enabled":false});
        let profile = model::normalize_profile(&draft)?;
        let (trust, receiver) = ssh::trust_channel();
        let cancel = CancellationToken::new();
        {
            let mut tests = self.connection_tests.lock().unwrap();
            let mut cancelled = self.cancelled_connection_tests.lock().unwrap();
            cancelled.retain(|(_, time)| time.elapsed().as_secs() < 120);
            if let Some(index) = cancelled.iter().position(|(key, _)| key == &id) {
                cancelled.remove(index);
                return Err("连接测试已取消".into());
            }
            if tests.contains_key(&id) || tests.len() >= 4 {
                return Err("连接测试正在进行，请稍后重试".into());
            }
            tests.insert(
                id.clone(),
                ConnectionTest {
                    profile: profile.clone(),
                    trust,
                    cancel: cancel.clone(),
                },
            );
        }
        let _guard = TestGuard {
            service: self.clone(),
            id: id.clone(),
        };
        let credentials = self
            .route_credentials(&profile, args.get(2), through, false)
            .await?;
        let trusted = self.route_fingerprints(&profile).await;
        let owner = Arc::downgrade(self);
        let test_id = id.clone();
        let sink: Sink = Arc::new(move |_, mut payload| {
            let Some(owner) = owner.upgrade() else {
                return;
            };
            let tests = owner.connection_tests.lock().unwrap();
            let Some(test) = tests.get(&test_id) else {
                return;
            };
            if test.cancel.is_cancelled() || payload["type"] != "host-key" {
                return;
            }
            payload["profileId"] = json!(test_id);
            payload["connectionTest"] = json!(true);
            owner
                .host_keys
                .lock()
                .unwrap()
                .insert(test_id.clone(), payload.clone());
            drop(tests);
            (owner.sink)("lion:host-key", payload);
        });
        let started = std::time::Instant::now();
        let connection = tokio::select! {
            _ = cancel.cancelled() => return Err("连接测试已取消".into()),
            result = Connection::connect_route(profile.clone(), credentials, trusted, sink, receiver) => result?,
        };
        let elapsed = started.elapsed().as_millis();
        connection.close().await;
        if cancel.is_cancelled() {
            return Err("连接测试已取消".into());
        }
        Ok(
            json!({"ok":true,"elapsedMs":elapsed,"host":profile["host"],"port":profile["port"],"hops":model::jump_hosts(&profile).len()}),
        )
    }

    pub(super) async fn trust_connection_host(&self, args: &[Value]) -> Reply {
        let id = string_argument(args, 0, "设备标识")?;
        let fingerprint = string_argument(args, 2, "主机指纹")?;
        let accepted = argument(args, 1, "确认结果")?
            .as_bool()
            .ok_or("确认结果格式不正确")?;
        let request = self
            .host_keys
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("主机指纹请求已过期")?;
        if request["fingerprint"] != fingerprint {
            return Err("主机指纹请求已过期".into());
        }
        let test = self.connection_tests.lock().unwrap().get(id).map(|test| {
            (
                test.profile.clone(),
                test.trust.clone(),
                test.cancel.clone(),
            )
        });
        let (profile, sender, testing) = if let Some((profile, sender, cancel)) = test {
            if cancel.is_cancelled() {
                return Err("连接测试已取消".into());
            }
            (profile, sender, true)
        } else {
            let device = self
                .devices
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or("连接已关闭")?;
            let profile = device.profile.lock().unwrap().clone();
            let sender = device
                .trust
                .lock()
                .unwrap()
                .clone()
                .ok_or("主机指纹请求已过期")?;
            (profile, sender, false)
        };
        let index = request["routeIndex"]
            .as_u64()
            .unwrap_or(model::jump_hosts(&profile).len() as u64) as usize;
        let endpoints = model::connection_endpoints(&profile);
        let endpoint = endpoints.get(index).ok_or("主机指纹请求已过期")?;
        if endpoint["host"] != request["host"] || endpoint["port"] != request["port"] {
            return Err("主机指纹请求已过期".into());
        }
        if accepted {
            self.store
                .lock()
                .await
                .as_mut()
                .unwrap()
                .trust(endpoint, fingerprint)?;
        }
        // Remove the old request BEFORE waking the next hop: keys can share fingerprints.
        self.host_keys.lock().unwrap().remove(id);
        if !testing {
            self.status(id, "connecting", None);
        }
        sender
            .send(HostDecision {
                fingerprint: fingerprint.into(),
                accepted,
            })
            .map_err(|_| "主机指纹请求已过期")?;
        Ok(Value::Null)
    }
}

fn validate_test_id(id: &str) -> Result<(), String> {
    if id
        .strip_prefix("probe:")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
    {
        Ok(())
    } else {
        Err("测试标识格式不正确".into())
    }
}
