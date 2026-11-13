use serde::Serialize;
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const HOST_NAME: &str = "com.vidsnap.host";
const EXT_ORIGIN: &str = "chrome-extension://mfcampdflhbbpeajcmnhleahaglnipin/";
const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const FFMPEG_URL: &str =
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
const REG_PARENTS: [&str; 3] = [
    r"Software\Google\Chrome\NativeMessagingHosts",
    r"Software\Microsoft\Edge\NativeMessagingHosts",
    r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
];

static BUSY: AtomicBool = AtomicBool::new(false);

// ---------- paths ----------

fn env_dir(var: &str) -> PathBuf {
    PathBuf::from(std::env::var(var).unwrap_or_else(|_| ".".into()))
}
fn data_dir() -> PathBuf {
    env_dir("APPDATA").join("Vidsnap")
}
fn bin_dir() -> PathBuf {
    env_dir("LOCALAPPDATA").join("Vidsnap").join("bin")
}
fn ytdlp_path() -> PathBuf {
    bin_dir().join("yt-dlp.exe")
}
fn config_path() -> PathBuf {
    data_dir().join("config.json")
}
fn active_path() -> PathBuf {
    data_dir().join("active.json")
}
fn history_path() -> PathBuf {
    data_dir().join("history.json")
}
fn settings_path() -> PathBuf {
    data_dir().join("app-settings.json")
}
fn log_path() -> PathBuf {
    data_dir().join("host.log")
}
fn extension_status_path() -> PathBuf {
    data_dir().join("extension.json")
}
fn manifest_path() -> PathBuf {
    data_dir().join("com.vidsnap.host.json")
}

fn clean(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
}

fn resource_path(app: &AppHandle, rel: &str) -> PathBuf {
    let base = app.path().resource_dir().unwrap_or_default();
    let p = clean(base.join(rel));
    if p.exists() {
        return p;
    }
    // dev fallbacks (running from target\debug)
    if let Ok(exe) = std::env::current_exe() {
        let dev = if rel == "extension" {
            exe.ancestors().nth(6).map(|r| r.join("extension"))
        } else if rel.ends_with(".ps1") {
            exe.ancestors().nth(3).map(|r| r.join("resources").join(rel))
        } else {
            exe.ancestors().nth(5).map(|r| r.join("host").join("target").join("release").join(rel))
        };
        if let Some(d) = dev {
            if d.exists() {
                return d;
            }
        }
    }
    p
}

fn host_exe(app: &AppHandle) -> PathBuf {
    resource_path(app, "vidsnap-host.exe")
}
fn extension_dir(app: &AppHandle) -> PathBuf {
    resource_path(app, "extension")
}

fn install_script(app: &AppHandle) -> PathBuf {
    resource_path(app, "install-extension.ps1")
}

fn no_window(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

// ---------- config ----------

fn read_json(p: &Path) -> Option<Value> {
    let t = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()
}

fn write_config(app: &AppHandle, download_dir: Option<String>) -> Result<Value, String> {
    let mut cfg = read_json(&config_path()).unwrap_or_else(|| json!({}));
    if !cfg.is_object() {
        cfg = json!({});
    }
    let obj = cfg.as_object_mut().unwrap();
    obj.insert("ytdlp".into(), json!(ytdlp_path().to_string_lossy()));
    obj.insert("ffmpegDir".into(), json!(bin_dir().to_string_lossy()));
    if let Some(d) = download_dir {
        obj.insert("downloadDir".into(), json!(d));
    } else if obj.get("downloadDir").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        let d = app
            .path()
            .download_dir()
            .unwrap_or_else(|_| env_dir("USERPROFILE").join("Downloads"));
        obj.insert("downloadDir".into(), json!(d.to_string_lossy()));
    }
    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), serde_json::to_vec_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;
    Ok(cfg)
}

fn download_dir() -> Option<String> {
    read_json(&config_path())?.get("downloadDir")?.as_str().map(String::from)
}

