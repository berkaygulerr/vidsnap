// Vidsnap native messaging host (Rust port of host/host.js).
// stdout carries ONLY protocol frames (u32 LE length + UTF-8 JSON).
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
static NULL: Value = Value::Null;

// ---------- paths / config / log ----------
struct Paths {
    config: PathBuf,
    log: PathBuf,
    history: PathBuf,
    state: PathBuf,
    active: PathBuf,
    control: PathBuf,
    ext: PathBuf,
}

static PATHS: LazyLock<Paths> = LazyLock::new(|| {
    let (config, dir) = resolve_paths();
    Paths {
        log: dir.join("host.log"),
        history: dir.join("history.json"),
        state: dir.join("state.json"),
        active: dir.join("active.json"),
        control: dir.join("control"),
        ext: dir.join("extension.json"),
        config,
    }
});

fn resolve_paths() -> (PathBuf, PathBuf) {
    if let Some(v) = std::env::var_os("VIDSNAP_CONFIG") {
        if !v.is_empty() {
            let p = PathBuf::from(v);
            let cfg = std::path::absolute(&p).unwrap_or(p);
            let dir = cfg.parent().map(|d| d.to_path_buf()).unwrap_or_default();
            return (cfg, dir);
        }
    }
    if let Some(ad) = std::env::var_os("APPDATA") {
        let dir = PathBuf::from(ad).join("Vidsnap");
        let cfg = dir.join("config.json");
        if cfg.exists() {
            return (cfg, dir);
        }
    }
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default();
    (dir.join("config.json"), dir)
}

#[derive(Clone)]
struct Config {
    ytdlp: String,
    ffmpeg_dir: String,
    download_dir: String,
}

fn load_config() -> Config {
    let cfg: Value = std::fs::read_to_string(&PATHS.config)
        .ok()
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or(Value::Null);
    let g = |k: &str| cfg.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ytdlp = g("ytdlp");
    let dd = g("downloadDir");
    Config {
        ytdlp: if ytdlp.is_empty() { "yt-dlp".into() } else { ytdlp },
        ffmpeg_dir: g("ffmpegDir"),
        download_dir: if dd.is_empty() {
            let home = std::env::var("USERPROFILE").unwrap_or_default();
            Path::new(&home).join("Downloads").to_string_lossy().into_owned()
        } else {
            dd
        },
    }
}

static CONFIG: LazyLock<Mutex<Config>> = LazyLock::new(|| Mutex::new(load_config()));

fn reload_config() -> Config {
    let c = load_config();
    *CONFIG.lock().unwrap() = c.clone();
    c
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn iso_now() -> String {
    let ms = now_ms();
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    // civil from days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60, ms % 1000
    )
}

fn log(msg: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&PATHS.log) {
        let _ = writeln!(f, "[{}] {}", iso_now(), msg);
    }
}

fn tail_chars(s: &str, n: usize) -> String {
    let c: Vec<char> = s.chars().collect();
    c[c.len().saturating_sub(n)..].iter().collect()
}

// ---------- JSON helpers ----------
fn get<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).unwrap_or(&NULL)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn num_f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9e15 {
        Value::from(f as i64)
    } else {
        Value::from(f)
    }
}

fn js_str(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() => num(f).to_string(),
            _ => n.to_string(),
        },
        other => other.to_string(),
    }
}

fn str_field(v: &Value, k: &str) -> Option<String> {
    match get(v, k) {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

// ---------- stdout framing ----------
static STDOUT: Mutex<()> = Mutex::new(());

fn send(msg: Value) {
    let body = serde_json::to_vec(&msg).unwrap_or_default();
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    let _g = STDOUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&frame);
    let _ = out.flush();
}

fn msg_with_id(req: &Value, fields: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (i, (k, v)) in fields.into_iter().enumerate() {
        m.insert(k.to_string(), v);
        if i == 0 {
            if let Some(id) = req.get("id") {
                m.insert("id".into(), id.clone());
            }
        }
    }
    Value::Object(m)
}

// ---------- job table (running / paused downloads) ----------
#[derive(Clone, Copy, PartialEq)]
enum JobStatus {
    Running,
    Paused,
}

struct Job {
    req: Value, // everything needed to rebuild the yt-dlp command (incl. cookies, memory only)
    akey: String,
    status: JobStatus,
    pid: Option<u32>,
    cancelled: bool,
    stem: Option<String>, // output filename stem, for partial-file cleanup
}

static JOBS: LazyLock<Mutex<HashMap<String, Job>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static JOBS_CV: Condvar = Condvar::new();

fn jobs() -> std::sync::MutexGuard<'static, HashMap<String, Job>> {
    JOBS.lock().unwrap_or_else(|e| e.into_inner())
}

fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

fn job_pause(key: &str) {
    let (target, akey, pid) = {
        let mut g = jobs();
        let j = match g.get_mut(key) {
            Some(j) if j.status == JobStatus::Running && !j.cancelled => j,
            _ => return,
        };
        j.status = JobStatus::Paused;
        (get(&j.req, "id").clone(), j.akey.clone(), j.pid)
    };
    if let Some(pid) = pid {
        kill_tree(pid); // if pid is None, on_spawn kills it as soon as it appears
    }
    active_upsert(&akey, vec![("status", "paused".into()), ("speed", "".into()), ("eta", "".into())]);
    send(json!({"type": "paused", "id": target}));
}

