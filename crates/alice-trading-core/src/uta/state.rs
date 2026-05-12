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
        let commit_path = data_root.join(format!("trading/{}/commit.json", account_id));
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
}
