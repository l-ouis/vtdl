use serde::{Deserialize, Serialize};

/// Sent by client to create a new account.
/// `api_token` is the plaintext bearer token the client picks; the server stores
/// only its hash. `kdf_salt` is the per-account Argon2 salt for key derivation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub account_id: String,
    pub api_token: String,
    #[serde(with = "b64")]
    pub kdf_salt: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSnapshot {
    pub version: i64,
    #[serde(with = "b64")]
    pub kdf_salt: Vec<u8>,
    #[serde(with = "b64_opt")]
    pub ciphertext: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutRequest {
    pub expected_version: i64,
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutOk {
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutConflict {
    pub current: SyncSnapshot,
}

mod b64 {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        B64.encode(bytes).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        B64.decode(s).map_err(serde::de::Error::custom)
    }
}

mod b64_opt {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(b) => Some(B64.encode(b)).serialize(s),
            None => None::<String>.serialize(s),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        let opt: Option<String> = Option::deserialize(d)?;
        opt.map(|s| B64.decode(s).map_err(serde::de::Error::custom))
            .transpose()
    }
}