// ---------- registration ----------

fn register(app: &AppHandle) -> Result<(), String> {
    let host = host_exe(app);
    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    let manifest = json!({
        "name": HOST_NAME,
        "description": "Vidsnap",
        "path": host.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [EXT_ORIGIN]
    });
    std::fs::write(manifest_path(), serde_json::to_vec_pretty(&manifest).unwrap())
        .map_err(|e| e.to_string())?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let mp = manifest_path().to_string_lossy().to_string();
    for parent in REG_PARENTS {
        let (k, _) = hkcu
            .create_subkey(format!(r"{}\{}", parent, HOST_NAME))
            .map_err(|e| e.to_string())?;
        k.set_value("", &mp).map_err(|e| e.to_string())?;
        let _ = hkcu.delete_subkey_all(format!(r"{}\com.ytdown.host", parent));
    }
    Ok(())
}

fn registration_ok() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let mp = manifest_path().to_string_lossy().to_string();
    if !manifest_path().exists() {
        return false;
    }
    REG_PARENTS.iter().all(|parent| {
        hkcu.open_subkey(format!(r"{}\{}", parent, HOST_NAME))
            .and_then(|k| k.get_value::<String, _>(""))
            .map(|v| v.eq_ignore_ascii_case(&mp))
            .unwrap_or(false)
    })
}

// ---------- downloads ----------

#[derive(Serialize, Clone)]
struct Progress {
    stage: String,
    pct: Option<f64>,
    text: String,
}

fn emit_progress(app: &AppHandle, stage: &str, pct: Option<f64>, text: &str) {
    let _ = app.emit("setup-progress", Progress { stage: stage.into(), pct, text: text.into() });
}

async fn download_file(app: &AppHandle, url: &str, dest: &Path, stage: &str, label: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("Vidsnap")
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(url).send().await.map_err(|e| format!("{label}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{label}: HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let part = dest.with_extension("part");
    let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut got: u64 = 0;
    let mut last = std::time::Instant::now() - Duration::from_secs(1);
    use std::io::Write;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{label}: {e}"))? {
        f.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(150) {
            last = std::time::Instant::now();
            let mb = got as f64 / 1_048_576.0;
            let (pct, text) = match total {
                Some(t) if t > 0 => (
                    Some(got as f64 * 100.0 / t as f64),
                    format!("{label} indiriliyor… {:.1} / {:.1} MB", mb, t as f64 / 1_048_576.0),
                ),
                _ => (None, format!("{label} indiriliyor… {:.1} MB", mb)),
            };
            emit_progress(app, stage, pct, &text);
        }
    }
    drop(f);
    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(())
}

fn extract_ffmpeg(zip_path: &Path, out: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    let mut found = 0;
    for i in 0..z.len() {
        let mut e = z.by_index(i).map_err(|e| e.to_string())?;
        let name = e.name().map_err(|e| e.to_string())?.replace('\\', "/");
        let target = if name.ends_with("/bin/ffmpeg.exe") {
            "ffmpeg.exe"
        } else if name.ends_with("/bin/ffprobe.exe") {
            "ffprobe.exe"
        } else {
            continue;
        };
        let dest = out.join(target);
        let tmp = out.join(format!("{target}.part"));
        {
            let mut o = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            std::io::copy(&mut e, &mut o).map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_file(&dest);
        std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
        found += 1;
    }
    if found < 2 {
        return Err("ffmpeg arşivinde ffmpeg.exe / ffprobe.exe bulunamadı".into());
    }
    Ok(())
}

fn ffmpeg_ok() -> bool {
    bin_dir().join("ffmpeg.exe").exists()
}

async fn do_setup(app: &AppHandle, force: bool) -> Result<(), String> {
    std::fs::create_dir_all(bin_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    if force || !ytdlp_path().exists() {
        download_file(app, YTDLP_URL, &ytdlp_path(), "ytdlp", "yt-dlp").await?;
    }
    if force || !ffmpeg_ok() || !bin_dir().join("ffprobe.exe").exists() {
        let zip = bin_dir().join("ffmpeg.zip");
        download_file(app, FFMPEG_URL, &zip, "ffmpeg", "ffmpeg").await?;
        emit_progress(app, "ffmpeg", None, "ffmpeg ayıklanıyor…");
        let (z2, b2) = (zip.clone(), bin_dir());
        let r = tauri::async_runtime::spawn_blocking(move || extract_ffmpeg(&z2, &b2))
            .await
            .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&zip);
        r?;
    }
    emit_progress(app, "register", None, "Yapılandırma yazılıyor…");
    write_config(app, None)?;
    if std::env::var("VIDSNAP_NO_REGISTER").ok().as_deref() != Some("1") {
        register(app)?;
    }
    emit_progress(app, "done", Some(100.0), "Hazır");
    Ok(())
}

// ---------- commands ----------

fn run_ytdlp(args: &[&str]) -> Result<String, String> {
    let mut c = Command::new(ytdlp_path());
    c.args(args).current_dir(bin_dir());
    let out = no_window(&mut c).output().map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(s.trim().to_string())
    } else {
        Err(s.trim().to_string())
    }
}

#[tauri::command]
async fn get_state(app: AppHandle) -> Value {
    let a2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app = a2;
        let ytdlp = ytdlp_path().exists();
        let version = if ytdlp { run_ytdlp(&["--version"]).ok() } else { None };
        let host = host_exe(&app);
        json!({
            "needsSetup": !ytdlp || !ffmpeg_ok(),
            "ytdlpVersion": version,
            "ytdlpPresent": ytdlp,
            "ffmpegPresent": ffmpeg_ok(),
            "registered": registration_ok(),
            "hostPath": host.to_string_lossy(),
            "hostExists": host.exists(),
            "extensionPath": extension_dir(&app).to_string_lossy(),
            "downloadDir": download_dir(),
            "busy": BUSY.load(Ordering::SeqCst),
        })
    })
    .await
    .unwrap_or(json!({}))
}