fn job_resume(key: &str) {
    let (target, akey) = {
        let mut g = jobs();
        let j = match g.get_mut(key) {
            Some(j) if j.status == JobStatus::Paused && !j.cancelled => j,
            _ => return,
        };
        j.status = JobStatus::Running;
        (get(&j.req, "id").clone(), j.akey.clone())
    };
    JOBS_CV.notify_all();
    active_upsert(&akey, vec![("status", "running".into()), ("speed", "".into()), ("eta", "".into())]);
    send(json!({"type": "resumed", "id": target}));
}

// the download thread sends the `cancelled` frame after cleaning up partial files
fn job_cancel(key: &str) {
    let pid = {
        let mut g = jobs();
        match g.get_mut(key) {
            Some(j) => {
                j.cancelled = true;
                j.pid
            }
            None => return,
        }
    };
    JOBS_CV.notify_all();
    if let Some(pid) = pid {
        kill_tree(pid);
    }
}

fn job_is_paused(key: &str) -> bool {
    jobs().get(key).map(|j| j.status == JobStatus::Paused).unwrap_or(false)
}

fn any_running() -> bool {
    jobs().values().any(|j| j.status == JobStatus::Running)
}

// file-based control channel for the desktop app: <data>\control\<hostPid>-<requestId>.cmd
fn control_poller() {
    std::thread::spawn(|| {
        let prefix = format!("{}-", std::process::id());
        loop {
            std::thread::sleep(Duration::from_millis(500));
            if jobs().is_empty() {
                continue;
            }
            let rd = match std::fs::read_dir(&PATHS.control) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for ent in rd.flatten() {
                let name = ent.file_name().to_string_lossy().into_owned();
                let stem = match name.strip_suffix(".cmd") {
                    Some(s) if s.starts_with(&prefix) => s.to_string(),
                    _ => continue,
                };
                let cmd = std::fs::read_to_string(ent.path()).unwrap_or_default().trim().to_lowercase();
                let _ = std::fs::remove_file(ent.path());
                let key = jobs().iter().find(|(_, j)| j.akey == stem).map(|(k, _)| k.clone());
                log(&format!("control {} {}", stem, cmd));
                if let Some(key) = key {
                    match cmd.as_str() {
                        "pause" => job_pause(&key),
                        "resume" => job_resume(&key),
                        "cancel" => job_cancel(&key),
                        _ => {}
                    }
                }
            }
        }
    });
}

fn id_key(v: &Value) -> String {
    v.to_string()
}

// ---------- active.json (live downloads for the desktop app) ----------
static OWN: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static ACTIVE_IO: Mutex<()> = Mutex::new(());

fn active_read() -> Vec<Value> {
    std::fs::read_to_string(&PATHS.active)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| if let Value::Array(a) = v { Some(a) } else { None })
        .unwrap_or_default()
}

fn active_write(list: &[Value]) -> std::io::Result<()> {
    let tmp = PathBuf::from(format!("{}.{}.tmp", PATHS.active.display(), std::process::id()));
    std::fs::write(&tmp, serde_json::to_string(list).unwrap_or_default())?;
    std::fs::rename(&tmp, &PATHS.active)
}

// read-modify-write by id; never affects the protocol
fn active_modify(f: impl FnOnce(&mut Vec<Value>)) {
    let _g = ACTIVE_IO.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = active_read();
    f(&mut list);
    let _ = active_write(&list);
}

fn active_upsert(id: &str, fields: Vec<(&str, Value)>) {
    active_modify(|list| {
        let idx = list.iter().position(|e| e.get("id").and_then(|v| v.as_str()) == Some(id));
        let idx = match idx {
            Some(i) => i,
            None => {
                list.push(json!({ "id": id }));
                list.len() - 1
            }
        };
        if let Some(o) = list[idx].as_object_mut() {
            for (k, v) in fields {
                o.insert(k.to_string(), v);
            }
            o.insert("updatedAt".into(), now_ms().into());
        }
    });
}

fn active_remove(id: &str) {
    OWN.lock().unwrap_or_else(|e| e.into_inner()).retain(|x| x != id);
    active_modify(|list| list.retain(|e| e.get("id").and_then(|v| v.as_str()) != Some(id)));
}

fn active_startup() {
    let cutoff = now_ms().saturating_sub(120_000);
    if PATHS.active.exists() {
        active_modify(|list| {
            list.retain(|e| e.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0) >= cutoff)
        });
    }
    // heartbeat: keep our own entries fresh during silent phases (merging etc.)
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(20));
        let own = OWN.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if own.is_empty() {
            continue;
        }
        active_modify(|list| {
            let now = now_ms();
            for e in list.iter_mut() {
                if let Some(id) = e.get("id").and_then(|v| v.as_str()) {
                    if own.iter().any(|x| x == id) {
                        if let Some(o) = e.as_object_mut() {
                            o.insert("updatedAt".into(), now.into());
                        }
                    }
                }
            }
        });
    });
}

// ---------- extension connection record (extension.json) ----------
fn parent_image_name() -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut procs: Vec<(u32, u32, String)> = Vec::new();
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e) != 0;
        while ok {
            let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            procs.push((e.th32ProcessID, e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..n])));
            ok = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
        let me = std::process::id();
        let ppid = procs.iter().find(|p| p.0 == me)?.1;
        procs.iter().find(|p| p.0 == ppid).map(|p| p.2.to_lowercase())
    }
}

