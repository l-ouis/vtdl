use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::{Duration as CDuration, Local};
use serde::{Deserialize, Serialize};
use shared::{carry_forward, crypto, DailyEntry, Notebook, RegisterRequest, SyncSnapshot};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tokio::sync::{mpsc, oneshot, Mutex};
use rune_core::{
    cache, config::Config, keystore, snapshot, snapshot::Snapshot, snapshot::SnapshotMeta,
    sync::PushOutcome, Client,
};

#[derive(Clone, Serialize)]
struct NotebookView {
    version: i64,
    today_date: String,
    today: String,
    history: Vec<DailyEntry>,
}

impl NotebookView {
    fn from(version: i64, nb: &Notebook) -> Self {
        Self {
            version,
            today_date: nb.today_date.clone(),
            today: nb.today.clone(),
            history: nb.history.clone(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[allow(dead_code)]
enum SyncStatus {
    Idle,
    Busy,
    Synced { version: i64 },
    Error { message: String },
    NotConfigured,
}

#[derive(Clone, Serialize)]
struct SetupStatus {
    configured: bool,
    server_url: Option<String>,
    account_id: Option<String>,
    api_token: Option<String>,
}

#[derive(Deserialize)]
struct CreateArgs {
    server_url: String,
    account_id: String,
    passphrase: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct ServerInfo {
    service: String,
    version: String,
    #[serde(default)]
    history_days: u32,
    #[serde(default = "default_allow_registration")]
    allow_registration: bool,
}
fn default_allow_registration() -> bool {
    true
}

#[derive(Deserialize)]
struct JoinArgs {
    server_url: String,
    account_id: String,
    api_token: String,
    passphrase: String,
}

struct AppState {
    inner: Arc<Mutex<Inner>>,
    tx: mpsc::UnboundedSender<Msg>,
}

struct Inner {
    notebook: Notebook,
    version: i64,
    last_pushed: Option<Notebook>,
    cfg: Option<Config>,
    client: Option<Client>,
    /// Server-announced history retention. 0 = unlimited.
    history_days: u32,
}

enum Msg {
    Save,
    Pull,
}

fn today_iso() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn rollover(nb: &mut Notebook) -> bool {
    let today = today_iso();
    if nb.today_date == today {
        return false;
    }
    if nb.today_date.is_empty() {
        nb.today_date = today;
        return true;
    }
    let archived = std::mem::take(&mut nb.today);
    let carry = carry_forward(&archived);
    nb.history.insert(
        0,
        DailyEntry {
            date: std::mem::take(&mut nb.today_date),
            text: archived,
        },
    );
    nb.today_date = today;
    nb.today = if carry.is_empty() {
        String::new()
    } else {
        let mut s = carry;
        if !s.ends_with('\n') {
            s.push('\n');
        }
        s
    };
    true
}

/// Run a blocking closure on a fresh OS thread (no tokio runtime context).
/// We need this for keyring calls — keyring's zbus backend refuses to run
/// inside a tokio runtime, and tokio's spawn_blocking threads inherit the
/// runtime handle.
async fn off_runtime<F, R>(f: F) -> Result<R>
where
    F: FnOnce() -> Result<R> + Send + 'static,
    R: Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.await
        .map_err(|_| anyhow!("background thread cancelled"))?
}

#[tauri::command]
async fn register_global_shortcut(
    app: AppHandle,
    shortcut: String,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    match gs.register(shortcut.as_str()) {
        Ok(_) => {
            eprintln!("[rune] registered global shortcut: {shortcut}");
            Ok(())
        }
        Err(e) => {
            eprintln!("[rune] failed to register {shortcut}: {e}");
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn unregister_global_shortcut(app: AppHandle) -> Result<(), String> {
    eprintln!("[rune] unregistering all global shortcuts");
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())
}

fn toggle_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        eprintln!("[rune] toggle: no 'main' window found");
        return;
    };
    let visible = win.is_visible().unwrap_or(true);
    eprintln!("[rune] toggle: visible={visible}");
    // Simple semantics: visible → hide, hidden → show.
    //
    // On Wayland, programmatic focus-stealing of an already-visible window is
    // blocked. So if the window is visible-but-behind another window, "show"
    // would silently no-op. Instead we hide it first; the user presses the
    // shortcut again to get a fresh `map` event, which the compositor treats
    // as a brand-new window appearance and gives focus to.
    if visible {
        if let Err(e) = win.hide() {
            eprintln!("[rune] hide failed: {e}");
        }
    } else {
        let _ = win.unminimize();
        if let Err(e) = win.show() {
            eprintln!("[rune] show failed: {e}");
        }
        let _ = win.set_focus();
    }
}

async fn fetch_server_info(url: &str) -> Result<ServerInfo, String> {
    let normalized = url.trim_end_matches('/').to_string();
    if normalized.is_empty() {
        return Err("server url is empty".into());
    }
    let probe = format!("{normalized}/healthz");
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = http
        .get(&probe)
        .send()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("server returned {}", resp.status()));
    }
    let info: ServerInfo = resp
        .json()
        .await
        .map_err(|_| "not a rune server (unexpected response shape)".to_string())?;
    if info.service != "rune" {
        return Err(format!("not a rune server (service={})", info.service));
    }
    Ok(info)
}

#[tauri::command]
async fn ping_server(url: String) -> Result<ServerInfo, String> {
    fetch_server_info(&url).await
}

/// Refresh the server-announced history retention into Inner. Best-effort —
/// network errors leave the previous value untouched.
async fn refresh_history_days(state: &State<'_, AppState>) {
    let server_url = {
        let guard = state.inner.lock().await;
        guard.cfg.as_ref().map(|c| c.server_url.clone())
    };
    let Some(url) = server_url else { return };
    if let Ok(info) = fetch_server_info(&url).await {
        let mut guard = state.inner.lock().await;
        guard.history_days = info.history_days;
    }
}

/// Drop history entries older than `days` days. `days == 0` means no limit.
/// Server can't decrypt to enforce, so this is a client-honored bound.
fn trim_notebook_for_push(nb: &Notebook, days: u32) -> Notebook {
    if days == 0 {
        return nb.clone();
    }
    let cutoff = (Local::now().date_naive() - CDuration::days(days as i64))
        .format("%Y-%m-%d")
        .to_string();
    let mut trimmed = nb.clone();
    trimmed.history.retain(|e| e.date >= cutoff);
    trimmed
}

// ---------- snapshots & backup ----------

/// Portable on-disk export format (distinct from internal snapshot files).
#[derive(Serialize, Deserialize)]
struct ExportFile {
    rune_export: u32,
    exported_at: String,
    version: i64,
    notebook: Notebook,
}

fn notebook_is_empty(nb: &Notebook) -> bool {
    nb.today.trim().is_empty() && nb.history.is_empty()
}

fn build_snapshot(label: String, auto: bool, version: i64, nb: &Notebook) -> Snapshot {
    let now = Local::now();
    Snapshot {
        meta: SnapshotMeta {
            id: now.format("%Y%m%d-%H%M%S-%3f").to_string(),
            label,
            created_at: now.to_rfc3339(),
            today_date: nb.today_date.clone(),
            auto,
        },
        version,
        notebook: nb.clone(),
    }
}

/// Take a best-effort safety snapshot before a destructive action. No-op when
/// the notebook is empty so we don't accumulate empty snapshots.
async fn auto_snapshot(inner: &Arc<Mutex<Inner>>, reason: &str) {
    let (version, nb) = {
        let g = inner.lock().await;
        (g.version, g.notebook.clone())
    };
    if notebook_is_empty(&nb) {
        return;
    }
    let _ = snapshot::save(&build_snapshot(reason.to_string(), true, version, &nb));
}

fn parse_imported(data: &[u8]) -> Result<Notebook> {
    if let Ok(ef) = serde_json::from_slice::<ExportFile>(data) {
        return Ok(ef.notebook);
    }
    Notebook::from_bytes(data).context("parse imported notebook")
}

/// Resolve a `FilePath` from the dialog plugin to a plain filesystem path.
fn dialog_path(fp: tauri_plugin_dialog::FilePath) -> Option<String> {
    fp.into_path().ok().map(|p| p.to_string_lossy().to_string())
}

async fn pick_save_path(app: &AppHandle, default_name: &str) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(default_name)
        .add_filter("JSON", &["json"])
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    rx.await.ok().flatten().and_then(dialog_path)
}

async fn pick_open_path(app: &AppHandle) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .pick_file(move |p| {
            let _ = tx.send(p);
        });
    rx.await.ok().flatten().and_then(dialog_path)
}