#[tauri::command]
fn get_history() -> Value {
    match read_json(&history_path()) {
        Some(v) if v.is_array() => v,
        _ => json!([]),
    }
}

fn read_active() -> Vec<Value> {
    let cutoff = now_ms().saturating_sub(150_000);
    match read_json(&active_path()) {
        Some(Value::Array(a)) => a
            .into_iter()
            .filter(|e| e.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0) >= cutoff)
            .collect(),
        _ => vec![],
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn control_dir() -> PathBuf {
    data_dir().join("control")
}

/// Control channel to the native host: writes control\<activeId>.cmd (pause | resume | cancel).
#[tauri::command]
fn control_download(id: String, action: String) -> Result<(), String> {
    if !matches!(action.as_str(), "pause" | "resume" | "cancel") {
        return Err("Geçersiz komut".into());
    }
    if id.is_empty() || id.contains(['\\', '/', ':']) || id.contains("..") {
        return Err("Geçersiz indirme kimliği".into());
    }
    let dir = control_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{id}.tmp"));
    std::fs::write(&tmp, &action).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(format!("{id}.cmd"))).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_active() -> Value {
    Value::Array(read_active())
}

#[tauri::command]
fn clear_history() -> Result<(), String> {
    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    std::fs::write(history_path(), "[]").map_err(|e| e.to_string())
}

fn win_path(p: &str) -> String {
    p.replace('/', "\\")
}

// explorer needs /select,"path" (quotes INSIDE the argument) -> raw_arg
fn explorer_raw(raw: &str) {
    let mut c = Command::new("explorer.exe");
    c.raw_arg(raw);
    let _ = no_window(&mut c).spawn();
}

fn explorer_open(path: &str) {
    explorer_raw(&format!("\"{}\"", win_path(path).trim_end_matches('\\')));
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let path = win_path(&path);
    if !Path::new(&path).exists() {
        return Err("Dosya bulunamadı".into());
    }
    explorer_open(&path);
    Ok(())
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let path = win_path(&path);
    if Path::new(&path).exists() {
        explorer_raw(&format!("/select,\"{}\"", path));
        return Ok(());
    }
    // file gone: open its folder, or the download dir
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() && parent.is_dir() {
            explorer_open(&parent.to_string_lossy());
            return Ok(());
        }
    }
    match download_dir() {
        Some(d) if Path::new(&win_path(&d)).is_dir() => {
            explorer_open(&d);
            Ok(())
        }
        _ => Err("Dosya bulunamadı".into()),
    }
}