fn record_extension() {
    let browser = parent_image_name().filter(|s| !s.is_empty()).unwrap_or_else(|| "unknown".into());
    let origin = std::env::args().nth(1).unwrap_or_default();
    let v = json!({ "connectedAt": now_ms(), "browser": browser, "origin": origin });
    let tmp = PathBuf::from(format!("{}.{}.tmp", PATHS.ext.display(), std::process::id()));
    let res = std::fs::write(&tmp, serde_json::to_string_pretty(&v).unwrap_or_default())
        .and_then(|_| std::fs::rename(&tmp, &PATHS.ext));
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        log(&format!("extension.json error {}", e));
    }
}

// ---------- explorer ----------
fn explorer_raw(raw: &str) {
    let _ = Command::new("explorer.exe").raw_arg(raw).creation_flags(DETACHED_PROCESS).spawn();
}

fn win_path(p: &str) -> String {
    p.replace('/', "\\")
}

// ---------- history ----------
fn add_history(entry: Value) {
    let res = (|| -> std::io::Result<()> {
        let mut list: Vec<Value> = std::fs::read_to_string(&PATHS.history)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
            .and_then(|v| if let Value::Array(a) = v { Some(a) } else { None })
            .unwrap_or_default();
        list.insert(0, entry);
        list.truncate(200);
        let tmp = PathBuf::from(format!("{}.tmp", PATHS.history.display()));
        std::fs::write(&tmp, serde_json::to_string_pretty(&list).unwrap_or_default())?;
        std::fs::rename(&tmp, &PATHS.history)
    })();
    if let Err(e) = res {
        log(&format!("history error {}", e));
    }
}

// ---------- cookies / args ----------
static INFLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn cookies_file(cookies: &Value) -> std::io::Result<Option<PathBuf>> {
    let arr = match cookies.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => return Ok(None),
    };
    let mut text = String::from("# Netscape HTTP Cookie File\n");
    for c in arr {
        let domain_raw = js_str(get(c, "domain"));
        let host_only = truthy(get(c, "hostOnly"));
        let domain = if host_only {
            domain_raw.strip_prefix('.').unwrap_or(&domain_raw).to_string()
        } else if domain_raw.starts_with('.') {
            domain_raw.clone()
        } else {
            format!(".{}", domain_raw)
        };
        let path = str_field(c, "path").unwrap_or_else(|| "/".into());
        let exp = if truthy(get(c, "expirationDate")) { num_f(get(c, "expirationDate")).floor() as i64 } else { 0 };
        let cols = [
            domain,
            (if host_only { "FALSE" } else { "TRUE" }).to_string(),
            path,
            (if truthy(get(c, "secure")) { "TRUE" } else { "FALSE" }).to_string(),
            exp.to_string(),
            js_str(get(c, "name")),
            js_str(get(c, "value")),
        ];
        text.push_str(&cols.join("\t"));
        text.push('\n');
    }
    let file = std::env::temp_dir().join(format!(
        "vidsnap-cookies-{}-{}-{:x}.txt",
        std::process::id(),
        now_ms(),
        COUNTER.fetch_add(1, Ordering::Relaxed) ^ (SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos() as u64).unwrap_or(0) << 8)
    ));
    std::fs::write(&file, text)?;
    Ok(Some(file))
}

// field lookup of {...req, ...cand}
fn merged(req: &Value, cand: &Value, k: &str) -> Option<String> {
    if cand.get(k).is_some() {
        str_field(cand, k)
    } else {
        str_field(req, k)
    }
}

fn common_args(cfg: &Config, req: &Value, cand: &Value, cookie_file: Option<&PathBuf>) -> Vec<String> {
    let mut a: Vec<String> =
        ["--no-playlist", "--no-warnings", "--encoding", "utf-8", "--no-color"].iter().map(|s| s.to_string()).collect();
    if !cfg.ffmpeg_dir.is_empty() {
        a.push("--ffmpeg-location".into());
        a.push(cfg.ffmpeg_dir.clone());
    }
    if let Some(c) = cookie_file {
        a.push("--cookies".into());
        a.push(c.to_string_lossy().into_owned());
    }
    if let Some(r) = merged(req, cand, "referer") {
        a.push("--referer".into());
        a.push(r);
    }
    if let Some(u) = merged(req, cand, "userAgent") {
        a.push("--user-agent".into());
        a.push(u);
    }
    a
}

// ---------- process running ----------
struct RunResult {
    code: i32,
    out: String,
    err: String,
}

fn ytdlp_command(cfg: &Config, args: &[String]) -> Command {
    let mut c = Command::new(&cfg.ytdlp);
    c.args(args)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    c
}

