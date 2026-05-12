//! UtaState — all per-account state owned by a single UtaActor.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::brokers::traits::Broker;
use crate::git::{TradingGit, TradingGitConfig};
use crate::guards::traits::Guard;
use crate::uta::command::UtaEvent;
use crate::uta::health::HealthState;

pub struct UtaState {
    pub account_id: String,
    pub git: TradingGit,
    pub broker: Arc<dyn Broker>,
    pub guards: Vec<Box<dyn Guard>>,
    pub health: HealthState,
    pub commit_path: PathBuf,
    pub event_tx: Option<mpsc::Sender<UtaEvent>>,
    pub data_root: PathBuf,
}

impl UtaState {
    /// Build a fresh state with a default empty TradingGit.
    pub fn new(
        account_id: String,
        broker: Arc<dyn Broker>,
        guards: Vec<Box<dyn Guard>>,
        data_root: PathBuf,
    ) -> Self {
        let commit_path = crate::uta::persist::commit_path(&account_id, &data_root);
        let git_config = TradingGitConfig::stub();
        Self {
            account_id,
            git: TradingGit::new(git_config),
            broker,
            guards,
            health: HealthState::default(),
            commit_path,
            event_tx: None,
            data_root,
        }
    }

    /// Build state with TradingGit restored from disk, or fresh if no saved state exists.
    /// Tries primary path → legacy fallback → fresh.
    pub async fn restore_or_new(
        account_id: String,
        broker: Arc<dyn Broker>,
        guards: Vec<Box<dyn Guard>>,
        data_root: PathBuf,
    ) -> Self {
        let git = match crate::uta::persist::load_git_state(&account_id, &data_root).await {
            Some(state) => {
                let config = crate::git::TradingGitConfig::stub();
                crate::git::TradingGit::restore(state, config)
            }
            None => crate::git::TradingGit::new(crate::git::TradingGitConfig::stub()),
        };
        let commit_path = crate::uta::persist::commit_path(&account_id, &data_root);
        Self {
            account_id,
            git,
            broker,
            guards,
            health: HealthState::default(),
            commit_path,
            event_tx: None,
            data_root,
        }
    }
}