fn open_dir_impl(p: PathBuf) -> Result<(), String> {
    let _ = std::fs::create_dir_all(&p);
    explorer_open(&p.to_string_lossy());
    Ok(())
}

#[tauri::command]
fn open_download_dir() -> Result<(), String> {
    match download_dir() {
        Some(d) => open_dir_impl(PathBuf::from(d)),
        None => Err("İndirme klasörü ayarlanmamış".into()),
    }
}

#[tauri::command]
fn open_extension_dir(app: AppHandle) -> Result<(), String> {
    explorer_open(&extension_dir(&app).to_string_lossy());
    Ok(())
}

// ---------- extension setup wizard ----------

// (id, display name, exe, extensions url, relative fallback paths under a base dir)
const BROWSERS: [(&str, &str, &str, &str, &str); 3] = [
    ("chrome", "Chrome", "chrome.exe", "chrome://extensions", r"Google\Chrome\Application\chrome.exe"),
    ("edge", "Edge", "msedge.exe", "edge://extensions", r"Microsoft\Edge\Application\msedge.exe"),
    ("brave", "Brave", "brave.exe", "brave://extensions", r"BraveSoftware\Brave-Browser\Application\brave.exe"),
];

fn find_browser_exe(exe: &str, rel: &str) -> Option<PathBuf> {
    let sub = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
    for root in [RegKey::predef(HKEY_CURRENT_USER), RegKey::predef(HKEY_LOCAL_MACHINE)] {
        if let Ok(k) = root.open_subkey(&sub) {
            if let Ok(v) = k.get_value::<String, _>("") {
                let p = PathBuf::from(v.trim().trim_matches('"'));
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let p = PathBuf::from(base).join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// ProgId of the default https handler -> browser id.
fn default_browser_id() -> Option<&'static str> {
    let k = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice")
        .ok()?;
    let prog: String = k.get_value("ProgId").ok()?;
    let p = prog.to_ascii_lowercase();
    if p.starts_with("chromehtml") {
        Some("chrome")
    } else if p.starts_with("bravehtml") {
        Some("brave")
    } else if p.starts_with("msedgehtm") {
        Some("edge")
    } else {
        None
    }
}

#[tauri::command]
fn detect_browsers() -> Value {
    let def = default_browser_id();
    Value::Array(
        BROWSERS
            .iter()
            .filter_map(|(id, name, exe, url, rel)| {
                find_browser_exe(exe, rel).map(|p| {
                    json!({ "id": id, "name": name, "exe": p.to_string_lossy(), "url": url, "isDefault": Some(*id) == def })
                })
            })
            .collect(),
    )
}

static EXT_BUSY: AtomicBool = AtomicBool::new(false);

/// One-click install: runs the bundled UI Automation script and forwards its JSON lines as "ext-step" events.
/// Returns the final {"done":..} object.
#[tauri::command]
async fn install_extension(app: AppHandle, id: String) -> Result<Value, String> {
    let (_, name, exe, url, rel) = BROWSERS.iter().find(|b| b.0 == id).ok_or("Bilinmeyen tarayıcı")?;
    let browser = find_browser_exe(exe, rel).ok_or_else(|| format!("{name} bulunamadı"))?;
    let script = install_script(&app);
    if !script.exists() {
        return Err("Kurulum betiği bulunamadı".into());
    }
    if EXT_BUSY.swap(true, Ordering::SeqCst) {
        return Err("Kurulum zaten sürüyor".into());
    }
    let ext = extension_dir(&app);
    let url = url.to_string();
    let a2 = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        use std::io::{BufRead, BufReader};
        use std::process::Stdio;
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let ps = Path::new(&sysroot).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let mut c = Command::new(ps);
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"])
            .arg(&script)
            .arg("-Browser")
            .arg(&browser)
            .arg("-Page")
            .arg(&url)
            .arg("-ExtDir")
            .arg(&ext)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        let mut child = no_window(&mut c).spawn().map_err(|e| format!("Betik başlatılamadı: {e}"))?;
        let mut last: Option<Value> = None;
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}').trim()) {
                    let _ = a2.emit("ext-step", &v);
                    if v.get("done").is_some() {
                        last = Some(v);
                    }
                }
            }
        }
        let _ = child.wait();
        Ok(last.unwrap_or_else(|| json!({"done": true, "ok": false, "failedStep": "unknown", "message": "Betik sonuç vermedi"})))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    EXT_BUSY.store(false, Ordering::SeqCst);
    show_window(&app, None);
    r
}

