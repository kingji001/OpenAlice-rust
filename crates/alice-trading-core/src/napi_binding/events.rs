//! Event ring buffer and dispatcher for the napi FFI event stream.
//!
//! Each UTA gets its own `EventDispatcher` which:
//!   - Assigns a per-UTA monotonic seq (u32, starts at 1).
//!   - Pushes events into a ring buffer (last 500 retained for backfill).
//!   - Forwards events to a bounded mpsc channel with a 1s backpressure
//!     timeout; drops + warns on timeout or closed receiver.

use std::collections::VecDeque;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::napi_binding::types::TradingCoreEvent;

const RING_BUFFER_SIZE: usize = 500;

pub struct EventDispatcher {
    pub tx: mpsc::Sender<TradingCoreEvent>,
    /// Per-UTA monotonic sequence counter. u32 for JS-number compatibility.
    pub seq: Arc<Mutex<u32>>,
    /// Ring buffer retaining the last 500 events for backfill queries.
    pub ring: Arc<Mutex<VecDeque<TradingCoreEvent>>>,
}

impl Clone for EventDispatcher {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
            seq: Arc::clone(&self.seq),
            ring: Arc::clone(&self.ring),
        }
    }
}

impl EventDispatcher {
    /// Create a new dispatcher with a channel of the given capacity.
    /// Returns `(dispatcher, receiver)`.
    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<TradingCoreEvent>) {
        let (tx, rx) = mpsc::channel(capacity);
        (
            EventDispatcher {
                tx,
                seq: Arc::new(Mutex::new(0)),
                ring: Arc::new(Mutex::new(VecDeque::with_capacity(RING_BUFFER_SIZE))),
            },
            rx,
        )
    }

    /// Emit an event. Assigns the next seq, writes to the ring buffer (always),
    /// then tries to forward to the channel with a 1s backpressure timeout.
    /// Drops the event (with a warn log) on timeout or closed receiver.
    pub async fn emit(&self, uta_id: &str, event_type: &str, payload_json: String) {
        let seq = {
            let mut s = self.seq.lock();
            *s = s.wrapping_add(1);
            *s
        };
        let event = TradingCoreEvent {
            uta_id: uta_id.to_string(),
            seq,
            timestamp_ms: chrono::Utc::now().timestamp_millis() as f64,
            event_type: event_type.to_string(),
            payload_json,
        };

        // Always push into ring buffer first (backfill source).
        {
            let mut ring = self.ring.lock();
            if ring.len() == RING_BUFFER_SIZE {
                ring.pop_front();
            }
            ring.push_back(event.clone());
        }

        // Forward to channel with 1s backpressure timeout.
        let send_fut = self.tx.send(event);
        match tokio::time::timeout(std::time::Duration::from_secs(1), send_fut).await {
            Ok(Ok(())) => {}
            Ok(Err(_closed)) => {
                tracing::warn!(
                    target: "napi",
                    uta = %uta_id,
                    seq,
                    event_type,
                    "event dropped — channel closed"
                );
            }
            Err(_elapsed) => {
                tracing::warn!(
                    target: "napi",
                    uta = %uta_id,
                    seq,
                    event_type,
                    "event dropped — channel full for 1s (backpressure)"
                );
            }
        }
    }

    /// Return all ring-buffered events with seq > after_seq.
    /// Used for TS-side gap backfill when a sequence jump is detected.
    pub fn recent_after(&self, after_seq: u32) -> Vec<TradingCoreEvent> {
        self.ring
            .lock()
            .iter()
            .filter(|e| e.seq > after_seq)
            .cloned()
            .collect()
    }
}

#[cfg(all(test, feature = "napi-binding"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dispatcher_assigns_monotonic_seq() {
        let (d, _rx) = EventDispatcher::new(16);
        d.emit("u1", "test", "{}".to_string()).await;
        d.emit("u1", "test", "{}".to_string()).await;
        let recent = d.recent_after(0);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].seq, 1);
        assert_eq!(recent[1].seq, 2);
    }

    #[tokio::test]
    async fn dispatcher_ring_buffer_caps_at_500() {
        let (d, _rx) = EventDispatcher::new(1024);
        for i in 0..520u32 {
            d.emit("u1", "test", format!("{}", i)).await;
        }
        let recent = d.recent_after(0);
        // Ring holds last 500 — events 21..520 (seq 21..=520).
        assert_eq!(recent.len(), 500);
        // First retained seq should be 21 (seq 1..=20 evicted).
        assert_eq!(recent[0].seq, 21);
        assert_eq!(recent[499].seq, 520);
    }

    #[tokio::test]
    async fn dispatcher_recent_after_filters_correctly() {
        let (d, _rx) = EventDispatcher::new(16);
        d.emit("u1", "test", "a".to_string()).await; // seq=1
        d.emit("u1", "test", "b".to_string()).await; // seq=2
        d.emit("u1", "test", "c".to_string()).await; // seq=3
        let recent = d.recent_after(1);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].seq, 2);
        assert_eq!(recent[1].seq, 3);
    }
}