fn run(
    cfg: &Config,
    args: &[String],
    on_spawn: &mut dyn FnMut(u32),
    mut on_line: Option<&mut dyn FnMut(&str)>,
) -> RunResult {
    log(&format!("run {} {}", cfg.ytdlp, serde_json::to_string(args).unwrap_or_default()));
    let mut child = match ytdlp_command(cfg, args).spawn() {
        Ok(c) => c,
        Err(e) => return RunResult { code: -1, out: String::new(), err: format!("\n{}", e) },
    };
    on_spawn(child.id());
    let mut stderr = child.stderr.take().unwrap();
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stderr.read_to_end(&mut b);
        b
    });
    let mut stdout = child.stdout.take().unwrap();
    let mut out: Vec<u8> = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = match stdout.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        out.extend_from_slice(&buf[..n]);
        if let Some(cb) = on_line.as_mut() {
            for &b in &buf[..n] {
                if b == b'\n' || b == b'\r' {
                    if !line.is_empty() {
                        cb(&String::from_utf8_lossy(&line));
                        line.clear();
                    }
                } else {
                    line.push(b);
                }
            }
        }
    }
    if let Some(cb) = on_line.as_mut() {
        if !line.is_empty() {
            cb(&String::from_utf8_lossy(&line));
        }
    }
    let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
    let err = err_t.join().unwrap_or_default();
    RunResult {
        code,
        out: String::from_utf8_lossy(&out).into_owned(),
        err: String::from_utf8_lossy(&err).into_owned(),
    }
}

fn clean_error(err: &str) -> String {
    let lines: Vec<&str> = err.lines().filter(|l| l.to_lowercase().contains("error")).collect();
    let last = lines
        .last()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| err.trim().lines().last().map(|s| s.to_string()).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "Unknown error".into());
    let msg = match last.strip_prefix("ERROR:") {
        Some(r) => r.trim_start().to_string(),
        None => last,
    };
    msg.chars().take(400).collect()
}

// ---------- yt-dlp auto update ----------
type Slot = Arc<(Mutex<Option<bool>>, Condvar)>;
static UPDATING: Mutex<Option<Slot>> = Mutex::new(None);

fn read_state() -> Map<String, Value> {
    std::fs::read_to_string(&PATHS.state)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default()
}

fn update_ytdlp(force: bool) -> bool {
    let slot: Slot;
    {
        let mut g = UPDATING.lock().unwrap();
        if let Some(s) = g.as_ref() {
            let s = s.clone();
            drop(g);
            let (m, cv) = &*s;
            let mut r = m.lock().unwrap();
            while r.is_none() {
                r = cv.wait(r).unwrap();
            }
            return r.unwrap();
        }
        let last = read_state().get("lastUpdate").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let age = now_ms() as f64 - last;
        if age < if force { 600_000.0 } else { 86_400_000.0 } {
            return false;
        }
        slot = Arc::new((Mutex::new(None), Condvar::new()));
        *g = Some(slot.clone());
    }
    let cfg = CONFIG.lock().unwrap().clone();
    log(&format!("yt-dlp update {}", if force { "(forced)" } else { "(daily)" }));
    let mut out = String::new();
    let mut ok = false;
    let mut cmd = Command::new(&cfg.ytdlp);
    cmd.arg("-U")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    if let Ok(mut child) = cmd.spawn() {
        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let mut readers = Vec::new();
        let so = child.stdout.take();
        let se = child.stderr.take();
        for pipe in [so.map(|p| Box::new(p) as Box<dyn Read + Send>), se.map(|p| Box::new(p) as Box<dyn Read + Send>)]
            .into_iter()
            .flatten()
        {
            let b = buf.clone();
            readers.push(std::thread::spawn(move || {
                let mut p = pipe;
                let mut tmp = [0u8; 4096];
                while let Ok(n) = p.read(&mut tmp) {
                    if n == 0 {
                        break;
                    }
                    b.lock().unwrap().extend_from_slice(&tmp[..n]);
                }
            }));
        }
        let start = Instant::now();
        let mut timed_out = false;
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => {}
            }
            if start.elapsed() > Duration::from_secs(90) {
                let _ = child.kill();
                timed_out = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if !timed_out {
            for r in readers {
                let _ = r.join();
            }
        }
        out = String::from_utf8_lossy(&buf.lock().unwrap()).into_owned();
        ok = out.to_lowercase().contains("updated yt-dlp");
    }
    let mut st = read_state();
    st.insert("lastUpdate".into(), Value::from(now_ms()));
    let _ = std::fs::write(&PATHS.state, serde_json::to_string(&Value::Object(st)).unwrap_or_default());
    log(&format!("update result {}", out.trim().lines().last().unwrap_or("")));
    *UPDATING.lock().unwrap() = None;
    let (m, cv) = &*slot;
    *m.lock().unwrap() = Some(ok);
    cv.notify_all();
    ok
}

