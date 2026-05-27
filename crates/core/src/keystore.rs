use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use keyring::Entry;
use shared::crypto::Key;

const SERVICE: &str = "dev.rune.rune";

fn entry(account: &str) -> Result<Entry> {
    Entry::new(SERVICE, account).context("open keyring entry")
}

pub fn put_key(account: &str, key: &Key) -> Result<()> {
    let entry = entry(account)?;
    entry
        .set_password(&B64.encode(key.0))
        .context("write key to keyring")
}

pub fn get_key(account: &str) -> Result<Key> {
    let entry = entry(account)?;
    let s = entry.get_password().context("read key from keyring")?;
    let bytes = B64.decode(s).context("decode key from keyring")?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| anyhow!("bad key length in keyring"))?;
    Ok(Key::from_bytes(arr))
}

pub fn delete_key(account: &str) -> Result<()> {
    let entry = entry(account)?;
    let _ = entry.delete_credential();
    Ok(())
}
