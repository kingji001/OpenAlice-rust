//! HealthState — port of UnifiedTradingAccount.ts:193-328.
//!
//! Tracks broker health via consecutive failure count + transitions to
//! degraded (≥3) / offline (≥6). Spawns an exp-backoff recovery task on
//! offline; recovery task signals via mpsc back to the actor.
//!
//! Drop aborts the recovery task to prevent leaks.

use chrono::{DateTime, Utc};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Duration};

use crate::brokers::error::{BrokerError, BrokerErrorCode};
use crate::brokers::traits::Broker;
use crate::brokers::types::{BrokerHealth, BrokerHealthInfo};
use crate::uta::command::RecoverySignal;

pub struct HealthState {
    pub disabled: bool,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_failure_at: Option<DateTime<Utc>>,
    pub recovering: bool,
    recovery_task: Option<JoinHandle<()>>,
}

impl HealthState {
    pub const DEGRADED_THRESHOLD: u32 = 3;
    pub const OFFLINE_THRESHOLD: u32 = 6;
    pub const RECOVERY_BASE_MS: u64 = 5_000;
    pub const RECOVERY_MAX_MS: u64 = 60_000;

    pub fn health(&self) -> BrokerHealth {
        if self.disabled {
            return BrokerHealth::Offline;
        }
        if self.consecutive_failures >= Self::OFFLINE_THRESHOLD {
            return BrokerHealth::Offline;
        }
        if self.consecutive_failures >= Self::DEGRADED_THRESHOLD {
            return BrokerHealth::Unhealthy;
        }
        BrokerHealth::Healthy
    }

    pub fn info(&self) -> BrokerHealthInfo {
        BrokerHealthInfo {
            status: self.health(),
            last_check: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            message: self.last_error.clone(),
            consecutive_failures: Some(self.consecutive_failures),
        }
    }

    /// Called after every successful broker call.
    pub fn on_success(&mut self) {
        self.consecutive_failures = 0;
        self.last_success_at = Some(Utc::now());
        if let Some(task) = self.recovery_task.take() {
            task.abort();
            self.recovering = false;
        }
    }

    /// Called after every failed broker call. Returns true if the caller
    /// (actor) should now start a recovery loop.
    pub fn on_failure(&mut self, err: &BrokerError) -> bool {
        self.consecutive_failures += 1;
        self.last_error = Some(err.message.clone());
        self.last_failure_at = Some(Utc::now());
        if err.code == BrokerErrorCode::Config || err.code == BrokerErrorCode::Auth {
            self.disabled = true;
        }
        let should_recover =
            self.health() == BrokerHealth::Offline && !self.recovering && !self.disabled;
        if should_recover {
            self.recovering = true;
        }
        should_recover
    }

    /// Spawn the recovery loop. Caller passes a clone of broker + a Sender
    /// to signal back.
    pub fn start_recovery(
        &mut self,
        broker: Arc<dyn Broker>,
        signal_tx: mpsc::Sender<RecoverySignal>,
    ) {
        if let Some(prev) = self.recovery_task.take() {
            prev.abort();
        }
        let task = tokio::spawn(async move {
            let mut attempt: u32 = 0;
            loop {
                let delay_ms = std::cmp::min(
                    Self::RECOVERY_BASE_MS.saturating_mul(2u64.saturating_pow(attempt)),
                    Self::RECOVERY_MAX_MS,
                );
                sleep(Duration::from_millis(delay_ms)).await;
                match broker.init().await {
                    Ok(()) => match broker.get_account().await {
                        Ok(_) => {
                            let _ = signal_tx.send(RecoverySignal::Recovered).await;
                            return;
                        }
                        Err(e) => {
                            let _ = signal_tx
                                .send(RecoverySignal::Attempt {
                                    attempt,
                                    error: e.message,
                                })
                                .await;
                        }
                    },
                    Err(e) => {
                        let _ = signal_tx
                            .send(RecoverySignal::Attempt {
                                attempt,
                                error: e.message,
                            })
                            .await;
                    }
                }
                attempt = attempt.saturating_add(1);
            }
        });
        self.recovery_task = Some(task);
    }

    /// Cancel current recovery + re-spawn at attempt=0 (called via nudge_recovery).
    pub fn nudge_recovery(
        &mut self,
        broker: Arc<dyn Broker>,
        signal_tx: mpsc::Sender<RecoverySignal>,
    ) {
        if !self.recovering || self.disabled {
            return;
        }
        self.start_recovery(broker, signal_tx);
    }
}

#[allow(clippy::derivable_impls)] // JoinHandle<()> does not impl Default
impl Default for HealthState {
    fn default() -> Self {
        Self {
            disabled: false,
            consecutive_failures: 0,
            last_error: None,
            last_success_at: None,
            last_failure_at: None,
            recovering: false,
            recovery_task: None,
        }
    }
}

impl Drop for HealthState {
    fn drop(&mut self) {
        if let Some(task) = self.recovery_task.take() {
            task.abort();
        }
    }
}