// ---------- format list ----------
fn build_options(info: &Value) -> Vec<Value> {
    let formats: Vec<&Value> = match info.get("formats").and_then(|f| f.as_array()) {
        Some(a) if !a.is_empty() => a.iter().collect(),
        _ => vec![info],
    };
    let vcodec_none = |f: &Value| get(f, "vcodec").as_str() == Some("none");
    let size_of = |f: &Value| {
        let a = num_f(get(f, "filesize"));
        if a != 0.0 { a } else { num_f(get(f, "filesize_approx")) }
    };
    let mut best_audio = 0f64;
    for f in &formats {
        let ac = get(f, "acodec");
        if vcodec_none(f) && truthy(ac) && ac.as_str() != Some("none") {
            best_audio = best_audio.max(size_of(f));
        }
    }
    // height -> (fps, size)
    let mut by: Vec<(i64, i64, f64)> = Vec::new();
    for f in &formats {
        if vcodec_none(f) || !truthy(get(f, "height")) {
            continue;
        }
        let h = num_f(get(f, "height")) as i64;
        let fps = num_f(get(f, "fps")).round() as i64;
        let sz = size_of(f) + if get(f, "acodec").as_str() == Some("none") { best_audio } else { 0.0 };
        if let Some(g) = by.iter_mut().find(|g| g.0 == h) {
            g.1 = g.1.max(fps);
            g.2 = g.2.max(sz);
        } else {
            by.push((h, fps, sz));
        }
    }
    by.sort_by(|a, b| b.0.cmp(&a.0));
    let mut options: Vec<Value> = by
        .iter()
        .map(|&(h, fps, sz)| {
            json!({
                "label": format!("{}p{}", h, if fps > 30 { fps.to_string() } else { String::new() }),
                "height": h,
                "size": if sz != 0.0 { num(sz) } else { Value::Null },
                "format": format!("bv*[height={h}]+ba/b[height={h}]"),
            })
        })
        .collect();
    if options.is_empty() {
        let sz = size_of(info);
        options.push(json!({
            "label": "Orijinal kalite",
            "height": Value::Null,
            "size": if sz != 0.0 { num(sz) } else { Value::Null },
            "format": "bv*+ba/b",
        }));
    }
    let audio_known = formats.iter().any(|f| truthy(get(f, "acodec")));
    if !audio_known || formats.iter().any(|f| truthy(get(f, "acodec")) && get(f, "acodec").as_str() != Some("none")) {
        options.push(json!({
            "label": "Sadece ses",
            "height": Value::Null,
            "size": if best_audio != 0.0 { num(best_audio) } else { Value::Null },
            "format": "ba/b",
            "audio": true,
            "ext": "MP3",
        }));
    }
    options
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|x| x.1).unwrap_or("");
    let auth = rest.split(|c| c == '/' || c == '?' || c == '#').next().unwrap_or("");
    let auth = auth.rsplit('@').next().unwrap_or("");
    let host = if auth.starts_with('[') { auth } else { auth.split(':').next().unwrap_or("") };
    host.to_lowercase()
}

