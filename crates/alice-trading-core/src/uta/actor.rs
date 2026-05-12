//! UtaActor — single-task per-UTA event loop. Phase 4d Task B:
//! tokio::select! over cmd_rx + signal_rx. GetHealth and NudgeRecovery
//! wired. Phase 4d Task D wires Push/Reject/Sync to TradingGit + broker.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::brokers::error::{BrokerError, BrokerErrorCode};
use crate::brokers::traits::Broker;
use crate::brokers::types::{BrokerHealth, BrokerHealthInfo};
use crate::types::{
    AddResult, CommitPrepareResult, GitExportState, GitState, Operation, OrderStatusUpdate,
    PushResult, RejectResult, SyncResult,
};
use crate::uta::command::{RecoverySignal, UtaCommand, UtaEvent};
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
            UtaCommand::Push { reply } => {
                let _ = reply.send(self.handle_push().await);
                false
            }
            UtaCommand::Reject { reason, reply } => {
                let _ = reply.send(self.handle_reject(reason).await);
                false
            }
            UtaCommand::Sync {
                updates,
                current_state,
                reply,
            } => {
                let _ = reply.send(self.handle_sync(updates, current_state).await);
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

    async fn handle_push(&mut self) -> Result<PushResult, BrokerError> {
        // 1. Reject if disabled (mirrors TS UTA._doPush() permanent-config check).
        if self.state.health.disabled {
            return Err(BrokerError::new(
                BrokerErrorCode::Config,
                format!("Account \"{}\" is disabled", self.state.account_id),
            ));
        }
        // 2. Reject if offline (mirrors TS UTA._doPush() health check).
        if self.state.health.health() == BrokerHealth::Offline {
            return Err(BrokerError::new(
                BrokerErrorCode::Network,
                format!("Account \"{}\" is offline", self.state.account_id),
            ));
        }

        // 3. Run TradingGit push with an async per-op dispatcher closure.
        let broker = self.state.broker.clone();
        let dispatcher = move |op: &Operation| {
            let broker = broker.clone();
            let op = op.clone();
            Box::pin(async move { broker_dispatch(&broker, &op).await })
                as std::pin::Pin<
                    Box<dyn std::future::Future<Output = Result<Value, String>> + Send>,
                >
        };

        let push_result = self
            .state
            .git
            .push_with_dispatcher(&dispatcher)
            .await
            .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e))?;

        // 4. Health is intentionally NOT updated here. Per-op rejections
        //    (failures within the push batch) are not broker-level failures
        //    — they're order-level outcomes. TS UnifiedTradingAccount._doPush
        //    similarly never touches health; broker-level health transitions
        //    happen only in _callBroker (broker-RPC wrapper, not present in
        //    Rust yet — Phase 4d Task D scope). Phase 4d intentionally keeps
        //    the actor's health untouched on push to match TS semantics.
        //    Phase 4f will wire health updates through the actual broker
        //    RPC layer (BrokerError → on_failure; success returns → on_success).

        // 5. Persist commit atomically. Persist failures are logged but do not
        //    fail the push — matches TS behavior.
        let export = self.state.git.export_state();
        if let Err(e) = crate::uta::persist::persist_commit_atomic(
            &self.state.account_id,
            &export,
            &self.state.data_root,
        )
        .await
        {
            tracing::error!(
                target: "uta",
                account = %self.state.account_id,
                error = %e,
                "commit persist failed",
            );
        }

        // 6. Emit commit.notify event if subscribed.
        if let Some(tx) = &self.state.event_tx {
            let _ = tx
                .send(UtaEvent::CommitNotify {
                    account_id: self.state.account_id.clone(),
                    commit_hash: push_result.hash.clone(),
                })
                .await;
        }

        Ok(push_result)
    }

    async fn handle_reject(&mut self, reason: Option<String>) -> Result<RejectResult, BrokerError> {
        // Reject builds a [rejected] commit without invoking the broker.
        // Phase 2 dividend: v2 hash is recomputed with the [rejected]-prefixed
        // message inside TradingGit::reject.
        let reject_result = self
            .state
            .git
            .reject(reason)
            .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e))?;

        let export = self.state.git.export_state();
        if let Err(e) = crate::uta::persist::persist_commit_atomic(
            &self.state.account_id,
            &export,
            &self.state.data_root,
        )
        .await
        {
            tracing::error!(
                target: "uta",
                account = %self.state.account_id,
                error = %e,
                "reject persist failed",
            );
        }

        if let Some(tx) = &self.state.event_tx {
            let _ = tx
                .send(UtaEvent::CommitNotify {
                    account_id: self.state.account_id.clone(),
                    commit_hash: reject_result.hash.clone(),
                })
                .await;
        }

        Ok(reject_result)
    }

    async fn handle_sync(
        &mut self,
        updates: Vec<OrderStatusUpdate>,
        current_state: GitState,
    ) -> Result<SyncResult, BrokerError> {
        let result = self
            .state
            .git
            .sync(updates, current_state)
            .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e))?;

        let export = self.state.git.export_state();
        if let Err(e) = crate::uta::persist::persist_commit_atomic(
            &self.state.account_id,
            &export,
            &self.state.data_root,
        )
        .await
        {
            tracing::error!(
                target: "uta",
                account = %self.state.account_id,
                error = %e,
                "sync persist failed",
            );
        }

        if let Some(tx) = &self.state.event_tx {
            let _ = tx
                .send(UtaEvent::CommitNotify {
                    account_id: self.state.account_id.clone(),
                    commit_hash: result.hash.clone(),
                })
                .await;
        }

        Ok(result)
    }
}

