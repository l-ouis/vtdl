use std::net::SocketAddr;

use anyhow::Result;
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use clap::Parser;
use serde::Serialize;
use shared::{PutConflict, PutOk, PutRequest, RegisterRequest, SyncSnapshot};
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use subtle::ConstantTimeEq;
use tower_http::trace::TraceLayer;

#[derive(Parser, Debug)]
#[command(name = "rune-server")]
struct Args {
    /// Bind address.
    #[arg(long, env = "RUNE_BIND", default_value = "127.0.0.1:8787")]
    bind: SocketAddr,
    /// SQLite database file.
    #[arg(long, env = "RUNE_DB", default_value = "rune.sqlite")]
    db: String,
    /// Max number of history days each account may sync. 0 = unlimited.
    /// Clients honor this voluntarily — server cannot decrypt to enforce.
    #[arg(long, env = "RUNE_HISTORY_DAYS", default_value_t = 0)]
    history_days: u32,
    /// Whether new account registration is accepted. Existing accounts can
    /// always sync regardless.
    #[arg(long, env = "RUNE_ALLOW_REGISTRATION", default_value_t = true)]
    allow_registration: bool,
}

#[derive(Clone)]
struct AppState {
    pool: SqlitePool,
    history_days: u32,
    allow_registration: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "rune_server=info,tower_http=info".into()),
        )
        .init();

    let args = Args::parse();

    let url = format!("sqlite://{}?mode=rwc", args.db);
    let pool = SqlitePoolOptions::new().max_connections(5).connect(&url).await?;
    init_schema(&pool).await?;

    let app = Router::new()
        .route("/accounts", post(register))
        .route("/accounts/{id}", delete(delete_account))
        .route("/accounts/{id}/sync", get(get_sync).put(put_sync))
        .route("/healthz", get(healthz))
        .layer(TraceLayer::new_for_http())
        .with_state(AppState {
            pool,
            history_days: args.history_days,
            allow_registration: args.allow_registration,
        });

    tracing::info!("listening on {}", args.bind);
    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[derive(Serialize)]
struct ServerInfo {
    service: &'static str,
    version: &'static str,
    history_days: u32,
    allow_registration: bool,
}

async fn healthz(State(st): State<AppState>) -> Json<ServerInfo> {
    Json(ServerInfo {
        service: "rune",
        version: env!("CARGO_PKG_VERSION"),
        history_days: st.history_days,
        allow_registration: st.allow_registration,
    })
}

async fn init_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS accounts (
            id              TEXT PRIMARY KEY,
            api_token_hash  BLOB NOT NULL,
            kdf_salt        BLOB NOT NULL,
            version         INTEGER NOT NULL DEFAULT 0,
            ciphertext      BLOB,
            updated_at      INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

fn hash_token(token: &str) -> Vec<u8> {
    blake3::hash(token.as_bytes()).as_bytes().to_vec()
}

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug)]
enum ApiError {
    Conflict409(PutConflict),
    AccountExists,
    Unauthorized,
    BadRequest(&'static str),
    RegistrationDisabled,
    Internal(anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::Conflict409(c) => (StatusCode::CONFLICT, Json(c)).into_response(),
            ApiError::AccountExists => {
                (StatusCode::CONFLICT, "account already exists").into_response()
            }
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m).into_response(),
            ApiError::RegistrationDisabled => (
                StatusCode::FORBIDDEN,
                "registration is paused on this server",
            )
                .into_response(),
            ApiError::Internal(e) => {
                tracing::error!(error = %e, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
            }
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        ApiError::Internal(e.into())
    }
}

async fn register(
    State(st): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<StatusCode, ApiError> {
    if !st.allow_registration {
        return Err(ApiError::RegistrationDisabled);
    }
    if req.account_id.is_empty() || req.account_id.len() > 128 {
        return Err(ApiError::BadRequest("invalid account_id"));
    }
    if req.api_token.len() < 16 {
        return Err(ApiError::BadRequest("api_token too short"));
    }
    if req.kdf_salt.len() != shared::KDF_SALT_LEN {
        return Err(ApiError::BadRequest("invalid kdf_salt length"));
    }
    let token_hash = hash_token(&req.api_token);
    let res = sqlx::query(
        "INSERT INTO accounts (id, api_token_hash, kdf_salt, version, ciphertext, updated_at) \
         VALUES (?, ?, ?, 0, NULL, ?)",
    )
    .bind(&req.account_id)
    .bind(&token_hash)
    .bind(&req.kdf_salt)
    .bind(now_secs())
    .execute(&st.pool)
    .await;
    match res {
        Ok(_) => Ok(StatusCode::CREATED),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Err(ApiError::AccountExists),
        Err(e) => Err(e.into()),
    }
}

async fn authorize(
    pool: &SqlitePool,
    headers: &HeaderMap,
    account_id: &str,
) -> Result<(Vec<u8>, i64, Option<Vec<u8>>), ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    let provided = hash_token(token);
    let row: Option<(Vec<u8>, Vec<u8>, i64, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT api_token_hash, kdf_salt, version, ciphertext FROM accounts WHERE id = ?",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    let (stored, salt, version, ct) = row.ok_or(ApiError::Unauthorized)?;
    if !bool::from(stored.as_slice().ct_eq(provided.as_slice())) {
        return Err(ApiError::Unauthorized);
    }
    Ok((salt, version, ct))
}

async fn get_sync(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<SyncSnapshot>, ApiError> {
    let (kdf_salt, version, ciphertext) = authorize(&st.pool, &headers, &id).await?;
    Ok(Json(SyncSnapshot { version, kdf_salt, ciphertext }))
}

async fn delete_account(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    // authorize() verifies the Bearer token against the stored hash.
    authorize(&st.pool, &headers, &id).await?;
    sqlx::query("DELETE FROM accounts WHERE id = ?")
        .bind(&id)
        .execute(&st.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn put_sync(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<PutRequest>,
) -> Result<Json<PutOk>, ApiError> {
    let (kdf_salt, current_version, current_ct) = authorize(&st.pool, &headers, &id).await?;
    if req.expected_version != current_version {
        return Err(ApiError::Conflict409(PutConflict {
            current: SyncSnapshot {
                version: current_version,
                kdf_salt,
                ciphertext: current_ct,
            },
        }));
    }
    let new_version = current_version + 1;
    let updated = sqlx::query(
        "UPDATE accounts SET version = ?, ciphertext = ?, updated_at = ? \
         WHERE id = ? AND version = ?",
    )
    .bind(new_version)
    .bind(&req.ciphertext)
    .bind(now_secs())
    .bind(&id)
    .bind(current_version)
    .execute(&st.pool)
    .await?;
    if updated.rows_affected() == 0 {
        // raced with another writer; report current state
        let (kdf_salt, current_version, current_ct) = authorize(&st.pool, &headers, &id).await?;
        return Err(ApiError::Conflict409(PutConflict {
            current: SyncSnapshot {
                version: current_version,
                kdf_salt,
                ciphertext: current_ct,
            },
        }));
    }
    Ok(Json(PutOk { version: new_version }))
}

