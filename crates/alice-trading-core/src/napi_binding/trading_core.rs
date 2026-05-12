//! TradingCore — napi root object. Holds a per-UTA registry and exposes
//! lifecycle + event-subscription methods to the TypeScript host.
//!
//! Phase 4f Task A: init_uta, shutdown_uta, subscribe_events, event_log_recent.
//! Command methods (stage_place_order, commit, push, …) are Task B.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use napi::{Error, Status};
use napi_derive::napi;
use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::brokers::mock::{MockBroker, MockBrokerOptions};
use crate::brokers::traits::Broker;
use crate::guards::traits::Guard;
use crate::napi_binding::events::EventDispatcher;
use crate::napi_binding::types::{
    AccountConfig, BrokerConfigPayload, GuardConfig, TradingCoreConfig, TradingCoreEvent,
};
use crate::uta::command::UtaEvent;
use crate::uta::{UtaActor, UtaHandle, UtaState};

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

// ---------------------------------------------------------------------------
// Internal per-UTA proxy handle
// ---------------------------------------------------------------------------

struct UtaProxyHandle {
    handle: UtaHandle,
    /// JoinHandle for the UTA actor task. Kept so panics are not silent and
    /// so we can abort the task on shutdown.
    actor_join: Option<tokio::task::JoinHandle<()>>,
    /// JoinHandle for the event-forwarder task (UTA → EventDispatcher).
    forwarder_join: Option<tokio::task::JoinHandle<()>>,
    dispatcher: EventDispatcher,
    /// The ThreadsafeFunction used to push events to TS. Set by subscribe_events().
    tsf: Arc<Mutex<Option<ThreadsafeFunction<TradingCoreEvent>>>>,
    /// Consecutive panic count — used in Task B to gate panic-disable threshold.
    #[allow(dead_code)]
    panic_count: Arc<Mutex<u32>>,
}

// ---------------------------------------------------------------------------
// TradingCore
// ---------------------------------------------------------------------------

/// Root napi object. A single `TradingCore` instance is created by Node.js and
/// holds the per-UTA actor registry. All async operations run on the Tokio
/// runtime that was active at `create()` time (Node's tokio runtime via
/// `napi-rs` `tokio_rt` feature).
#[napi]
pub struct TradingCore {
    data_root: PathBuf,
    config: TradingCoreConfig,
    accounts: Arc<Mutex<HashMap<String, UtaProxyHandle>>>,
}

#[napi]
impl TradingCore {
    /// Build a `TradingCore` from config. Call once at app startup.
    ///
    /// `tokio::runtime::Handle::current()` at this point captures Node's
    /// embedded tokio runtime via the `napi-rs tokio_rt` feature.
    #[napi(factory)]
    pub async fn create(config: TradingCoreConfig) -> napi::Result<Self> {
        let account_id = "<create>";
        crate::napi_binding::panic::async_catch_unwind_napi(account_id, async move {
            Ok(Self {
                data_root: PathBuf::from(&config.data_root),
                config,
                accounts: Arc::new(Mutex::new(HashMap::new())),
            })
        })
        .await
    }