/// Manual fallback: opens the browser's extensions page, opens Explorer on the bundled extension folder.
/// Returns the folder path (the UI copies it to the clipboard).
#[tauri::command]
fn setup_browser(app: AppHandle, id: String) -> Result<String, String> {
    let (_, name, exe, url, rel) = BROWSERS.iter().find(|b| b.0 == id).ok_or("Bilinmeyen tarayıcı")?;
    let path = find_browser_exe(exe, rel).ok_or_else(|| format!("{name} bulunamadı"))?;
    Command::new(path).arg(url).spawn().map_err(|e| format!("{name} açılamadı: {e}"))?;
    let dir = extension_dir(&app);
    explorer_open(&dir.to_string_lossy());
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_extension_status() -> Value {
    read_json(&extension_status_path()).unwrap_or(Value::Null)
}

#[tauri::command]
fn open_log() -> Result<(), String> {
    let p = log_path();
    if !p.exists() {
        std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
        std::fs::write(&p, "").map_err(|e| e.to_string())?;
    }
    let mut c = Command::new("notepad.exe");
    c.arg(&p);
    no_window(&mut c).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_download_dir(app: AppHandle, dir: String) -> Result<(), String> {
    write_config(&app, Some(dir)).map(|_| ())
}

#[tauri::command]
async fn update_ytdlp() -> Result<String, String> {
    if !ytdlp_path().exists() {
        return Err("yt-dlp kurulu deÄŸil; â€œOnarâ€Ä± kullanÄ±n".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let out = run_ytdlp(&["-U"])?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn run_setup(app: AppHandle, force: bool) -> Result<(), String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("Başka bir işlem sürüyor".into());
    }
    let r = do_setup(&app, force).await;
    BUSY.store(false, Ordering::SeqCst);
    if let Err(e) = &r {
        emit_progress(&app, "error", None, e);
    }
    r
}


// ---------- app settings (separate from config.json, which the host reads) ----------

fn notify_enabled() -> bool {
    read_json(&settings_path())
        .and_then(|v| v.get("notify").and_then(|b| b.as_bool()))
        .unwrap_or(true)
}

#[tauri::command]
fn get_notify() -> bool {
    notify_enabled()
}

#[tauri::command]
fn set_notify(enabled: bool) -> Result<(), String> {
    let mut v = read_json(&settings_path()).unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    v.as_object_mut().unwrap().insert("notify".into(), json!(enabled));
    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(), serde_json::to_vec_pretty(&v).unwrap()).map_err(|e| e.to_string())
}

// ---------- auto update ----------

static UPDATING: AtomicBool = AtomicBool::new(false);

fn set_setting(key: &str, val: Value) -> Result<(), String> {
    let mut v = read_json(&settings_path()).unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    v.as_object_mut().unwrap().insert(key.into(), val);
    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(), serde_json::to_vec_pretty(&v).unwrap()).map_err(|e| e.to_string())
}

fn auto_update_enabled() -> bool {
    read_json(&settings_path())
        .and_then(|v| v.get("autoUpdate").and_then(|b| b.as_bool()))
        .unwrap_or(true)
}

#[tauri::command]
fn get_auto_update() -> bool {
    auto_update_enabled()
}

#[tauri::command]
fn set_auto_update(enabled: bool) -> Result<(), String> {
    set_setting("autoUpdate", json!(enabled))
}

#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

fn emit_update(app: &AppHandle, state: &str, text: &str) {
    let _ = app.emit("update-status", json!({ "state": state, "text": text }));
}

fn downloads_running() -> bool {
    read_active()
        .iter()
        .any(|e| e.get("status").and_then(|v| v.as_str()) != Some("paused"))
}

/// Checks for an update; if found downloads it, waits for running downloads to finish,
/// then installs (the passive NSIS installer restarts the app). Returns a status text.
async fn run_update(app: &AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;
    if UPDATING.swap(true, Ordering::SeqCst) {
        return Ok("Güncelleme zaten sürüyor".into());
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            UPDATING.store(false, Ordering::SeqCst);
        }
    }
    let _g = Guard;

    emit_update(app, "checking", "Denetleniyor…");
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => u,
        None => {
            emit_update(app, "uptodate", "Güncel");
            return Ok("Güncel".into());
        }
    };
    let ver = update.version.clone();
    emit_update(app, "downloading", &format!("İndiriliyor… ({ver})"));
    let mut got: u64 = 0;
    let mut last_pct: i64 = -1;
    let app2 = app.clone();
    let ver2 = ver.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                got += chunk as u64;
                if let Some(t) = total.filter(|t| *t > 0) {
                    let pct = (got * 100 / t) as i64;
                    if pct != last_pct {
                        last_pct = pct;
                        emit_update(&app2, "downloading", &format!("İndiriliyor… %{pct} ({ver2})"));
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // never interrupt a running download
    let mut waited = false;
    while downloads_running() {
        if !waited {
            waited = true;
            emit_update(app, "waiting", &format!("İndirmeler bitince kurulacak ({ver})"));
        }
        tokio_sleep(30).await;
    }

    let msg = format!("Vidsnap güncellendi ({ver}) — yeniden başlatılıyor");
    emit_update(app, "installing", &msg);
    show_toast(app, "Vidsnap", &msg, None);
    tokio_sleep(2).await;
    // On Windows install() launches the installer and exits the process.
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

async fn tokio_sleep(secs: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_secs(secs))).await;
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<String, String> {
    let r = run_update(&app).await;
    if let Err(e) = &r {
        emit_update(&app, "error", &format!("Hata: {e}"));
    }
    r
}

fn start_auto_update(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(10).await;
        loop {
            if auto_update_enabled() {
                if let Err(e) = run_update(&app).await {
                    emit_update(&app, "error", &format!("Hata: {e}"));
                }
            }
            tokio_sleep(6 * 60 * 60).await;
        }
    });
}

