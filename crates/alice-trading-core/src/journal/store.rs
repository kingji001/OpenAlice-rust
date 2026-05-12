//! ExecutionJournal — atomic on-disk store for in-flight broker executions.

use crate::brokers::error::{BrokerError, BrokerErrorCode};
use crate::journal::types::{
    EntryState, ExecutionIntent, ExecutionResult, JournalEntry, JournalHandle,
};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub struct ExecutionJournal {
    dir: PathBuf,
    done_dir: PathBuf,
}

impl ExecutionJournal {
    pub fn new(account_id: &str, data_root: &Path) -> Self {
        let dir = data_root.join(format!("trading/{}/executing", account_id));
        let done_dir = dir.join("done");
        Self { dir, done_dir }
    }

    /// Path for an in-flight entry. `<dir>/<commit_hash>.json`.
    fn entry_path(&self, commit_hash: &str) -> PathBuf {
        self.dir.join(format!("{}.json", commit_hash))
    }

    /// Path for a closed entry. `<dir>/done/<commit_hash>.json`.
    fn done_path(&self, commit_hash: &str) -> PathBuf {
        self.done_dir.join(format!("{}.json", commit_hash))
    }

    /// Step 1: write entry with state='executing' + fsync.
    pub async fn record_intent(
        &self,
        intent: ExecutionIntent,
    ) -> Result<JournalHandle, BrokerError> {
        let commit_hash = intent.commit_hash.clone();
        let entry = JournalEntry {
            state: EntryState::Executing,
            intent,
            result: None,
        };
        let path = self.entry_path(&commit_hash);
        write_atomic(&path, &entry).await?;
        Ok(JournalHandle { commit_hash })
    }

    /// Step 3: rewrite entry with state='completed' | 'failed' + fsync.
    pub async fn record_completion(
        &self,
        handle: &JournalHandle,
        result: ExecutionResult,
    ) -> Result<(), BrokerError> {
        let path = self.entry_path(&handle.commit_hash);
        // Read existing entry to keep the intent
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            BrokerError::new(BrokerErrorCode::Network, format!("journal read: {}", e))
        })?;
        let mut entry: JournalEntry = serde_json::from_slice(&bytes).map_err(|e| {
            BrokerError::new(BrokerErrorCode::Unknown, format!("journal parse: {}", e))
        })?;
        entry.state = if result.success {
            EntryState::Completed
        } else {
            EntryState::Failed
        };
        entry.result = Some(result);
        write_atomic(&path, &entry).await
    }

    /// Step 5: move <dir>/<hash>.json → <dir>/done/<hash>.json.
    pub async fn close(&self, handle: JournalHandle) -> Result<(), BrokerError> {
        let src = self.entry_path(&handle.commit_hash);
        let dst = self.done_path(&handle.commit_hash);
        let dst_clone = dst.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            if let Some(parent) = dst_clone.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(&src, &dst_clone)?;
            Ok(())
        })
        .await
        .map_err(|e| {
            BrokerError::new(
                BrokerErrorCode::Unknown,
                format!("journal close join: {}", e),
            )
        })?
        .map_err(|e| BrokerError::new(BrokerErrorCode::Network, format!("journal close: {}", e)))
    }

    /// List non-done entries (still under <dir>, not yet moved to <dir>/done).
    pub async fn list_pending(&self) -> Result<Vec<JournalEntry>, BrokerError> {
        let dir = self.dir.clone();
        let entries = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<JournalEntry>> {
            if !dir.exists() {
                return Ok(vec![]);
            }
            let mut out = Vec::new();
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                // Skip the done/ subdirectory + non-.json files
                if path.is_dir() {
                    continue;
                }
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let bytes = std::fs::read(&path)?;
                if let Ok(je) = serde_json::from_slice::<JournalEntry>(&bytes) {
                    out.push(je);
                }
            }
            Ok(out)
        })
        .await
        .map_err(|e| {
            BrokerError::new(
                BrokerErrorCode::Unknown,
                format!("list_pending join: {}", e),
            )
        })?
        .map_err(|e| {
            BrokerError::new(BrokerErrorCode::Network, format!("list_pending io: {}", e))
        })?;
        Ok(entries)
    }
}

/// Atomic-write helper — same recipe as uta::persist::persist_commit_atomic.
async fn write_atomic<T>(path: &Path, value: &T) -> Result<(), BrokerError>
where
    T: Serialize + 'static + Send + Clone,
{
    let path = path.to_path_buf();
    let value = value.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let dir = path.parent().expect("entry path has parent");
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(
            "{}.tmp.{}",
            path.file_name().unwrap().to_string_lossy(),
            std::process::id(),
        ));
        let json = serde_json::to_string_pretty(&value)
            .map_err(|e| std::io::Error::other(format!("serialize: {}", e)))?;
        std::fs::write(&tmp, &json)?;
        std::fs::File::open(&tmp)?.sync_all()?;
        std::fs::rename(&tmp, &path)?;
        if let Ok(dir_file) = std::fs::File::open(dir) {
            let _ = dir_file.sync_all();
        }
        Ok(())
    })
    .await
    .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, format!("join error: {}", e)))?
    .map_err(|e| BrokerError::new(BrokerErrorCode::Network, format!("journal write: {}", e)))
}