/// Route an `Operation` to the appropriate `Broker` method and return the
/// raw JSON-serialized result. Mirrors the TS dispatcher closure in
/// `UnifiedTradingAccount.ts:153-166`.
async fn broker_dispatch(broker: &Arc<dyn Broker>, op: &Operation) -> Result<Value, String> {
    let result = match op {
        Operation::PlaceOrder {
            contract,
            order,
            tpsl,
        } => broker
            .place_order(contract, order, tpsl.as_ref())
            .await
            .map_err(|e| e.message)?,
        Operation::ModifyOrder { order_id, changes } => broker
            .modify_order(order_id, changes)
            .await
            .map_err(|e| e.message)?,
        Operation::CancelOrder { order_id, .. } => {
            broker.cancel_order(order_id).await.map_err(|e| e.message)?
        }
        Operation::ClosePosition { contract, quantity } => broker
            .close_position(contract, quantity.as_deref())
            .await
            .map_err(|e| e.message)?,
        Operation::SyncOrders => {
            return Err("syncOrders dispatched via handle_sync".to_string());
        }
    };
    serde_json::to_value(result).map_err(|e| e.to_string())
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

    pub async fn push(&self) -> Result<PushResult, BrokerError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(UtaCommand::Push { reply: tx })
            .await
            .map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor stopped".to_string()))?;
        rx.await.map_err(|_| {
            BrokerError::new(BrokerErrorCode::Unknown, "actor reply dropped".to_string())
        })?
    }

    pub async fn reject(&self, reason: Option<String>) -> Result<RejectResult, BrokerError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(UtaCommand::Reject { reason, reply: tx })
            .await
            .map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor stopped".to_string()))?;
        rx.await.map_err(|_| {
            BrokerError::new(BrokerErrorCode::Unknown, "actor reply dropped".to_string())
        })?
    }

    pub async fn sync(
        &self,
        updates: Vec<OrderStatusUpdate>,
        current_state: GitState,
    ) -> Result<SyncResult, BrokerError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(UtaCommand::Sync {
                updates,
                current_state,
                reply: tx,
            })
            .await
            .map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor stopped".to_string()))?;
        rx.await.map_err(|_| {
            BrokerError::new(BrokerErrorCode::Unknown, "actor reply dropped".to_string())
        })?
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