// ---------- toast notifications ----------

const MAX_INDIVIDUAL_TOASTS: usize = 3;

fn entry_id(e: &Value) -> String {
    match e.get("id") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => e.get("file").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    }
}

/// Pure: entries whose id is not in `seen` (oldest first), de-duplicated.
fn detect_new(seen: &HashSet<String>, entries: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut local: HashSet<String> = HashSet::new();
    for e in entries {
        let id = entry_id(e);
        if id.is_empty() || seen.contains(&id) || !local.insert(id) {
            continue;
        }
        out.push(e.clone());
    }
    out.reverse(); // history is newest first
    out
}

fn toast_body(e: &Value) -> String {
    let title = e.get("title").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        .or_else(|| e.get("file").and_then(|v| v.as_str()))
        .unwrap_or("(adsız)");
    let label = e.get("label").and_then(|v| v.as_str()).unwrap_or("");
    let kind = if e.get("audio").and_then(|v| v.as_bool()).unwrap_or(false) { "MP3" } else { "MP4" };
    let tail = if label.is_empty() { kind.to_string() } else { format!("{label} {kind}") };
    format!("{title} \u{b7} {tail}")
}

fn show_toast(app: &AppHandle, title: &str, body: &str, file: Option<String>) {
    use tauri_winrt_notification::Toast;
    let app = app.clone();
    let _ = Toast::new("com.vidsnap.app")
        .title(title)
        .text1(body)
        .on_activated(move |_| {
            match &file {
                Some(f) => {
                    let _ = reveal_path(f.clone());
                }
                None => show_window(&app, Some("downloads")),
            }
            Ok(())
        })
        .show();
}