    /// Spawn and register a UTA actor for the given account config.
    ///
    /// Wires `UtaState.event_tx` so that the actor can emit `UtaEvent`s;
    /// those events are mapped to `TradingCoreEvent` and forwarded through
    /// the `EventDispatcher` (ring buffer + mpsc). A background task drains
    /// the mpsc and calls the registered `ThreadsafeFunction` (if any).
    ///
    /// Returns an error if a UTA with the same `id` is already initialized;
    /// call `shutdown_uta` first.
    #[napi]
    pub async fn init_uta(&self, account_config: AccountConfig) -> napi::Result<()> {
        let account_id = account_config.id.clone();
        let accounts_arc = Arc::clone(&self.accounts);
        let data_root = self.data_root.clone();
        let event_queue_capacity = self.config.event_queue_capacity;

        crate::napi_binding::panic::async_catch_unwind_napi(&account_id, async move {
            // Guard against duplicate initialization before doing any work.
            {
                let accounts = accounts_arc.lock();
                if accounts.contains_key(&account_config.id) {
                    return Err(napi::Error::new(
                        napi::Status::InvalidArg,
                        format!(
                            "UTA '{}' already initialized; call shutdown_uta first",
                            account_config.id
                        ),
                    ));
                }
            }

            let broker = build_broker(&account_config.broker_id, &account_config.broker_config)?;
            let guards = build_guards(&account_config.guards)?;

            // Restore (or create fresh) the git state + journal.
            let mut state =
                UtaState::restore_or_new(account_config.id.clone(), broker, guards, data_root)
                    .await;

            // Build the event channel that the actor will write to.
            let (uta_event_tx, mut uta_event_rx) = mpsc::channel::<UtaEvent>(64);
            state.event_tx = Some(uta_event_tx);

            let capacity = event_queue_capacity.unwrap_or(1024) as usize;
            let (dispatcher, mut disp_rx) = EventDispatcher::new(capacity);

            // Spawn the actor; retain the JoinHandle to surface panics.
            let (handle, actor_join) = UtaActor::spawn(state, 32);

            let uta_id = account_config.id.clone();
            let tsf_arc: Arc<Mutex<Option<ThreadsafeFunction<TradingCoreEvent>>>> =
                Arc::new(Mutex::new(None));
            let panic_count: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));

            // Task 1: forward UtaEvent → EventDispatcher.
            //
            // The actor writes UtaEvents to `uta_event_tx`; we map them to
            // `TradingCoreEvent` payloads and call `dispatcher.emit()`.
            let dispatcher_for_uta = dispatcher.clone();
            let uta_id_for_uta = uta_id.clone();
            let forwarder_join = tokio::spawn(async move {
                while let Some(uta_event) = uta_event_rx.recv().await {
                    let (event_type, payload_json) = map_uta_event(uta_event);
                    dispatcher_for_uta
                        .emit(&uta_id_for_uta, &event_type, payload_json)
                        .await;
                }
            });

            // Task 2: forward EventDispatcher channel → ThreadsafeFunction.
            //
            // Reads from the dispatcher's bounded mpsc. If a TSF has been
            // registered via subscribe_events(), calls it NonBlocking. Events
            // arriving before subscribe_events are retained in the ring buffer
            // for backfill via event_log_recent.
            let tsf_for_forward = Arc::clone(&tsf_arc);
            tokio::spawn(async move {
                while let Some(event) = disp_rx.recv().await {
                    let tsf_opt = tsf_for_forward.lock().clone();
                    if let Some(tsf) = tsf_opt {
                        tsf.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
            });

            accounts_arc.lock().insert(
                account_config.id.clone(),
                UtaProxyHandle {
                    handle,
                    actor_join: Some(actor_join),
                    forwarder_join: Some(forwarder_join),
                    dispatcher: dispatcher.clone(),
                    tsf: Arc::clone(&tsf_arc),
                    panic_count: Arc::clone(&panic_count),
                },
            );

            Ok(())
        })
        .await
    }

    /// Shut down the UTA actor for the given account.
    ///
    /// Removes the proxy handle from the registry (dropping the mpsc sender,
    /// which will cause the forward task to finish naturally). The actor
    /// receives a Shutdown command and terminates cleanly. Both the actor
    /// and forwarder tasks are aborted.
    #[napi]
    pub async fn shutdown_uta(&self, uta_id: String) -> napi::Result<()> {
        let uta_id_for_log = uta_id.clone();
        crate::napi_binding::panic::async_catch_unwind_napi(&uta_id_for_log, async move {
            let proxy = self.accounts.lock().remove(&uta_id);
            if let Some(mut h) = proxy {
                // Send shutdown to the actor; ignore errors (actor may have already stopped).
                let _ = h.handle.shutdown().await;
                // Abort background tasks (abort is fine for Phase 4f — no cleanup needed).
                if let Some(actor_join) = h.actor_join.take() {
                    actor_join.abort();
                }
                if let Some(fwd_join) = h.forwarder_join.take() {
                    fwd_join.abort();
                }
                // The Arc<Mutex<Option<TSF>>> is dropped here; TSF cleanup is automatic.
            }
            Ok(())
        })
        .await
    }

