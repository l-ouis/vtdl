use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use clap::{Parser, Subcommand};
use shared::{crypto, RegisterRequest};
use vtdl_core::{cache, config::Config, keystore};

#[derive(Parser, Debug)]
#[command(name = "vtdl-cli", about = "Set up vtdl on this device")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Create a new account on the server and configure this device.
    Init {
        #[arg(long)]
        server: String,
        #[arg(long)]
        account: String,
    },
    /// Join an existing account from another device.
    Join {
        #[arg(long)]
        server: String,
        #[arg(long)]
        account: String,
        #[arg(long)]
        token: String,
    },
    /// Forget local config + cached key.
    Logout,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Init { server, account } => cmd_init(server, account),
        Cmd::Join { server, account, token } => cmd_join(server, account, token),
        Cmd::Logout => cmd_logout(),
    }
}

fn prompt_passphrase(confirm: bool) -> Result<String> {
    let p = rpassword::prompt_password("Passphrase: ")?;
    if p.is_empty() {
        bail!("passphrase cannot be empty");
    }
    if confirm {
        let p2 = rpassword::prompt_password("Confirm:    ")?;
        if p != p2 {
            bail!("passphrases did not match");
        }
    }
    Ok(p)
}

fn cmd_init(server: String, account: String) -> Result<()> {
    if Config::exists()? {
        bail!("config already exists; use `vtdl-cli logout` first");
    }
    let pass = prompt_passphrase(true)?;
    let api_token = crypto::random_token();
    let salt = crypto::random_salt();

    let req = RegisterRequest {
        account_id: account.clone(),
        api_token: api_token.clone(),
        kdf_salt: salt.to_vec(),
    };
    let client = reqwest::blocking::Client::new();
    let url = format!("{}/accounts", server.trim_end_matches('/'));
    let resp = client.post(&url).json(&req).send().context("POST /accounts")?;
    if !resp.status().is_success() {
        bail!(
            "server rejected registration: {} {}",
            resp.status(),
            resp.text().unwrap_or_default()
        );
    }

    let key = crypto::derive_key(&pass, &salt)?;
    keystore::put_key(&account, &key)?;

    let cfg = Config {
        server_url: server,
        account_id: account,
        api_token,
        kdf_salt_b64: B64.encode(salt),
    };
    cfg.save()?;
    println!("Account created. API token (copy for other devices):\n  {}", cfg.api_token);
    Ok(())
}

fn cmd_join(server: String, account: String, token: String) -> Result<()> {
    if Config::exists()? {
        bail!("config already exists; use `vtdl-cli logout` first");
    }
    let pass = prompt_passphrase(false)?;
    let client = reqwest::blocking::Client::new();
    let url = format!("{}/accounts/{}/sync", server.trim_end_matches('/'), account);
    let resp = client.get(&url).bearer_auth(&token).send().context("GET /sync")?;
    if !resp.status().is_success() {
        bail!(
            "server rejected join: {} {}",
            resp.status(),
            resp.text().unwrap_or_default()
        );
    }
    let snap: shared::SyncSnapshot = resp.json().context("decode snapshot")?;
    let salt: [u8; shared::KDF_SALT_LEN] = snap
        .kdf_salt
        .clone()
        .try_into()
        .map_err(|_| anyhow!("server returned salt of wrong length"))?;
    let key = crypto::derive_key(&pass, &salt)?;

    if let Some(ct) = &snap.ciphertext {
        crypto::decrypt(&key, ct).context("passphrase does not match this account")?;
    }
    keystore::put_key(&account, &key)?;

    let cfg = Config {
        server_url: server,
        account_id: account,
        api_token: token,
        kdf_salt_b64: B64.encode(salt),
    };
    cfg.save()?;
    println!("Joined.");
    Ok(())
}

fn cmd_logout() -> Result<()> {
    if let Ok(cfg) = Config::load() {
        let _ = keystore::delete_key(&cfg.account_id);
    }
    Config::delete()?;
    cache::delete()?;
    println!("Logged out.");
    Ok(())
}