fn is_youtube(host: &str) -> bool {
    ["youtube.com", "youtu.be", "youtube-nocookie.com"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{}", d)))
}

fn probe(req: &Value) -> Result<Value, String> {
    let cfg = reload_config();
    let cands: Vec<&Value> = req
        .get("candidates")
        .and_then(|c| c.as_array())
        .map(|a| a.iter().filter(|c| truthy(c)).collect())
        .unwrap_or_default();
    let mut errors: Vec<String> = Vec::new();
    for cand in cands {
        let has_cookies = cand.get("cookies").and_then(|c| c.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
        let attempts: &[bool] = if !has_cookies {
            &[false]
        } else if is_youtube(&host_of(&js_str(get(cand, "url")))) {
            &[false, true]
        } else {
            &[true, false]
        };
        for &use_cookies in attempts {
            if let Some(res) = probe_once(&cfg, req, cand, use_cookies, &mut errors)? {
                return Ok(res);
            }
        }
    }
    let msg = errors.first().cloned().unwrap_or_else(|| "No downloadable format found for this video".into());
    Ok(msg_with_id(req, vec![("type", "error".into()), ("message", msg.into())]))
}

fn probe_once(cfg: &Config, req: &Value, cand: &Value, use_cookies: bool, errors: &mut Vec<String>) -> Result<Option<Value>, String> {
    let cookie_file = if use_cookies { cookies_file(get(cand, "cookies")).map_err(|e| e.to_string())? } else { None };
    let result = (|| -> Result<Option<Value>, String> {
        let mut args = common_args(cfg, req, cand, cookie_file.as_ref());
        args.push("-J".into());
        args.push(js_str(get(cand, "url")));
        let r = run(cfg, &args, &mut |_| {}, None);
        if r.code != 0 {
            errors.push(clean_error(&r.err));
            return Ok(None);
        }
        let mut info: Value = serde_json::from_str(&r.out).map_err(|e| e.to_string())?;
        if get(&info, "_type").as_str() == Some("playlist") {
            if let Some(entries) = info.get("entries").and_then(|e| e.as_array()) {
                let found = entries.iter().find(|e| truthy(e) && (truthy(get(e, "formats")) || truthy(get(e, "url")))).cloned();
                info = found.unwrap_or(Value::Null);
            }
        }
        if !truthy(&info) {
            errors.push("Video not found".into());
            return Ok(None);
        }
        let options = build_options(&info);
        let page_title = get(req, "pageTitle");
        let title = if get(cand, "kind").as_str() != Some("page") && truthy(page_title) {
            page_title.clone()
        } else if truthy(get(&info, "title")) {
            get(&info, "title").clone()
        } else {
            Value::from("")
        };
        let mut cand_out = cand.as_object().cloned().unwrap_or_default();
        cand_out.remove("cookies");
        cand_out.insert("noCookies".into(), Value::from(!use_cookies));
        let extractor = ["extractor_key", "extractor"]
            .iter()
            .map(|k| get(&info, k))
            .find(|v| truthy(v))
            .cloned()
            .unwrap_or_else(|| Value::from(""));
        let duration = if truthy(get(&info, "duration")) { get(&info, "duration").clone() } else { Value::Null };
        let mut m = msg_with_id(
            req,
            vec![("type", "formats".into())],
        );
        let mo = m.as_object_mut().unwrap();
        mo.insert("url".into(), get(cand, "url").clone());
        mo.insert("candidate".into(), Value::Object(cand_out));
        mo.insert("title".into(), title);
        mo.insert("extractor".into(), extractor);
        mo.insert("duration".into(), duration);
        mo.insert("options".into(), Value::Array(options));
        Ok(Some(m))
    })();
    if let Some(f) = cookie_file {
        let _ = std::fs::remove_file(f);
    }
    result
}

// ---------- download ----------
fn output_template(cand: &Value, title: &Value, audio: bool) -> String {
    let suffix = if audio { "" } else { "%(height& {}p|)s" };
    let kind = get(cand, "kind");
    if truthy(kind) && kind.as_str() != Some("page") && truthy(title) {
        let t = js_str(title);
        let replaced: String = t
            .chars()
            .map(|c| if "\\/:*?\"<>|".contains(c) || (c as u32) < 0x20 { ' ' } else { c })
            .collect();
        let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
        let safe: String = collapsed.chars().take(120).collect::<String>().trim().replace('%', "%%");
        if !safe.is_empty() {
            return format!("{}{}.%(ext)s", safe, suffix);
        }
    }
    format!("%(title).120B [%(id).40B]{}.%(ext)s", suffix)
}

fn parse_float(s: &str) -> Option<f64> {
    let s = s.trim_start();
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let ds = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    }
    if s[ds..i].chars().all(|c| c == '.') {
        return None;
    }
    s[..i].parse().ok()
}

fn build_dl_args(cfg: &Config, req: &Value, cand: &Value, audio: bool, cookie_file: Option<&PathBuf>) -> Vec<String> {
    let mut args = common_args(cfg, req, cand, cookie_file);
    let fmt = if audio {
        vec!["-f".to_string(), "ba/b".into(), "-x".into(), "--audio-format".into(), "mp3".into(), "--audio-quality".into(), "0".into()]
    } else {
        vec![
            "-f".to_string(),
            str_field(req, "format").unwrap_or_else(|| "bv*+ba/b".into()),
            "-S".into(),
            "vcodec:h264,fps,acodec:aac".into(),
            "--merge-output-format".into(),
            "mp4".into(),
            "--remux-video".into(),
            "mp4".into(),
        ]
    };
    args.extend(fmt);
    // no --no-part: partial files must survive a pause (resume uses --continue, the default)
    for s in ["--no-mtime", "--windows-filenames", "-P"] {
        args.push(s.into());
    }
    args.push(cfg.download_dir.clone());
    args.push("-o".into());
    args.push(output_template(cand, get(req, "title"), audio));
    for s in [
        "--newline",
        "--progress",
        "--progress-template",
        "download:[YTD]%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--print",
        "before_dl:[YTDNAME]%(filename)s",
        "--print",
        "after_move:[YTDFILE]%(filepath)s",
    ] {
        args.push(s.into());
    }
    args.push(if truthy(get(cand, "url")) { js_str(get(cand, "url")) } else { js_str(get(req, "url")) });
    args
}

// partial artefact check on the file-name remainder after the stem (never matches a final file)
fn is_partial_rest(rest: &str) -> bool {
    if !rest.starts_with('.') {
        return false;
    }
    let l = rest.to_lowercase();
    if l.ends_with(".part") || l.ends_with(".ytdl") || l.contains(".part-frag") || l.contains(".temp.") {
        return true;
    }
    // .f<digits>.<ext> intermediate stream
    if let Some(r) = l.strip_prefix(".f") {
        let digits: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() && r[digits.len()..].starts_with('.') {
            return true;
        }
    }
    false
}

fn cleanup_partials(dir: &str, stem: &str) -> usize {
    let mut n = 0;
    for _ in 0..5 {
        let mut left = 0;
        if let Ok(rd) = std::fs::read_dir(dir) {
            for ent in rd.flatten() {
                let name = ent.file_name().to_string_lossy().into_owned();
                if name.len() > stem.len() && name.starts_with(stem) && name.is_char_boundary(stem.len()) && is_partial_rest(&name[stem.len()..]) {
                    if std::fs::remove_file(ent.path()).is_ok() {
                        n += 1;
                    } else {
                        left += 1;
                    }
                }
            }
        }
        if left == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    n
}

enum Outcome {
    Done,
    Cancelled,
    Failed(RunResult),
}

fn download(req: &Value) -> Result<Value, String> {
    let cfg = reload_config();
    let empty = json!({});
    let cand = if truthy(get(req, "candidate")) { get(req, "candidate") } else { &empty };
    let audio = truthy(get(req, "audio"));
    let url = if truthy(get(cand, "url")) { js_str(get(cand, "url")) } else { js_str(get(req, "url")) };

    let key = id_key(get(req, "id"));
    let akey = format!("{}-{}", std::process::id(), js_str(get(req, "id")));
    jobs().insert(
        key.clone(),
        Job { req: req.clone(), akey: akey.clone(), status: JobStatus::Running, pid: None, cancelled: false, stem: None },
    );
    OWN.lock().unwrap_or_else(|e| e.into_inner()).push(akey.clone());
    active_upsert(
        &akey,
        vec![
            ("title", js_str(get(req, "title")).into()),
            ("label", js_str(get(req, "label")).into()),
            ("audio", audio.into()),
            ("url", url.into()),
            ("status", "running".into()),
            ("percent", 0.into()),
            ("stage", 0.into()),
            ("speed", "".into()),
            ("eta", "".into()),
            ("startedAt", now_ms().into()),
        ],
    );
    let mut last_active: u64 = 0;
    let mut last_file: Option<String> = None;
    let mut last_sent: u64 = 0;
    let mut stage_base: i64 = 0;
    let mut cookie_file: Option<PathBuf>;

    let outcome = 'outer: loop {
        // wait while paused; bail out when cancelled
        {
            let mut g = jobs();
            loop {
                let (cancelled, status) = match g.get(&key) {
                    Some(j) => (j.cancelled, j.status),
                    None => (true, JobStatus::Running),
                };
                if cancelled {
                    break 'outer Outcome::Cancelled;
                }
                if status == JobStatus::Paused {
                    g = JOBS_CV.wait(g).unwrap_or_else(|e| e.into_inner());
                    continue;
                }
                break;
            }
        }
        cookie_file = if truthy(get(cand, "noCookies")) {
            None
        } else {
            match cookies_file(get(cand, "cookies")) {
                Ok(f) => f,
                Err(e) => {
                    jobs().remove(&key);
                    active_remove(&akey);
                    return Err(e.to_string());
                }
            }
        };
        let args = build_dl_args(&cfg, req, cand, audio, cookie_file.as_ref());
        let mut run_stage: i64 = 0;
        let mut last_pct: f64 = -1.0;
        let r = {
            let key2 = key.clone();
            run(
                &cfg,
                &args,
                &mut |pid| {
                    let mut g = jobs();
                    if let Some(j) = g.get_mut(&key2) {
                        j.pid = Some(pid);
                        if j.cancelled || j.status == JobStatus::Paused {
                            kill_tree(pid);
                        }
                    }
                },
                Some(&mut |line: &str| {
                    if let Some(rest) = line.strip_prefix("[YTD]") {
                        if job_is_paused(&key) {
                            return;
                        }
                        let parts: Vec<&str> = rest.split('|').map(|s| s.trim()).collect();
                        if let Some(pct) = parts.first().and_then(|s| parse_float(s)) {
                            if pct < last_pct - 50.0 {
                                run_stage += 1;
                            }
                            last_pct = pct;
                            let stage = stage_base.max(run_stage);
                            let now = now_ms();
                            if now.saturating_sub(last_sent) > 400 || pct >= 100.0 {
                                last_sent = now;
                                let mut m = msg_with_id(req, vec![("type", "progress".into())]);
                                let mo = m.as_object_mut().unwrap();
                                mo.insert("percent".into(), num(pct));
                                mo.insert("stage".into(), stage.into());
                                if let Some(s) = parts.get(1) {
                                    mo.insert("speed".into(), (*s).into());
                                }
                                if let Some(e) = parts.get(2) {
                                    mo.insert("eta".into(), (*e).into());
                                }
                                send(m);
                            }
                            if now.saturating_sub(last_active) > 700 {
                                last_active = now;
                                active_upsert(
                                    &akey,
                                    vec![
                                        ("percent", num(pct)),
                                        ("stage", stage.into()),
                                        ("speed", parts.get(1).copied().unwrap_or("").into()),
                                        ("eta", parts.get(2).copied().unwrap_or("").into()),
                                    ],
                                );
                            }
                        }
                    } else if let Some(f) = line.strip_prefix("[YTDNAME]") {
                        let f = f.trim();
                        if let Some(stem) = Path::new(f).file_stem().map(|s| s.to_string_lossy().into_owned()) {
                            if !stem.is_empty() {
                                if let Some(j) = jobs().get_mut(&key) {
                                    j.stem = Some(stem);
                                }
                            }
                        }
                    } else if let Some(f) = line.strip_prefix("[YTDFILE]") {
                        last_file = Some(f.trim().to_string());
                    }
                }),
            )
        };
        if let Some(f) = cookie_file.take() {
            let _ = std::fs::remove_file(f);
        }
        let (cancelled, paused) = {
            let mut g = jobs();
            match g.get_mut(&key) {
                Some(j) => {
                    j.pid = None;
                    (j.cancelled, j.status == JobStatus::Paused)
                }
                None => (true, false),
            }
        };
        if r.code == 0 {
            break Outcome::Done;
        }
        if cancelled {
            break Outcome::Cancelled;
        }
        if paused {
            stage_base = stage_base.max(run_stage);
            continue;
        }
        break Outcome::Failed(r);
    };
    let job = jobs().remove(&key);
    active_remove(&akey);
    match outcome {
        Outcome::Cancelled => {
            if let Some(stem) = job.and_then(|j| j.stem) {
                let n = cleanup_partials(&cfg.download_dir, &stem);
                log(&format!("cancel cleanup stem={} removed={}", stem, n));
            }
            Ok(msg_with_id(req, vec![("type", "cancelled".into())]))
        }
        Outcome::Done => {
            let file_v = last_file.clone().map(Value::from).unwrap_or(Value::Null);
            let title = if truthy(get(req, "title")) {
                get(req, "title").clone()
            } else {
                Value::from(
                    last_file
                        .as_deref()
                        .and_then(|f| Path::new(f).file_stem())
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                )
            };
            let url = if truthy(get(cand, "url")) {
                get(cand, "url").clone()
            } else if truthy(get(req, "url")) {
                get(req, "url").clone()
            } else {
                Value::Null
            };
            let mut e = Map::new();
            e.insert("id".into(), get(req, "id").clone());
            e.insert("title".into(), title);
            e.insert("file".into(), file_v.clone());
            e.insert("url".into(), url);
            e.insert("label".into(), if truthy(get(req, "label")) { get(req, "label").clone() } else { Value::Null });
            e.insert("audio".into(), audio.into());
            e.insert("finishedAt".into(), now_ms().into());
            add_history(Value::Object(e));
            Ok(msg_with_id(req, vec![("type", "done".into()), ("file", file_v)]))
        }
        Outcome::Failed(r) => {
            log(&format!("download failed {} {} {}", r.code, tail_chars(&r.err, 1500), tail_chars(&r.out, 500)));
            Ok(msg_with_id(req, vec![("type", "error".into()), ("message", clean_error(&r.err).into())]))
        }
    }
}

// ---------- dispatch ----------
fn handle(msg: &Value) {
    let ty = get(msg, "type").as_str().unwrap_or("");
    match ty {
        "ping" => {
            record_extension();
            let dd = CONFIG.lock().unwrap().download_dir.clone();
            let mut m = msg_with_id(msg, vec![("type", "pong".into())]);
            let mo = m.as_object_mut().unwrap();
            mo.insert("version".into(), 1.into());
            mo.insert("downloadDir".into(), dd.into());
            send(m);
        }
        "probe" => {
            update_ytdlp(false);
            let mut res = match probe(msg) {
                Ok(r) => r,
                Err(e) => return send(msg_with_id(msg, vec![("type", "error".into()), ("message", e.into())])),
            };
            if get(&res, "type").as_str() == Some("error") && update_ytdlp(true) {
                res = match probe(msg) {
                    Ok(r) => r,
                    Err(e) => return send(msg_with_id(msg, vec![("type", "error".into()), ("message", e.into())])),
                };
            }
            send(res);
        }
        "download" => {
            update_ytdlp(false);
            match download(msg) {
                Ok(r) => send(r),
                Err(e) => send(msg_with_id(msg, vec![("type", "error".into()), ("message", e.into())])),
            }
        }
        "cancel" => {
            job_cancel(&id_key(get(msg, "target")));
            send(msg_with_id(msg, vec![("type", "ok".into())]));
        }
        "pause" => {
            job_pause(&id_key(get(msg, "target")));
            send(msg_with_id(msg, vec![("type", "ok".into())]));
        }
        "resume" => {
            job_resume(&id_key(get(msg, "target")));
            send(msg_with_id(msg, vec![("type", "ok".into())]));
        }
        "reveal" => {
            let dd = CONFIG.lock().unwrap().download_dir.clone();
            let file = str_field(msg, "file").map(|f| win_path(&f));
            match file {
                Some(f) if Path::new(&f).exists() => explorer_raw(&format!("/select,\"{}\"", f)),
                Some(f) => {
                    let parent = Path::new(&f).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                    if !parent.is_empty() && Path::new(&parent).is_dir() {
                        explorer_raw(&format!("\"{}\"", parent));
                    } else {
                        explorer_raw(&format!("\"{}\"", win_path(&dd)));
                    }
                }
                None => explorer_raw(&format!("\"{}\"", win_path(&dd))),
            }
            send(msg_with_id(msg, vec![("type", "ok".into())]));
        }
        _ => send(msg_with_id(
            msg,
            vec![("type", "error".into()), ("message", format!("Unknown request: {}", ty).into())],
        )),
    }
}

fn main() {
    // rotate log at startup (> 2 MB)
    if let Ok(md) = std::fs::metadata(&PATHS.log) {
        if md.len() > 2 * 1024 * 1024 {
            let _ = std::fs::rename(&PATHS.log, format!("{}.1", PATHS.log.display()));
        }
    }
    active_startup();
    control_poller();
    let cfg = CONFIG.lock().unwrap().clone();
    log(&format!(
        "host started {}",
        json!({"ytdlp": cfg.ytdlp, "ffmpegDir": cfg.ffmpeg_dir, "downloadDir": cfg.download_dir})
    ));

    let mut stdin = std::io::stdin().lock();
    loop {
        let mut hdr = [0u8; 4];
        if stdin.read_exact(&mut hdr).is_err() {
            break;
        }
        let len = u32::from_le_bytes(hdr) as usize;
        let mut body = vec![0u8; len];
        if stdin.read_exact(&mut body).is_err() {
            break;
        }
        let raw = String::from_utf8_lossy(&body).into_owned();
        let msg: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                log(&format!("bad json {}", raw));
                continue;
            }
        };
        // short requests (ping, probe, ...) must finish replying even if stdin closes right after
        let tracked = get(&msg, "type").as_str() != Some("download");
        if tracked {
            INFLIGHT.fetch_add(1, Ordering::SeqCst);
        }
        std::thread::spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(&msg)));
            if let Err(e) = r {
                let m = e
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| e.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "panic".into());
                log(&format!("handler error {}", m));
                send(msg_with_id(&msg, vec![("type", "error".into()), ("message", m.into())]));
            }
            if tracked {
                INFLIGHT.fetch_sub(1, Ordering::SeqCst);
            }
        });
    }
    // stdin closed: wait until no job is RUNNING (paused jobs are dropped, partial files stay)
    while any_running() || INFLIGHT.load(Ordering::SeqCst) > 0 {
        std::thread::sleep(Duration::from_millis(500));
    }
    std::process::exit(0);
}
