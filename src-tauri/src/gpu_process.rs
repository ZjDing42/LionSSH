//! Fixed Linux process queries. No renderer-supplied shell text is accepted.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub struct StopTicket {
    pub pid: u32,
    pub uid: u32,
    pub started: u64,
    pub expires: u64,
}

pub fn pid(value: &Value) -> Result<u32, String> {
    value
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 1)
        .ok_or_else(|| "GPU 进程编号无效".into())
}

pub fn query(pids: &[u32]) -> Result<String, String> {
    if pids.is_empty() || pids.len() > 4096 || pids.iter().any(|pid| *pid <= 1) {
        return Err("GPU 进程编号无效".into());
    }
    let list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        r#"# Lion GPU process query v1
LC_ALL=C
export LC_ALL
uid=$(id -u) || exit 1
printf 'LION_GPU_PROCESSES_V1\t%s\n' "$uid"
rows=$(ps -p {list} -o pid=,uid=,user:128=,etimes=)
result=$?
if [ "$result" -gt 1 ]; then exit "$result"; fi
printf '%s\n' "$rows" | while read -r pid owner username elapsed; do
  [ -n "$pid" ] || continue
  started=0
  if IFS= read -r statline 2>/dev/null < "/proc/$pid/stat"; then
    fields=${{statline##*) }}
    set -- $fields
    if [ "$#" -ge 20 ]; then shift 19; started=$1; fi
  fi
  printf 'PROCESS\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$owner" "$username" "$elapsed" "$started"
done
printf 'END\n'"#
    ))
}

pub fn parse(output: &str, requested: &[u32]) -> Result<HashMap<u32, Value>, String> {
    let mut lines = output.trim().lines();
    let uid = lines
        .next()
        .and_then(|line| line.strip_prefix("LION_GPU_PROCESSES_V1\t"))
        .and_then(|v| v.parse::<u32>().ok())
        .ok_or("无法读取 GPU 进程归属")?;
    let allowed: HashSet<_> = requested.iter().copied().collect();
    let mut result = HashMap::new();
    let mut ended = false;
    for line in lines {
        if line == "END" && !ended {
            ended = true;
            continue;
        }
        let fields = line.split('\t').collect::<Vec<_>>();
        if ended || fields.len() != 6 || fields[0] != "PROCESS" {
            return Err("GPU 进程信息不完整".into());
        }
        let pid = fields[1].parse::<u32>().map_err(|_| "GPU 进程编号无效")?;
        let owner = fields[2]
            .parse::<u32>()
            .map_err(|_| "无法读取 GPU 进程归属")?;
        let elapsed = fields[4].parse::<u64>().map_err(|_| "GPU 进程信息不完整")?;
        let started = fields[5].parse::<u64>().map_err(|_| "GPU 进程信息不完整")?;
        if !allowed.contains(&pid)
            || fields[3].is_empty()
            || fields[3].chars().any(char::is_control)
            || result.contains_key(&pid)
        {
            return Err("GPU 进程信息不完整".into());
        }
        result.insert(
            pid,
            json!({"uid":owner,"username":fields[3],"elapsedSeconds":elapsed,
            "startTicks":started.to_string(),"canStop":owner==uid && started>0}),
        );
    }
    if !ended {
        return Err("GPU 进程信息不完整".into());
    }
    Ok(result)
}

pub fn stop_command(ticket: &StopTicket, mode: &str) -> Result<String, String> {
    if ticket.pid <= 1 || ticket.started == 0 {
        return Err("GPU 进程编号无效".into());
    }
    let signal = match mode {
        "terminate" => "TERM",
        "kill" => "KILL",
        _ => return Err("结束进程方式无效".into()),
    };
    let StopTicket {
        pid, uid, started, ..
    } = ticket;
    Ok(format!(
        r#"# Lion GPU process stop v1
LC_ALL=C
export LC_ALL
[ "$(id -u)" = '{uid}' ] || {{ printf '只能结束自己的 GPU 进程\n' >&2; exit 1; }}
cd /proc/{pid} 2>/dev/null || {{ printf '进程已经退出，请刷新列表\n' >&2; exit 1; }}
IFS= read -r statline < stat || exit 1
fields=${{statline##*) }}
set -- $fields
[ "$#" -ge 20 ] || exit 1
shift 19
[ "$1" = '{started}' ] || {{ printf '进程已变化，请重新确认\n' >&2; exit 1; }}
owners=$(awk '/^Uid:/ {{ print $2, $3, $4, $5 }}' status) || exit 1
[ "$owners" = '{uid} {uid} {uid} {uid}' ] || {{ printf '只能结束自己的 GPU 进程\n' >&2; exit 1; }}
kill -{signal} {pid} || exit 1
printf 'LION_GPU_SIGNAL_SENT\n'"#
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_and_identity_are_required_before_enabling_stop() {
        let rows = parse("LION_GPU_PROCESSES_V1\t1006\nPROCESS\t400\t1006\tdzj\t60\t1234\nPROCESS\t401\t1007\tother\t120\t2222\nPROCESS\t402\t1006\tdzj\t2\t0\nEND\n", &[400,401,402]).unwrap();
        assert_eq!(rows[&400]["canStop"], true);
        assert_eq!(rows[&401]["canStop"], false);
        assert_eq!(rows[&402]["canStop"], false);
        assert!(parse("LION_GPU_PROCESSES_V1\t1006\n", &[400]).is_err());
        assert!(parse(
            "LION_GPU_PROCESSES_V1\t1006\nPROCESS\t999\t1006\tdzj\t60\t1234\nEND",
            &[400]
        )
        .is_err());
    }
    #[test]
    fn signals_only_accept_one_positive_pid_and_fixed_modes() {
        for value in [
            json!(0),
            json!(1),
            json!(-2),
            json!("400; touch /tmp/no"),
            json!(4294967296_u64),
        ] {
            assert!(pid(&value).is_err());
        }
        let ticket = StopTicket {
            pid: 400,
            uid: 1006,
            started: 1234,
            expires: 0,
        };
        assert!(stop_command(&ticket, "terminate")
            .unwrap()
            .contains("kill -TERM 400 || exit 1"));
        assert!(stop_command(&ticket, "kill")
            .unwrap()
            .contains("kill -KILL 400 || exit 1"));
        assert!(stop_command(&ticket, "TERM; true").is_err());
        assert!(query(&[0]).is_err());
        assert!(query(&[400, 401]).unwrap().contains("ps -p 400,401"));
    }
}
