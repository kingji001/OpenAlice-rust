//! UtaActor — single-task per-UTA event loop. Phase 4d Task B:
//! tokio::select! over cmd_rx + signal_rx. GetHealth and NudgeRecovery
//! wired. Push/Reject/Sync scaffolded for Task D.

use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::brokers::error::{BrokerError, BrokerErrorCode};
use crate::brokers::types::BrokerHealthInfo;
use crate::types::{AddResult, CommitPrepareResult, GitExportState, Operation};
use crate::uta::command::{RecoverySignal, UtaCommand};
use crate::uta::state::UtaState;

pub struct UtaActor {
    cmd_rx: mpsc::Receiver<UtaCommand>,
    signal_rx: mpsc::Receiver<RecoverySignal>,
    signal_tx: mpsc::Sender<RecoverySignal>,
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
        let (sig_tx, sig_rx) = mpsc::channel(8);
        let account_id = state.account_id.clone();
        let actor = UtaActor {
            cmd_rx: rx,
            signal_rx: sig_rx,
            signal_tx: sig_tx,
            state,
        };
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
        loop {
            tokio::select! {
                Some(cmd) = self.cmd_rx.recv() => {
                    let should_exit = self.dispatch_cmd(cmd).await;
                    if should_exit { return; }
                }
                Some(sig) = self.signal_rx.recv() => {
                    self.dispatch_signal(sig);
                }
                else => return,
            }
        }
    }

    async fn dispatch_cmd(&mut self, cmd: UtaCommand) -> bool {
        match cmd {
            UtaCommand::Add { op, reply } => {
                let _ = reply.send(self.handle_add(op));
                false
            }
            UtaCommand::Commit { message, reply } => {
                let _ = reply.send(self.handle_commit(message));
                false
            }
            UtaCommand::ExportState { reply } => {
                let _ = reply.send(self.state.git.export_state());
                false
            }
            UtaCommand::GetHealth { reply } => {
                let _ = reply.send(self.state.health.info());
                false
            }
            UtaCommand::NudgeRecovery => {
                let broker = self.state.broker.clone();
                let sig_tx = self.signal_tx.clone();
                self.state.health.nudge_recovery(broker, sig_tx);
                false
            }
            UtaCommand::Shutdown { reply } => {
                let _ = reply.send(());
                true
            }
            // Task D fills in Push/Reject/Sync.
            UtaCommand::Push { reply } => {
                let _ = reply.send(Err(BrokerError::new(
                    BrokerErrorCode::Unknown,
                    "Task D scaffold: Push not yet implemented".to_string(),
                )));
                false
            }
            UtaCommand::Reject { reply, .. } => {
                let _ = reply.send(Err(BrokerError::new(
                    BrokerErrorCode::Unknown,
                    "Task D scaffold: Reject not yet implemented".to_string(),
                )));
                false
            }
            UtaCommand::Sync { reply, .. } => {
                let _ = reply.send(Err(BrokerError::new(
                    BrokerErrorCode::Unknown,
                    "Task D scaffold: Sync not yet implemented".to_string(),
                )));
                false
            }
        }
    }

    fn dispatch_signal(&mut self, sig: RecoverySignal) {
        match sig {
            RecoverySignal::Recovered => {
                self.state.health.on_success();
                tracing::info!(
                    target: "uta",
                    account = %self.state.account_id,
                    "recovery succeeded"
                );
            }
            RecoverySignal::Attempt { attempt, error } => {
                tracing::warn!(
                    target: "uta",
                    account = %self.state.account_id,
                    attempt,
                    error = %error,
                    "recovery attempt failed"
                );
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

    pub async fn get_health(&self) -> Result<BrokerHealthInfo, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(UtaCommand::GetHealth { reply: tx })
            .await
            .map_err(|_| "actor stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())
    }

    /// Fire-and-forget nudge to restart recovery at attempt=0.
    pub async fn nudge_recovery(&self) -> Result<(), String> {
        self.cmd_tx
            .send(UtaCommand::NudgeRecovery)
            .await
            .map_err(|_| "actor stopped".to_string())
    }

    pub async fn shutdown(self) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(UtaCommand::Shutdown { reply: tx })
            .await
            .map_err(|_| "actor already stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())
    }
}