    /// Register a TypeScript callback to receive events for the given UTA.
    ///
    /// Uses `napi-rs` `ThreadsafeFunction` so the callback is invoked on the
    /// JS thread without blocking the Tokio runtime. Only one callback per UTA
    /// is kept; calling again replaces the previous one.
    #[napi(
        ts_args_type = "uta_id: string, callback: (err: Error | null, event: TradingCoreEvent) => void"
    )]
    pub fn subscribe_events(
        &self,
        uta_id: String,
        callback: ThreadsafeFunction<TradingCoreEvent>,
    ) -> napi::Result<()> {
        let id_for_log = uta_id.clone();
        crate::napi_binding::panic::catch_unwind_napi(&id_for_log, || {
            let accounts = self.accounts.lock();
            let proxy = accounts.get(&uta_id).ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    format!("uta '{}' not found", uta_id),
                )
            })?;
            *proxy.tsf.lock() = Some(callback);
            Ok(())
        })
    }

    /// Return all ring-buffered events for `uta_id` with seq > `after_seq`.
    ///
    /// Used by the TS `RustUtaProxy._backfill()` method when a gap in the
    /// event stream is detected (`event.seq !== lastSeq + 1`).
    #[napi]
    pub fn event_log_recent(
        &self,
        uta_id: String,
        after_seq: u32,
    ) -> napi::Result<Vec<TradingCoreEvent>> {
        let id_for_log = uta_id.clone();
        crate::napi_binding::panic::catch_unwind_napi(&id_for_log, || {
            let accounts = self.accounts.lock();
            let proxy = accounts.get(&uta_id).ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    format!("uta '{}' not found", uta_id),
                )
            })?;
            Ok(proxy.dispatcher.recent_after(after_seq))
        })
    }

    // -----------------------------------------------------------------------
    // Internal helper: look up a UtaHandle by uta_id (used by Task B methods).
    // -----------------------------------------------------------------------
    #[allow(dead_code)]
    pub(crate) fn handle_for(&self, uta_id: &str) -> napi::Result<UtaHandle> {
        let accounts = self.accounts.lock();
        let proxy = accounts.get(uta_id).ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                format!("uta '{}' not found", uta_id),
            )
        })?;
        Ok(proxy.handle.clone())
    }
}

// ---------------------------------------------------------------------------
// UtaEvent → (event_type, payload_json)
// ---------------------------------------------------------------------------

/// Map a `UtaEvent` emitted by the actor to the napi event type string and
/// serialized payload that the TS `RustUtaProxy._dispatch()` will parse.
fn map_uta_event(event: UtaEvent) -> (String, String) {
    match event {
        UtaEvent::CommitNotify {
            account_id,
            commit_hash,
        } => {
            let payload = serde_json::json!({
                "accountId": account_id,
                "commitHash": commit_hash,
            });
            ("commit.notify".to_string(), payload.to_string())
        }
        UtaEvent::HealthChange { account_id, info } => {
            let status_str = match info.status {
                crate::brokers::types::BrokerHealth::Healthy => "healthy",
                crate::brokers::types::BrokerHealth::Unhealthy => "degraded",
                crate::brokers::types::BrokerHealth::Offline => "offline",
            };
            let payload = serde_json::json!({
                "accountId": account_id,
                "status": status_str,
                "consecutiveFailures": info.consecutive_failures.unwrap_or(0),
                "nextRecoveryAt": serde_json::Value::Null,
            });
            ("account.health".to_string(), payload.to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Broker + guard construction
// ---------------------------------------------------------------------------

fn build_broker(broker_id: &str, _config: &BrokerConfigPayload) -> napi::Result<Arc<dyn Broker>> {
    match broker_id {
        "mock-paper" => Ok(Arc::new(MockBroker::new(MockBrokerOptions::default()))),
        other => Err(Error::new(
            Status::InvalidArg,
            format!(
                "unsupported broker '{}'; Phase 4f only supports 'mock-paper'",
                other
            ),
        )),
    }
}

fn build_guards(_configs: &[GuardConfig]) -> napi::Result<Vec<Box<dyn Guard>>> {
    // Phase 4f: no guards for Mock. Real guard parsing is Phase 6.
    Ok(vec![])
}