/// Replace the local notebook (snapshot restore / import). Rolls the incoming
/// notebook forward to today, persists, and notifies the UI. `force_push`
/// clears `last_pushed` so the new content propagates on the next sync.
async fn apply_local_notebook(
    app: &AppHandle,
    state: &State<'_, AppState>,
    mut nb: Notebook,
) -> NotebookView {
    let _ = rollover(&mut nb);
    let view = {
        let mut g = state.inner.lock().await;
        g.notebook = nb.clone();
        g.last_pushed = None; // force the restored content to push next sync
        let _ = cache::save(&cache::Cache {
            version: g.version,
            notebook: g.notebook.clone(),
        });
        NotebookView::from(g.version, &g.notebook)
    };
    let _ = state.tx.send(Msg::Save);
    let _ = app.emit("notebook-updated", view.clone());
    view
}

#[tauri::command]
async fn create_snapshot(
    label: Option<String>,
    state: State<'_, AppState>,
) -> Result<SnapshotMeta, String> {
    let (version, nb) = {
        let g = state.inner.lock().await;
        (g.version, g.notebook.clone())
    };
    let label = label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Snapshot {}", Local::now().format("%Y-%m-%d %H:%M")));
    let snap = build_snapshot(label, false, version, &nb);
    snapshot::save(&snap).map_err(|e| e.to_string())?;
    Ok(snap.meta)
}