fn notify_new(app: &AppHandle, new: &[Value]) {
    if new.is_empty() {
        return;
    }
    if new.len() > MAX_INDIVIDUAL_TOASTS {
        show_toast(app, "İndirildi", &format!("{} indirme tamamlandı", new.len()), None);
        return;
    }
    for e in new {
        let file = e.get("file").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);
        show_toast(app, "İndirildi", &toast_body(e), file);
    }
}

// ---------- window / tray ----------

fn show_window(app: &AppHandle, tab: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if let Some(t) = tab {
        let _ = app.emit("navigate", t);
    }
}

fn spawn_tray_update(app: &AppHandle) {
    show_window(app, Some("settings"));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("tray-update", "start");
        let r = update_ytdlp().await;
        let _ = app.emit("tray-update", match r { Ok(s) => s, Err(e) => format!("Hata: {e}") });
    });
}

fn history_entries() -> Vec<Value> {
    match read_json(&history_path()) {
        Some(Value::Array(a)) => a,
        _ => vec![],
    }
}

fn watch_history(app: AppHandle) {
    std::thread::spawn(move || {
        let mtime = || std::fs::metadata(history_path()).and_then(|m| m.modified()).ok();
        let mut last = mtime();
        let mut seen: HashSet<String> = history_entries().iter().map(entry_id).collect();
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let now = mtime();
            if now != last {
                last = now;
                let _ = app.emit("history-changed", ());
                let entries = history_entries();
                let new = detect_new(&seen, &entries);
                for e in &new {
                    seen.insert(entry_id(e));
                }
                if notify_enabled() {
                    notify_new(&app, &new);
                }
            }
        }
    });
}

