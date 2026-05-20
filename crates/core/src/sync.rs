use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use reqwest::StatusCode;
use shared::{crypto::Key, Notebook, PutConflict, PutOk, PutRequest, SyncSnapshot};

use crate::Config;

pub struct Client {
    cfg: Config,
    key: Key,
    http: reqwest::Client,
}

pub enum PushOutcome {
    Ok { version: i64 },
    Conflict { version: i64, notebook: Notebook },
}

impl Client {
    pub fn new(cfg: Config, key: Key) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .context("build reqwest client")?;
        Ok(Self { cfg, key, http })
    }

    fn sync_url(&self) -> String {
        format!(
            "{}/accounts/{}/sync",
            self.cfg.server_url.trim_end_matches('/'),
            self.cfg.account_id,
        )
    }

    pub async fn pull(&self) -> Result<(i64, Notebook)> {
        let snap = self.get_snapshot().await?;
        let notebook = decrypt_notebook(&self.key, &snap.ciphertext)?;
        Ok((snap.version, notebook))
    }

    pub async fn push(&self, notebook: &Notebook, expected_version: i64) -> Result<PushOutcome> {
        let ct = shared::crypto::encrypt(&self.key, &notebook.to_bytes())
            .map_err(|e| anyhow!("encrypt: {e}"))?;
        let body = PutRequest { expected_version, ciphertext: ct };
        let resp = self
            .http
            .put(self.sync_url())
            .bearer_auth(&self.cfg.api_token)
            .json(&body)
            .send()
            .await
            .context("PUT /sync")?;
        match resp.status() {
            StatusCode::OK => {
                let ok: PutOk = resp.json().await.context("decode PutOk")?;
                Ok(PushOutcome::Ok { version: ok.version })
            }
            StatusCode::CONFLICT => {
                let c: PutConflict = resp.json().await.context("decode PutConflict")?;
                let notebook = decrypt_notebook(&self.key, &c.current.ciphertext)?;
                Ok(PushOutcome::Conflict { version: c.current.version, notebook })
            }
            s => {
                let text = resp.text().await.unwrap_or_default();
                bail!("server returned {s}: {text}");
            }
        }
    }

    /// The server's current snapshot version — used to force-overwrite the
    /// server with local content (push with this as `expected_version`).
    pub async fn server_version(&self) -> Result<i64> {
        Ok(self.get_snapshot().await?.version)
    }

    pub async fn delete_account(&self) -> Result<()> {
        let url = format!(
            "{}/accounts/{}",
            self.cfg.server_url.trim_end_matches('/'),
            self.cfg.account_id,
        );
        let resp = self
            .http
            .delete(&url)
            .bearer_auth(&self.cfg.api_token)
            .send()
            .await
            .context("DELETE /accounts/{id}")?;
        if !resp.status().is_success() {
            bail!(
                "server returned {}: {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            );
        }
        Ok(())
    }

    async fn get_snapshot(&self) -> Result<SyncSnapshot> {
        let resp = self
            .http
            .get(self.sync_url())
            .bearer_auth(&self.cfg.api_token)
            .send()
            .await
            .context("GET /sync")?;
        if !resp.status().is_success() {
            bail!(
                "server returned {}: {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            );
        }
        resp.json::<SyncSnapshot>().await.context("decode SyncSnapshot")
    }
}

fn decrypt_notebook(key: &Key, ct: &Option<Vec<u8>>) -> Result<Notebook> {
    match ct.as_deref() {
        Some(bytes) => {
            let pt = shared::crypto::decrypt(key, bytes).context("decrypt snapshot")?;
            Notebook::from_bytes(&pt).context("parse snapshot")
        }
        None => Ok(Notebook::default()),
    }
}