#[tauri::command]
async fn list_snapshots() -> Result<Vec<SnapshotMeta>, String> {
    snapshot::list().map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_snapshot(id: String) -> Result<(), String> {
    snapshot::delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn restore_snapshot(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<NotebookView, String> {
    let snap = snapshot::load(&id).map_err(|e| e.to_string())?;
    auto_snapshot(&state.inner, "Before restore").await;
    Ok(apply_local_notebook(&app, &state, snap.notebook).await)
}

#[tauri::command]
async fn export_notebook(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let (version, nb) = {
        let g = state.inner.lock().await;
        (g.version, g.notebook.clone())
    };
    let default_name = format!("rune-backup-{}.json", Local::now().format("%Y-%m-%d"));
    let Some(path) = pick_save_path(&app, &default_name).await else {
        return Ok(None);
    };
    let export = ExportFile {
        rune_export: 1,
        exported_at: Local::now().to_rfc3339(),
        version,
        notebook: nb,
    };
    let data = serde_json::to_vec_pretty(&export).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(Some(path))
}

#[tauri::command]
async fn import_notebook(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<NotebookView>, String> {
    let Some(path) = pick_open_path(&app).await else {
        return Ok(None);
    };
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let nb = parse_imported(&data).map_err(|e| e.to_string())?;
    auto_snapshot(&state.inner, "Before import").await;
    Ok(Some(apply_local_notebook(&app, &state, nb).await))
}

/// Force-overwrite the local notebook with the current server state.
#[tauri::command]
async fn pull_replace(app: AppHandle, state: State<'_, AppState>) -> Result<NotebookView, String> {
    let client = {
        let g = state.inner.lock().await;
        match &g.client {
            Some(c) => unsafe_clone_client(c, &g.cfg).map_err(|e| e.to_string())?,
            None => return Err("not connected to a sync server".into()),
        }
    };
    let (version, nb) = client.pull().await.map_err(|e| e.to_string())?;
    auto_snapshot(&state.inner, "Before load from server").await;
    let mut nb = nb;
    let _ = rollover(&mut nb);
    let view = {
        let mut g = state.inner.lock().await;
        g.version = version;
        g.notebook = nb.clone();
        g.last_pushed = Some(nb.clone());
        let _ = cache::save(&cache::Cache {
            version,
            notebook: nb.clone(),
        });
        NotebookView::from(version, &nb)
    };
    let _ = app.emit("notebook-updated", view.clone());
    let _ = app.emit("sync-status", SyncStatus::Synced { version });
    Ok(view)
}

/// Force-overwrite the server with the current local notebook.
#[tauri::command]
async fn push_overwrite(state: State<'_, AppState>) -> Result<i64, String> {
    let (client, nb, days) = {
        let g = state.inner.lock().await;
        match &g.client {
            Some(c) => (
                unsafe_clone_client(c, &g.cfg).map_err(|e| e.to_string())?,
                g.notebook.clone(),
                g.history_days,
            ),
            None => return Err("not connected to a sync server".into()),
        }
    };
    let to_push = trim_notebook_for_push(&nb, days);
    let mut last_err = String::new();
    for _ in 0..3 {
        let v = match client.server_version().await {
            Ok(v) => v,
            Err(e) => {
                last_err = e.to_string();
                break;
            }
        };
        match client.push(&to_push, v).await {
            Ok(PushOutcome::Ok { version }) => {
                let mut g = state.inner.lock().await;
                g.version = version;
                g.last_pushed = Some(to_push.clone());
                let _ = cache::save(&cache::Cache {
                    version,
                    notebook: nb.clone(),
                });
                return Ok(version);
            }
            // Someone else wrote in between — retry against the fresh version.
            Ok(PushOutcome::Conflict { .. }) => continue,
            Err(e) => {
                last_err = e.to_string();
                break;
            }
        }
    }
    Err(if last_err.is_empty() {
        "server state kept changing; try again".into()
    } else {
        last_err
    })
}

#[tauri::command]
async fn setup_status(state: State<'_, AppState>) -> Result<SetupStatus, String> {
    let guard = state.inner.lock().await;
    Ok(match &guard.cfg {
        Some(cfg) => SetupStatus {
            configured: true,
            server_url: Some(cfg.server_url.clone()),
            account_id: Some(cfg.account_id.clone()),
            api_token: Some(cfg.api_token.clone()),
        },
        None => SetupStatus {
            configured: false,
            server_url: None,
            account_id: None,
            api_token: None,
        },
    })
}

#[tauri::command]
async fn load_notebook(state: State<'_, AppState>) -> Result<NotebookView, String> {
    let mut guard = state.inner.lock().await;
    let changed = rollover(&mut guard.notebook);
    if changed {
        let _ = cache::save(&cache::Cache {
            version: guard.version,
            notebook: guard.notebook.clone(),
        });
        let _ = state.tx.send(Msg::Save);
    }
    Ok(NotebookView::from(guard.version, &guard.notebook))
}

#[tauri::command]
async fn save_today(text: String, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut guard = state.inner.lock().await;
        guard.notebook.today = text;
        let _ = cache::save(&cache::Cache {
            version: guard.version,
            notebook: guard.notebook.clone(),
        });
    }
    let _ = state.tx.send(Msg::Save);
    Ok(())
}

#[tauri::command]
async fn force_pull(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.tx.send(Msg::Pull);
    Ok(())
}

#[tauri::command]
async fn create_account(
    args: CreateArgs,
    state: State<'_, AppState>,
) -> Result<SetupStatus, String> {
    {
        let guard = state.inner.lock().await;
        if guard.cfg.is_some() {
            return Err("already configured; sign out first".into());
        }
    }
    let result = do_create(args, &state).await.map_err(|e| e.to_string())?;
    refresh_history_days(&state).await;
    Ok(result)
}

#[tauri::command]
async fn join_account(
    args: JoinArgs,
    state: State<'_, AppState>,
) -> Result<SetupStatus, String> {
    {
        let guard = state.inner.lock().await;
        if guard.cfg.is_some() {
            return Err("already configured; sign out first".into());
        }
    }
    // Joining pulls the account's state and overwrites local notes — snapshot
    // first so anything currently on this device is recoverable.
    auto_snapshot(&state.inner, "Before linking account").await;
    let result = do_join(args, &state).await.map_err(|e| e.to_string())?;
    refresh_history_days(&state).await;
    Ok(result)
}

#[tauri::command]
async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    // Disconnect but KEEP local notes — the user drops into offline mode with
    // their notebook intact. A safety snapshot is taken inside do_logout.
    do_logout(&state, false).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_account(state: State<'_, AppState>) -> Result<(), String> {
    let client = {
        let guard = state.inner.lock().await;
        match &guard.client {
            Some(c) => Some(unsafe_clone_client(c, &guard.cfg).map_err(|e| e.to_string())?),
            None => None,
        }
    };
    if let Some(c) = client {
        c.delete_account().await.map_err(|e| e.to_string())?;
    }
    // Account is gone from the server — wipe the local copy too.
    do_logout(&state, true).await.map_err(|e| e.to_string())
}

/// `Client` isn't Clone (it holds an http client + key). For commands that
/// release the state lock while making a network call, we rebuild it from the
/// current `Config` + the key in the keyring.
fn unsafe_clone_client(_existing: &Client, cfg: &Option<Config>) -> Result<Client> {
    let cfg = cfg.as_ref().ok_or_else(|| anyhow!("not configured"))?.clone();
    let key = keystore::get_key(&cfg.account_id).context("read key from keyring")?;
    Client::new(cfg, key)
}

async fn do_create(args: CreateArgs, state: &State<'_, AppState>) -> Result<SetupStatus> {
    let server = args.server_url.trim_end_matches('/').to_string();
    let account = args.account_id.clone();
    let passphrase = args.passphrase;
    let api_token = crypto::random_token();
    let salt = crypto::random_salt();
    let req = RegisterRequest {
        account_id: account.clone(),
        api_token: api_token.clone(),
        kdf_salt: salt.to_vec(),
    };
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("http client")?;
    let url = format!("{}/accounts", server);
    let resp = http.post(&url).json(&req).send().await.context("POST /accounts")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("server rejected registration: {status} {body}");
    }
    let salt_for_kdf = salt;
    let pass = passphrase.clone();
    let key = off_runtime(move || crypto::derive_key(&pass, &salt_for_kdf).map_err(|e| anyhow!(e.to_string()))).await?;
    let account_for_keyring = account.clone();
    let key_for_keyring = key.clone();
    off_runtime(move || keystore::put_key(&account_for_keyring, &key_for_keyring)).await?;
    let cfg = Config {
        server_url: server,
        account_id: account.clone(),
        api_token: api_token.clone(),
        kdf_salt_b64: B64.encode(salt),
    };
    cfg.save().context("save config")?;
    let new_client = Client::new(cfg.clone(), key).context("build client")?;
    {
        let mut guard = state.inner.lock().await;
        guard.cfg = Some(cfg);
        guard.client = Some(new_client);
        guard.last_pushed = None;
    }
    let _ = state.tx.send(Msg::Save);
    Ok(SetupStatus {
        configured: true,
        server_url: Some(args.server_url),
        account_id: Some(account),
        api_token: Some(api_token),
    })
}

async fn do_join(args: JoinArgs, state: &State<'_, AppState>) -> Result<SetupStatus> {
    let server = args.server_url.trim_end_matches('/').to_string();
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("http client")?;
    let url = format!("{}/accounts/{}/sync", server, args.account_id);
    let resp = http.get(&url).bearer_auth(&args.api_token).send().await.context("GET /sync")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("server rejected join: {status} {body}");
    }
    let snap: SyncSnapshot = resp.json().await.context("decode snapshot")?;
    let salt: [u8; shared::KDF_SALT_LEN] = snap
        .kdf_salt
        .clone()
        .try_into()
        .map_err(|_| anyhow!("server returned salt of wrong length"))?;
    let pass = args.passphrase.clone();
    let salt_for_kdf = salt;
    let key = off_runtime(move || crypto::derive_key(&pass, &salt_for_kdf).map_err(|e| anyhow!(e.to_string()))).await?;
    // Verify passphrase by decrypting an existing snapshot, if any.
    if let Some(ct) = &snap.ciphertext {
        crypto::decrypt(&key, ct).map_err(|_| anyhow!("passphrase does not match this account"))?;
    }
    let account_for_keyring = args.account_id.clone();
    let key_for_keyring = key.clone();
    off_runtime(move || keystore::put_key(&account_for_keyring, &key_for_keyring)).await?;
    let cfg = Config {
        server_url: server.clone(),
        account_id: args.account_id.clone(),
        api_token: args.api_token.clone(),
        kdf_salt_b64: B64.encode(salt),
    };
    cfg.save().context("save config")?;
    let new_client = Client::new(cfg.clone(), key).context("build client")?;
    {
        let mut guard = state.inner.lock().await;
        guard.cfg = Some(cfg);
        guard.client = Some(new_client);
        guard.last_pushed = None;
    }
    // Trigger an immediate pull so the joined device gets the existing state.
    let _ = state.tx.send(Msg::Pull);
    Ok(SetupStatus {
        configured: true,
        server_url: Some(server),
        account_id: Some(args.account_id),
        api_token: Some(args.api_token),
    })
}

/// Disconnect from the sync server. When `wipe_local` is false the local
/// notebook is preserved (the app drops into offline mode) — this is the
/// default for sign-out so notes are never lost. `wipe_local` is only true for
/// account deletion. A safety snapshot is taken first either way.
async fn do_logout(state: &State<'_, AppState>, wipe_local: bool) -> Result<()> {
    auto_snapshot(
        &state.inner,
        if wipe_local {
            "Before account deletion"
        } else {
            "Before sign out"
        },
    )
    .await;
    let account = {
        let mut guard = state.inner.lock().await;
        guard.client = None;
        let acc = guard.cfg.take().map(|c| c.account_id);
        guard.last_pushed = None;
        guard.version = 0;
        guard.history_days = 0;
        if wipe_local {
            guard.notebook = Notebook::default();
        }
        acc
    };
    if let Some(acc) = account {
        let _ = off_runtime(move || keystore::delete_key(&acc)).await;
    }
    let _ = Config::delete();
    if wipe_local {
        let _ = cache::delete();
    } else {
        // Persist the kept notebook, now disconnected (version reset to 0).
        let guard = state.inner.lock().await;
        let _ = cache::save(&cache::Cache {
            version: 0,
            notebook: guard.notebook.clone(),
        });
    }
    Ok(())
}

pub fn run() {
    // Linux only: log the GDK backend so it's easy to confirm whether the
    // window will be a Wayland surface (focus-raising blocked) or XWayland.
    #[cfg(target_os = "linux")]
    eprintln!(
        "[rune] startup: GDK_BACKEND={:?} XDG_SESSION_TYPE={:?}",
        std::env::var("GDK_BACKEND").ok(),
        std::env::var("XDG_SESSION_TYPE").ok(),
    );

    let initial = cache::load().unwrap_or_default();
    let cfg = Config::load().ok().filter(|_| Config::exists().unwrap_or(false));
    // Keystore call happens before tauri runtime starts → no nested-runtime issue.
    let client = match &cfg {
        Some(cfg) => match keystore::get_key(&cfg.account_id) {
            Ok(key) => Client::new(cfg.clone(), key).ok(),
            Err(_) => None,
        },
        None => None,
    };

    let (tx, rx) = mpsc::unbounded_channel::<Msg>();
    let inner = Arc::new(Mutex::new(Inner {
        notebook: initial.notebook,
        version: initial.version,
        last_pushed: None,
        cfg,
        client,
        history_days: 0,
    }));

    tauri::Builder::default()
        // Single-instance MUST be the first plugin. A second invocation of
        // the binary terminates immediately and hands its argv to the running
        // instance. `--toggle` is our hook for OS-level keyboard shortcuts
        // (esp. Wayland, where global key grabbing is unreliable).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            eprintln!("[rune] second instance argv: {argv:?}");
            if argv.iter().any(|a| a == "--toggle") {
                toggle_main_window(app);
            } else {
                // No special args: just surface the existing window.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    eprintln!(
                        "[rune] shortcut event: {:?} state={:?}",
                        shortcut, event.state()
                    );
                    if event.state() == ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .manage(AppState { inner: inner.clone(), tx: tx.clone() })
        .invoke_handler(tauri::generate_handler![
            setup_status,
            ping_server,
            load_notebook,
            save_today,
            force_pull,
            create_account,
            join_account,
            logout,
            delete_account,
            register_global_shortcut,
            unregister_global_shortcut,
            create_snapshot,
            list_snapshots,
            delete_snapshot,
            restore_snapshot,
            export_notebook,
            import_notebook,
            pull_replace,
            push_overwrite,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let inner_worker = inner.clone();
            let inner_rollover = inner.clone();
            let handle_rollover = handle.clone();
            let tx_worker = tx.clone();
            let tx_rollover = tx.clone();

            tauri::async_runtime::spawn(async move {
                // Worker loop always runs. It silently no-ops while there is
                // no client (i.e. not yet configured or after logout).
                let configured_at_launch = inner_worker.lock().await.client.is_some();
                if configured_at_launch {
                    // Best-effort refresh of server-announced history retention.
                    let url = inner_worker
                        .lock()
                        .await
                        .cfg
                        .as_ref()
                        .map(|c| c.server_url.clone());
                    if let Some(url) = url {
                        if let Ok(info) = fetch_server_info(&url).await {
                            inner_worker.lock().await.history_days = info.history_days;
                        }
                    }
                    let _ = tx_worker.send(Msg::Pull);
                }
                worker_loop(handle, inner_worker, rx).await;
            });

            tauri::async_runtime::spawn(rollover_loop(
                handle_rollover,
                inner_rollover,
                tx_rollover,
            ));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn worker_loop(
    handle: AppHandle,
    inner: Arc<Mutex<Inner>>,
    mut rx: mpsc::UnboundedReceiver<Msg>,
) {
    let debounce = Duration::from_millis(400);
    let periodic = Duration::from_secs(30);
    let mut last_pull = std::time::Instant::now() - periodic;

    loop {
        let mut pending_save = false;
        let mut pending_pull = false;

        let next_tick = periodic
            .saturating_sub(last_pull.elapsed())
            .max(Duration::from_millis(50));
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(Msg::Save) => pending_save = true,
                Some(Msg::Pull) => pending_pull = true,
                None => return,
            },
            _ = tokio::time::sleep(next_tick) => {
                pending_pull = true;
            }
        }

        if pending_save {
            let deadline = tokio::time::Instant::now() + debounce;
            while let Ok(Some(msg)) = tokio::time::timeout_at(deadline, rx.recv()).await {
                match msg {
                    Msg::Save => {}
                    Msg::Pull => pending_pull = true,
                }
            }
        }

        if pending_pull {
            do_pull(&handle, &inner).await;
            last_pull = std::time::Instant::now();
        }
        if pending_save {
            do_push(&handle, &inner).await;
        }
    }
}

async fn rollover_loop(
    handle: AppHandle,
    inner: Arc<Mutex<Inner>>,
    tx: mpsc::UnboundedSender<Msg>,
) {
    let mut ticker = tokio::time::interval(Duration::from_secs(5));
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let view = {
            let mut guard = inner.lock().await;
            if !rollover(&mut guard.notebook) {
                continue;
            }
            let _ = cache::save(&cache::Cache {
                version: guard.version,
                notebook: guard.notebook.clone(),
            });
            NotebookView::from(guard.version, &guard.notebook)
        };
        let _ = handle.emit("notebook-updated", view);
        let _ = tx.send(Msg::Save);
    }
}

async fn do_pull(handle: &AppHandle, inner: &Arc<Mutex<Inner>>) {
    // Quiet no-op if not configured. Avoids spamming "not configured" errors
    // during the setup screen.
    {
        let guard = inner.lock().await;
        if guard.client.is_none() {
            return;
        }
    }
    let _ = handle.emit("sync-status", SyncStatus::Busy);
    let result = {
        let guard = inner.lock().await;
        match guard.client.as_ref() {
            None => return,
            Some(c) => c.pull().await.map_err(|e| e.to_string()),
        }
    };
    match result {
        Ok((version, mut notebook)) => {
            let _ = rollover(&mut notebook);
            let mut guard = inner.lock().await;
            if version > guard.version {
                guard.version = version;
                guard.notebook = notebook.clone();
                guard.last_pushed = Some(notebook.clone());
                let _ = cache::save(&cache::Cache {
                    version,
                    notebook: notebook.clone(),
                });
                let _ = handle.emit(
                    "notebook-updated",
                    NotebookView::from(version, &notebook),
                );
            }
            let _ = handle.emit("sync-status", SyncStatus::Synced { version: guard.version });
        }
        Err(message) => {
            let _ = handle.emit("sync-status", SyncStatus::Error { message });
        }
    }
}

async fn do_push(handle: &AppHandle, inner: &Arc<Mutex<Inner>>) {
    {
        let guard = inner.lock().await;
        if guard.client.is_none() {
            return;
        }
    }
    let _ = handle.emit("sync-status", SyncStatus::Busy);
    let (notebook, expected_version, history_days) = {
        let guard = inner.lock().await;
        (
            guard.notebook.clone(),
            guard.version,
            guard.history_days,
        )
    };
    // Trim history to the server's announced retention before sending.
    // Local cache keeps the full notebook; only what crosses the wire is
    // truncated.
    let to_push = trim_notebook_for_push(&notebook, history_days);
    {
        let guard = inner.lock().await;
        if Some(&to_push) == guard.last_pushed.as_ref() {
            let _ = handle.emit("sync-status", SyncStatus::Synced { version: guard.version });
            return;
        }
    }

    let outcome = {
        let guard = inner.lock().await;
        match guard.client.as_ref() {
            None => return,
            Some(c) => c.push(&to_push, expected_version).await,
        }
    };

    match outcome {
        Ok(PushOutcome::Ok { version }) => {
            let mut guard = inner.lock().await;
            guard.version = version;
            guard.last_pushed = Some(to_push.clone());
            let _ = cache::save(&cache::Cache {
                version,
                notebook: notebook.clone(),
            });
            let _ = handle.emit("sync-status", SyncStatus::Synced { version });
        }
        Ok(PushOutcome::Conflict { version, notebook: server_nb }) => {
            let mut guard = inner.lock().await;
            guard.version = version;
            guard.notebook = server_nb.clone();
            guard.last_pushed = Some(server_nb.clone());
            let _ = cache::save(&cache::Cache {
                version,
                notebook: server_nb.clone(),
            });
            let _ = handle.emit(
                "notebook-updated",
                NotebookView::from(version, &server_nb),
            );
            let _ = handle.emit("sync-status", SyncStatus::Synced { version });
        }
        Err(e) => {
            let _ = handle.emit("sync-status", SyncStatus::Error { message: e.to_string() });
        }
    }
}
