//! UtaActor — single-task per-UTA event loop. Phase 4d Task A scaffold:
//! only Add/Commit/ExportState/Shutdown variants implemented; Push/Reject/
//! Sync/Health/NudgeRecovery wired in later tasks.

use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::brokers::error::{BrokerError, BrokerErrorCode};
use crate::types::{AddResult, CommitPrepareResult, GitExportState, Operation};
use crate::uta::command::UtaCommand;
use crate::uta::state::UtaState;

pub struct UtaActor {
    cmd_rx: mpsc::Receiver<UtaCommand>,
    state: UtaState,
}

pub struct UtaHandle {
    pub account_id: String,
    cmd_tx: mpsc::Sender<UtaCommand>,
}

impl Clone for UtaHandle {
    fn clone(&self) -> Self {
        Self {
            account_id: self.account_id.clone(),
            cmd_tx: self.cmd_tx.clone(),
        }
    }
}

impl UtaActor {
    /// Build and spawn the actor on a tokio task.
    pub fn spawn(state: UtaState, buffer: usize) -> (UtaHandle, JoinHandle<()>) {
        let (tx, rx) = mpsc::channel(buffer);
        let account_id = state.account_id.clone();
        let actor = UtaActor { cmd_rx: rx, state };
        let join = tokio::spawn(actor.run());
        (
            UtaHandle {
                account_id,
                cmd_tx: tx,
            },
            join,
        )
    }

    pub async fn run(mut self) {
        while let Some(cmd) = self.cmd_rx.recv().await {
            match cmd {
                UtaCommand::Add { op, reply } => {
                    let result = self.handle_add(op);
                    let _ = reply.send(result);
                }
                UtaCommand::Commit { message, reply } => {
                    let result = self.handle_commit(message);
                    let _ = reply.send(result);
                }
                UtaCommand::ExportState { reply } => {
                    let _ = reply.send(self.state.git.export_state());
                }
                UtaCommand::Shutdown { reply } => {
                    let _ = reply.send(());
                    return;
                }
                // Phase 4d Task B/C/D add the remaining variants below.
                UtaCommand::Push { reply } => {
                    let _ = reply.send(Err(BrokerError::new(
                        BrokerErrorCode::Unknown,
                        "Task A scaffold: Push not yet implemented".to_string(),
                    )));
                }
                UtaCommand::Reject { reply, .. } => {
                    let _ = reply.send(Err(BrokerError::new(
                        BrokerErrorCode::Unknown,
                        "Task A scaffold: Reject not yet implemented".to_string(),
                    )));
                }
                UtaCommand::Sync { reply, .. } => {
                    let _ = reply.send(Err(BrokerError::new(
                        BrokerErrorCode::Unknown,
                        "Task A scaffold: Sync not yet implemented".to_string(),
                    )));
                }
                UtaCommand::GetHealth { reply: _ } => {
                    // Task B replaces this with self.state.health.info()
                }
                UtaCommand::NudgeRecovery => {
                    // Task B wires nudge_recovery
                }
            }
        }
    }

    fn handle_add(&mut self, op: Operation) -> Result<AddResult, String> {
        Ok(self.state.git.add(op))
    }

    fn handle_commit(&mut self, message: String) -> Result<CommitPrepareResult, String> {
        self.state.git.commit(message).map_err(|e| e.to_string())
    }
}

impl UtaHandle {
    pub async fn add(&self, op: Operation) -> Result<AddResult, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(UtaCommand::Add { op, reply: tx })
            .await
            .map_err(|_| "actor stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())?
    }

    pub async fn commit(&self, message: String) -> Result<CommitPrepareResult, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(UtaCommand::Commit { message, reply: tx })
            .await
            .map_err(|_| "actor stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())?
    }

    pub async fn export_state(&self) -> Result<GitExportState, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(UtaCommand::ExportState { reply: tx })
            .await
            .map_err(|_| "actor stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())
    }

    pub async fn shutdown(self) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(UtaCommand::Shutdown { reply: tx })
            .await
            .map_err(|_| "actor already stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())
    }

    // Task B/C/D add: push, reject, sync, get_health, nudge_recovery, etc.
}