fn watch_active(app: AppHandle) {
    std::thread::spawn(move || {
        let mtime = || std::fs::metadata(active_path()).and_then(|m| m.modified()).ok();
        let mut last = mtime();
        let mut last_tip = String::new();
        let mut tick: u32 = 0;
        loop {
            let visible = app
                .get_webview_window("main")
                .map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
                .unwrap_or(false);
            std::thread::sleep(Duration::from_millis(if visible { 700 } else { 1500 }));
            tick = tick.wrapping_add(1);
            let now = mtime();
            if now != last {
                last = now;
                let _ = app.emit("active-changed", ());
            }
            // tooltip (also refreshes so stale entries age out)
            if tick % 2 == 0 || now.is_some() {
                let list = read_active();
                let paused = list.iter().filter(|e| e.get("status").and_then(|v| v.as_str()) == Some("paused")).count();
                let running = list.len() - paused;
                let tip = if list.is_empty() {
                    "Vidsnap".to_string()
                } else if paused == 0 {
                    let pct = list
                        .iter()
                        .filter_map(|e| e.get("percent").and_then(|v| v.as_f64()))
                        .fold(0.0_f64, |a, b| a.max(b));
                    if running == 1 {
                        format!("Vidsnap — 1 indirme sürüyor (%{})", pct.floor() as i64)
                    } else {
                        format!("Vidsnap — {} indirme sürüyor", running)
                    }
                } else if running == 0 {
                    format!("Vidsnap — {} indirme duraklatıldı", paused)
                } else {
                    format!("Vidsnap — {} indirme sürüyor, {} duraklatıldı", running, paused)
                };
                if tip != last_tip {
                    last_tip = tip.clone();
                    if let Some(t) = app.tray_by_id("main") {
                        let _ = t.set_tooltip(Some(tip));
                    }
                }
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app, None);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_history,
            get_active,
            control_download,
            clear_history,
            open_path,
            reveal_path,
            open_download_dir,
            open_extension_dir,
            detect_browsers,
            setup_browser,
            install_extension,
            get_extension_status,
            open_log,
            set_download_dir,
            update_ytdlp,
            run_setup,
            get_notify,
            set_notify,
            get_auto_update,
            set_auto_update,
            get_app_version,
            check_update
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // idempotent registration + config on every start
            if std::env::var("VIDSNAP_NO_REGISTER").ok().as_deref() != Some("1") {
                let _ = register(&handle);
            }
            if ytdlp_path().exists() {
                let _ = write_config(&handle, None);
            }

            let menu = MenuBuilder::new(app)
                .items(&[
                    &MenuItemBuilder::with_id("history", "Geçmişi göster").build(app)?,
                    &MenuItemBuilder::with_id("folder", "İndirme klasörünü aç").build(app)?,
                    &MenuItemBuilder::with_id("update", "yt-dlp'yi güncelle").build(app)?,
                    &MenuItemBuilder::with_id("settings", "Ayarlar").build(app)?,
                    &MenuItemBuilder::with_id("log", "Günlüğü aç").build(app)?,
                ])
                .separator()
                .item(&MenuItemBuilder::with_id("quit", "Çıkış").build(app)?)
                .build()?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Vidsnap")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "history" => show_window(app, Some("downloads")),
                    "settings" => show_window(app, Some("settings")),
                    "folder" => {
                        let _ = open_download_dir();
                    }
                    "update" => spawn_tray_update(app),
                    "log" => {
                        let _ = open_log();
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        show_window(tray.app_handle(), None);
                    }
                })
                .build(app)?;

            watch_history(handle.clone());
            watch_active(handle.clone());
            start_auto_update(handle.clone());

            let hidden = std::env::args().any(|a| a == "--hidden");
            if !hidden {
                show_window(&handle, None);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Vidsnap başlatılamadı");
}




#[cfg(test)]
mod tests {
    use super::*;

    fn e(id: &str) -> Value {
        json!({"id": id, "title": "T", "file": "C:/x.mp4", "label": "1080p", "audio": false})
    }

    #[test]
    fn detects_only_unseen_oldest_first() {
        let seen: HashSet<String> = ["a".to_string()].into_iter().collect();
        let new = detect_new(&seen, &[e("c"), e("b"), e("a")]);
        let ids: Vec<String> = new.iter().map(entry_id).collect();
        assert_eq!(ids, vec!["b", "c"]);
    }

    #[test]
    fn none_when_all_seen_and_dedups() {
        let seen: HashSet<String> = ["a".to_string()].into_iter().collect();
        assert!(detect_new(&seen, &[e("a")]).is_empty());
        assert_eq!(detect_new(&HashSet::new(), &[e("z"), e("z")]).len(), 1);
    }

    #[test]
    fn body_format() {
        assert_eq!(toast_body(&e("a")), "T \u{b7} 1080p MP4");
        let mut m = e("a");
        m["audio"] = json!(true);
        assert_eq!(toast_body(&m), "T \u{b7} 1080p MP3");
    }
}
