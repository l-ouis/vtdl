use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use thiserror::Error;
use zeroize::ZeroizeOnDrop;

pub const KDF_SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;

#[derive(Clone, ZeroizeOnDrop)]
pub struct Key(pub [u8; 32]);

impl Key {
    pub fn from_bytes(b: [u8; 32]) -> Self {
        Self(b)
    }
}

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("key derivation failed: {0}")]
    Kdf(String),
    #[error("encryption failed")]
    Encrypt,
    #[error("decryption failed (wrong key or corrupted data)")]
    Decrypt,
    #[error("ciphertext too short")]
    TooShort,
}

/// Derive a 32-byte key from a passphrase + per-account salt using Argon2id.
/// Parameters chosen for ~250ms on a modern desktop; tune if needed.
pub fn derive_key(passphrase: &str, salt: &[u8]) -> Result<Key, CryptoError> {
    let params = Params::new(64 * 1024, 3, 1, Some(32))
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    Ok(Key(out))
}

pub fn random_salt() -> [u8; KDF_SALT_LEN] {
    let mut s = [0u8; KDF_SALT_LEN];
    rand::thread_rng().fill_bytes(&mut s);
    s
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
    B64.encode(bytes)
}

/// Encrypt `plaintext` with a fresh random nonce; output layout is
/// `nonce (24B) || ciphertext+tag`.
pub fn encrypt(key: &Key, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new((&key.0).into());
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| CryptoError::Encrypt)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt(key: &Key, blob: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if blob.len() < NONCE_LEN {
        return Err(CryptoError::TooShort);
    }
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new((&key.0).into());
    cipher
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| CryptoError::Decrypt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let salt = random_salt();
        let key = derive_key("hunter2", &salt).unwrap();
        let pt = b"hello";
        let ct = encrypt(&key, pt).unwrap();
        let back = decrypt(&key, &ct).unwrap();
        assert_eq!(pt, back.as_slice());
    }

    #[test]
    fn wrong_key_fails() {
        let salt = random_salt();
        let k1 = derive_key("a", &salt).unwrap();
        let k2 = derive_key("b", &salt).unwrap();
        let ct = encrypt(&k1, b"x").unwrap();
        assert!(decrypt(&k2, &ct).is_err());
    }
}
