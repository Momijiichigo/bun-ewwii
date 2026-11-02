//! Hosts a Bun sidecar process and bridges it to ewwii.
//!
//! ewwii plugins are shared libraries loaded into the ewwii process, while Bun
//! cannot currently be embedded as a library. The pragmatic architecture is:
//!
//! ```text
//! ewwii (Rust/GTK)  <-- FFI plugin API -->  libbun_ewwii.so
//!                                             |
//!                                       stdin/stdout NDJSON
//!                                             |
//!                                         bun runtime
//! ```
//!
//! The sidecar owns the user's JS module and the live widget tree. ewwii owns
//! the GTK widgets. Property/class updates are forwarded as normal ewwii IPC
//! requests. Instance-scoped structural changes (adding/removing children) are
//! applied to the sidecar's tree and sent to the host as a `replace_children`
//! operation, which updates the live GTK container without rebuilding the
//! window.
//!
//! Definition-level structural changes still mutate the shared widget
//! definition and trigger a full configuration reload, because they can affect
//! every open instance.

use crate::convert;
use ewwii_plugin_api::shared_utils::ast::WidgetNode;
use ewwii_plugin_api::{
    EwwiiAPI, IpcRequest, ListenHandleFn, ListenHandleFnExt, SignalUpdateFn, SignalUpdateFnExt,
    WidgetControlType,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, Weak};
use std::time::Duration;

const RUNTIME_JS: &str = include_str!("../runtime/runtime.js");
const WIDGETS_JS: &str = include_str!("../runtime/widgets.js");
const TOOLS_JS: &str = include_str!("../runtime/tools.js");
const REACTIVE_JS: &str = include_str!("../runtime/reactive.js");
const PACKAGE_JSON: &str = include_str!("../runtime/ewwii-package.json");

const PARSE_TIMEOUT: Duration = Duration::from_secs(120);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a requested reload may take before its pending snapshot is treated
/// as stale (for example if the host failed before calling the parser).
const RELOAD_PENDING_TTL_MS: u64 = 15_000;

pub struct Runtime {
    host: Arc<dyn EwwiiAPI>,
    current: Mutex<Option<Arc<Bridge>>>,
    signals: Arc<SignalState>,
    gate: Arc<ParseGate>,
    updates: Arc<LiveUpdates>,
}

impl Runtime {
    pub fn new(host: Arc<dyn EwwiiAPI>) -> Self {
        let gate = Arc::new(ParseGate::default());
        let signals = SignalState::start(host.clone(), gate.clone());
        let updates = Arc::new(LiveUpdates::default());

        // Property/class updates sent before the first window is built would
        // make ewwii log "Widget registry is empty". Hold them until a window
        // has been initialized, then flush them.
        let listener_updates = updates.clone();
        let listener_signals = signals.clone();
        let listener_host = host.clone();
        host.listen(
            "ewwii-init-window",
            ListenHandleFn::new(move |_| {
                // ewwii clears its variable store/watchers when the last window
                // closes. Re-subscribe whenever a window is initialized and let
                // the newest subscription generation win.
                listener_signals.enqueue(SignalOp::Resubscribe);
                listener_updates.mark_ready(&listener_host);
            }),
        );

        Self {
            host,
            current: Mutex::new(None),
            signals,
            gate,
            updates,
        }
    }

    /// Called by ewwii whenever the configuration needs to be parsed.
    pub fn parse(&self, _source: &str, path: &str) -> Result<WidgetNode, String> {
        // ewwii holds the plugin callback mutex while this function runs.
        // Registering callback handlers (on_signal_update/signal_value) from
        // another thread during this window deadlocks. Signal ops are queued
        // and wait for the gate to open.
        self.gate.enter();
        let _parse_guard = ParseGateGuard(&self.gate);

        let entry = canonical_entry(path);
        let mut guard = self
            .current
            .lock()
            .map_err(|_| "bun-ewwii runtime mutex was poisoned".to_string())?;

        if let Some(bridge) = guard.as_ref() {
            // A structural change was applied to the sidecar tree and the host
            // is now asking us to parse again. Return the live snapshot instead
            // of restarting the JS runtime (which would lose user state).
            let pending = bridge.shared.reload_pending.load(Ordering::SeqCst);
            let requested_at = bridge.shared.last_reload_request_ms.load(Ordering::SeqCst);
            let now = now_ms();
            if pending > 0 && now.saturating_sub(requested_at) <= RELOAD_PENDING_TTL_MS {
                bridge.shared.reload_pending.fetch_sub(1, Ordering::SeqCst);
                match bridge.snapshot() {
                    Ok(snapshot) => {
                        return convert::convert_tree(snapshot.get("tree").unwrap_or(&Value::Null));
                    }
                    Err(err) => {
                        self.host.warn(&format!(
                            "bun-ewwii: live snapshot failed ({err}); restarting"
                        ));
                    }
                }
            } else if pending > 0 {
                // The reload never reached the parser. Do not let a stale count
                // turn a later user-initiated reload into a snapshot.
                bridge.shared.reload_pending.store(0, Ordering::SeqCst);
            }

            self.signals.bus.set_current(None);
            bridge.close();
            *guard = None;
            // A new sidecar means a potentially different widget tree. Do not
            // replay updates aimed at the previous configuration.
            self.updates.reset();
        }

        let (initial_tx, initial_rx) = mpsc::channel();
        let bridge = Arc::new(Bridge::spawn(
            self.host.clone(),
            &entry,
            initial_tx,
            self.signals.clone(),
            self.updates.clone(),
        )?);

        // The user's module can update signals while it is still evaluating.
        // Point the signal bus at this bridge before waiting for `parsed`.
        self.signals.bus.set_current(Some(bridge.shared.clone()));

        let parsed = match initial_rx.recv_timeout(PARSE_TIMEOUT) {
            Ok(value) => value,
            Err(err) => {
                self.signals.bus.set_current(None);
                self.updates.reset();
                bridge.close();
                return Err(format!(
                    "bun-ewwii: timed out waiting for the Bun runtime ({}): {err}",
                    entry.display()
                ));
            }
        };

        if parsed.get("type").and_then(Value::as_str) == Some("fatal") {
            let message = parsed
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown Bun startup error")
                .to_string();
            self.signals.bus.set_current(None);
            self.updates.reset();
            bridge.close();
            return Err(format!("bun-ewwii: {message}"));
        }

        let tree = match convert::convert_tree(parsed.get("tree").unwrap_or(&Value::Null)) {
            Ok(tree) => tree,
            Err(err) => {
                self.signals.bus.set_current(None);
                self.updates.reset();
                bridge.close();
                return Err(err);
            }
        };

        // After the parse callback returns, ewwii will build/open the windows.
        // Sending `run_after_render` immediately is fine because plugin IPC
        // requests are queued and processed after the current daemon command.
        // The tiny delay just keeps the common case race-free.
        let after_render_bridge = bridge.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            if let Err(err) = after_render_bridge.notify_after_render() {
                eprintln!("bun-ewwii: failed to trigger after_render: {err}");
            }
        });

        *guard = Some(bridge);
        Ok(tree)
    }

    pub(crate) fn notify_window_init(&self, info: &crate::WindowInstanceInfo) {
        self.signals
            .bus
            .send(&json!({ "type": "window_ready", "instance": info }));
    }

    pub(crate) fn notify_window_close(&self, instance_id: &str) {
        self.signals
            .bus
            .send(&json!({ "type": "window_close", "instanceId": instance_id }));
    }
}

fn canonical_entry(path: &str) -> PathBuf {
    Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
}

#[derive(Default)]
struct SignalBus {
    /// Weak to avoid a reference cycle: `Shared -> SignalState -> SignalBus
    /// -> Shared`.
    current: Mutex<Option<Weak<Shared>>>,
}

impl SignalBus {
    fn set_current(&self, shared: Option<Arc<Shared>>) {
        let mut current = self.current.lock().unwrap();
        *current = shared.map(|shared| Arc::downgrade(&shared));
    }

    fn send(&self, message: &Value) {
        let shared = self
            .current
            .lock()
            .ok()
            .and_then(|current| current.as_ref().and_then(Weak::upgrade));

        if let Some(shared) = shared {
            let _ = write_shared(&shared, message);
        }
    }

    fn publish(&self, name: &str, value: &str) {
        self.send(&json!({ "type": "signal", "name": name, "value": value }));
    }
}

/// ewwii calls the config parse callback while holding its plugin callback
/// mutex. Callback registration (`on_signal_update`, `signal_value`) must not
/// happen during that window. This gate lets a worker thread wait until the
/// parse callback has returned.
#[derive(Default)]
struct ParseGate {
    active: Mutex<bool>,
    condvar: Condvar,
}

impl ParseGate {
    fn enter(&self) {
        *self.active.lock().unwrap() = true;
    }

    fn leave(&self) {
        *self.active.lock().unwrap() = false;
        self.condvar.notify_all();
    }

    fn wait_idle(&self) {
        let mut active = self.active.lock().unwrap();
        while *active {
            active = self.condvar.wait(active).unwrap();
        }
    }
}

struct ParseGateGuard<'a>(&'a ParseGate);

impl Drop for ParseGateGuard<'_> {
    fn drop(&mut self) {
        self.0.leave();
    }
}

enum SignalOp {
    Register {
        name: String,
        initial: Option<String>,
    },
    Set {
        name: String,
        value: String,
    },
    Query {
        name: String,
    },
    Resubscribe,
}

struct SignalState {
    /// Signals are registered/subscribed once per plugin process. Keeping this
    /// across sidecar restarts avoids leaking an `on_signal_update` task every
    /// time the user's configuration is reloaded.
    registered: Mutex<HashSet<String>>,
    bus: Arc<SignalBus>,
    tx: Mutex<mpsc::Sender<SignalOp>>,
    /// Incremented when subscriptions are refreshed. Callbacks from older
    /// generations become no-ops.
    generation: Arc<AtomicU64>,
}

impl SignalState {
    fn start(host: Arc<dyn EwwiiAPI>, gate: Arc<ParseGate>) -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<SignalOp>();
        let state = Arc::new(Self {
            registered: Mutex::new(HashSet::new()),
            bus: Arc::new(SignalBus::default()),
            tx: Mutex::new(tx),
            generation: Arc::new(AtomicU64::new(0)),
        });

        let worker_state = state.clone();
        std::thread::Builder::new()
            .name("bun-ewwii-signals".to_string())
            .spawn(move || {
                for op in rx {
                    // Wait until the host is no longer inside the parse
                    // callback before touching callback-registration APIs.
                    gate.wait_idle();
                    worker_state.process(&host, op);
                }
            })
            .expect("failed to spawn bun-ewwii signal worker");

        state
    }

    fn enqueue(&self, op: SignalOp) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(op);
        }
    }

    fn process(&self, host: &Arc<dyn EwwiiAPI>, op: SignalOp) {
        match op {
            SignalOp::Register { name, initial } => {
                let first = self
                    .registered
                    .lock()
                    .map(|mut registered| registered.insert(name.clone()))
                    .unwrap_or(false);

                if first {
                    if let Some(initial) = initial {
                        host.register_signal(&name, initial);
                    }

                    self.subscribe(host, &name);
                }

                // Send the current value to the (possibly new) sidecar. This
                // also covers values set with `ewwii update` before load.
                self.query_value(host, &name);
            }
            SignalOp::Set { name, value } => {
                host.update_signal(&name, value);
            }
            SignalOp::Query { name } => {
                self.query_value(host, &name);
            }
            SignalOp::Resubscribe => {
                self.generation.fetch_add(1, Ordering::SeqCst);
                let names: Vec<String> = self
                    .registered
                    .lock()
                    .map(|registered| registered.iter().cloned().collect())
                    .unwrap_or_default();

                for name in names {
                    self.subscribe(host, &name);
                    self.query_value(host, &name);
                }
            }
        }
    }

    fn subscribe(&self, host: &Arc<dyn EwwiiAPI>, name: &str) {
        let bus = self.bus.clone();
        let generation = self.generation.clone();
        let current_generation = generation.load(Ordering::SeqCst);
        let signal_name = name.to_string();

        host.on_signal_update(
            name,
            SignalUpdateFn::new(move |value| {
                if generation.load(Ordering::SeqCst) == current_generation {
                    bus.publish(&signal_name, value);
                }
            }),
        );
    }

    fn query_value(&self, host: &Arc<dyn EwwiiAPI>, name: &str) {
        let bus = self.bus.clone();
        let signal_name = name.to_string();
        host.signal_value(name).resolve_async(move |result| {
            if let Ok(value) = result {
                bus.publish(&signal_name, &value);
            }
        });
    }
}

#[derive(Default)]
struct LiveUpdates {
    ready: AtomicBool,
    queue: Mutex<Vec<WidgetControlType>>,
}

impl LiveUpdates {
    fn submit(&self, host: Arc<dyn EwwiiAPI>, control: WidgetControlType) {
        if self.ready.load(Ordering::SeqCst) {
            ipc(host, control);
            return;
        }

        let Ok(mut queue) = self.queue.lock() else {
            return;
        };

        // Coalesce repeated property updates for the same widget/property.
        if let WidgetControlType::PropertyUpdate { widget, prop, .. } = &control {
            queue.retain(|existing| {
                !matches!(
                    existing,
                    WidgetControlType::PropertyUpdate {
                        widget: queued_widget,
                        prop: queued_prop,
                        ..
                    } if queued_widget == widget && queued_prop == prop
                )
            });
        }

        queue.push(control);
        if queue.len() > 4096 {
            queue.remove(0);
        }
    }

    fn reset(&self) {
        self.ready.store(false, Ordering::SeqCst);
        if let Ok(mut queue) = self.queue.lock() {
            queue.clear();
        }
    }

    fn mark_ready(&self, host: &Arc<dyn EwwiiAPI>) {
        if self.ready.swap(true, Ordering::SeqCst) {
            return;
        }

        let queued = std::mem::take(&mut *self.queue.lock().unwrap());
        if queued.is_empty() {
            return;
        }

        let host = host.clone();
        std::thread::spawn(move || {
            for control in queued {
                send_ipc(&host, control);
            }
        });
    }
}

struct Shared {
    host: Arc<dyn EwwiiAPI>,
    stdin: Mutex<ChildStdin>,
    routes: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    initial: Mutex<Option<mpsc::Sender<Value>>>,
    signals: Arc<SignalState>,
    updates: Arc<LiveUpdates>,
    /// Number of pending host reloads whose parse callback should return a
    /// snapshot from the running sidecar instead of starting a new one.
    reload_pending: AtomicUsize,
    last_reload_request_ms: AtomicU64,
}

struct Bridge {
    shared: Arc<Shared>,
    child: Mutex<Child>,
    next_id: AtomicU64,
}

impl Bridge {
    fn spawn(
        host: Arc<dyn EwwiiAPI>,
        entry: &Path,
        initial_tx: mpsc::Sender<Value>,
        signals: Arc<SignalState>,
        updates: Arc<LiveUpdates>,
    ) -> Result<Self, String> {
        let runtime_dir = install_runtime_files()?;
        let bun = find_bun()?;
        let runtime_file = runtime_dir.join("runtime.js");
        let node_modules = runtime_dir.join("node_modules");
        let config_dir = entry.parent().unwrap_or_else(|| Path::new("."));

        let mut command = Command::new(&bun);
        command
            .arg("--no-orphans")
            .arg(&runtime_file)
            .current_dir(config_dir)
            .env("BUN_EWWII_ENTRY", entry)
            .env("BUN_EWWII_CONFIG_DIR", config_dir)
            .env("BUN_EWWII_RUNTIME_DIR", &runtime_dir)
            .env("NODE_PATH", &node_modules)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = command
            .spawn()
            .map_err(|err| format!("bun-ewwii: failed to start '{}': {err}", bun.display()))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "bun-ewwii: Bun process has no stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "bun-ewwii: Bun process has no stdout".to_string())?;

        let shared = Arc::new(Shared {
            host,
            stdin: Mutex::new(stdin),
            routes: Mutex::new(HashMap::new()),
            initial: Mutex::new(Some(initial_tx)),
            signals,
            updates,
            reload_pending: AtomicUsize::new(0),
            last_reload_request_ms: AtomicU64::new(0),
        });

        let reader_shared = shared.clone();
        std::thread::Builder::new()
            .name("bun-ewwii-reader".to_string())
            .spawn(move || reader_loop(reader_shared, stdout))
            .map_err(|err| format!("bun-ewwii: failed to spawn reader thread: {err}"))?;

        Ok(Self {
            shared,
            child: Mutex::new(child),
            next_id: AtomicU64::new(1),
        })
    }

    fn write(&self, message: &Value) -> Result<(), String> {
        write_shared(&self.shared, message)
    }

    fn notify_after_render(&self) -> Result<(), String> {
        self.write(&json!({ "type": "run_after_render" }))
    }

    fn snapshot(&self) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();

        {
            let mut routes = self
                .shared
                .routes
                .lock()
                .map_err(|_| "bridge routes mutex poisoned".to_string())?;
            routes.insert(id, tx);
        }

        if let Err(err) = self.write(&json!({ "type": "snapshot", "id": id })) {
            if let Ok(mut routes) = self.shared.routes.lock() {
                routes.remove(&id);
            }
            return Err(err);
        }

        let response = rx.recv_timeout(SNAPSHOT_TIMEOUT);
        if let Ok(mut routes) = self.shared.routes.lock() {
            routes.remove(&id);
        }

        let response = response.map_err(|err| format!("snapshot request timed out: {err}"))?;
        if response.get("type").and_then(Value::as_str) == Some("fatal") {
            return Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Bun runtime exited")
                .to_string());
        }

        Ok(response)
    }

    fn close(&self) {
        let mut child = match self.child.lock() {
            Ok(child) => child,
            Err(_) => return,
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.close();
    }
}

fn write_shared(shared: &Shared, message: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(message)
        .map_err(|err| format!("failed to serialize bridge message: {err}"))?;
    line.push('\n');

    let mut stdin = shared
        .stdin
        .lock()
        .map_err(|_| "bridge stdin mutex poisoned".to_string())?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|err| format!("failed to write to Bun process: {err}"))
}

fn reader_loop(shared: Arc<Shared>, stdout: std::process::ChildStdout) {
    let reader = BufReader::new(stdout);

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }

        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(err) => {
                eprintln!("bun-ewwii: invalid message from Bun runtime: {err}: {line}");
                continue;
            }
        };

        match message.get("type").and_then(Value::as_str) {
            Some("parsed") => {
                if let Ok(mut initial) = shared.initial.lock() {
                    if let Some(tx) = initial.take() {
                        let _ = tx.send(message);
                    }
                }
            }
            Some("snapshot_result") => {
                let id = message.get("id").and_then(Value::as_u64);
                if let Some(id) = id {
                    if let Ok(mut routes) = shared.routes.lock() {
                        if let Some(tx) = routes.remove(&id) {
                            let _ = tx.send(message);
                        }
                    }
                }
            }
            Some("op") => handle_op(&shared, &message),
            Some("log") => log(&shared.host, message.get("message")),
            Some("warn") => {
                let msg = message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("(empty warning)");
                shared.host.warn(&format!("[bun-ewwii] {msg}"));
            }
            Some("error") | Some("fatal") => {
                let msg = message
                    .get("error")
                    .or_else(|| message.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("(empty error)");
                shared.host.error(&format!("[bun-ewwii] {msg}"));
            }
            Some(other) => {
                eprintln!("bun-ewwii: ignoring unknown message type '{other}'");
            }
            None => {}
        }
    }

    // The child exited. Wake up anyone waiting on it.
    let fatal = json!({
        "type": "fatal",
        "error": "Bun runtime exited unexpectedly"
    });
    if let Ok(mut initial) = shared.initial.lock() {
        if let Some(tx) = initial.take() {
            let _ = tx.send(fatal.clone());
        }
    }
    if let Ok(mut routes) = shared.routes.lock() {
        for (_, tx) in routes.drain() {
            let _ = tx.send(fatal.clone());
        }
    }
}

fn log(host: &Arc<dyn EwwiiAPI>, message: Option<&Value>) {
    let msg = message.and_then(Value::as_str).unwrap_or("");
    host.log(&format!("[bun-ewwii] {msg}"));
}

fn handle_op(shared: &Arc<Shared>, message: &Value) {
    let op = message.get("op").and_then(Value::as_str).unwrap_or("");

    match op {
        "register_variable" => {
            let name = message.get("name").and_then(Value::as_str).unwrap_or("");
            if name.is_empty() {
                eprintln!("bun-ewwii: variable registration is missing a name");
                return;
            }

            let initial = message
                .get("initial")
                .and_then(Value::as_str)
                .map(str::to_owned);

            shared.signals.enqueue(SignalOp::Register {
                name: name.to_string(),
                initial,
            });
        }
        "set_variable" => {
            let name = message.get("name").and_then(Value::as_str).unwrap_or("");
            if name.is_empty() {
                eprintln!("bun-ewwii: variable update is missing a name");
                return;
            }

            let value = prop_string(message.get("value").unwrap_or(&Value::Null));
            shared.signals.enqueue(SignalOp::Set {
                name: name.to_string(),
                value,
            });
        }
        "query_variable" => {
            let name = message.get("name").and_then(Value::as_str).unwrap_or("");
            if !name.is_empty() {
                shared.signals.enqueue(SignalOp::Query {
                    name: name.to_string(),
                });
            }
        }
        "set_property" => {
            let instance = instance_of(message);
            let widget = message.get("widget").and_then(Value::as_str).unwrap_or("");
            let key = message.get("key").and_then(Value::as_str).unwrap_or("");
            let value = prop_string(message.get("value").unwrap_or(&Value::Null));

            shared.updates.submit(
                shared.host.clone(),
                WidgetControlType::PropertyUpdate {
                    instance,
                    widget: widget.to_string(),
                    prop: key.to_string(),
                    value,
                },
            );
        }
        "add_class" => {
            let instance = instance_of(message);
            let widget = message.get("widget").and_then(Value::as_str).unwrap_or("");
            let class = message.get("class").and_then(Value::as_str).unwrap_or("");
            shared.updates.submit(
                shared.host.clone(),
                WidgetControlType::AddClass {
                    instance,
                    widget: widget.to_string(),
                    class: class.to_string(),
                },
            );
        }
        "remove_class" => {
            let instance = instance_of(message);
            let widget = message.get("widget").and_then(Value::as_str).unwrap_or("");
            let class = message.get("class").and_then(Value::as_str).unwrap_or("");
            shared.updates.submit(
                shared.host.clone(),
                WidgetControlType::RemoveClass {
                    instance,
                    widget: widget.to_string(),
                    class: class.to_string(),
                },
            );
        }
        "replace_tree" => {
            let instance = message
                .get("instance")
                .and_then(Value::as_str)
                .unwrap_or("");
            if instance.is_empty() {
                eprintln!("bun-ewwii: replace_tree is missing an instance id");
                return;
            }

            let tree = message.get("tree").unwrap_or(&Value::Null);
            let tree_json = match serde_json::to_string(tree) {
                Ok(json) => json,
                Err(err) => {
                    eprintln!("bun-ewwii: failed to serialize instance tree: {err}");
                    return;
                }
            };

            ipc(
                shared.host.clone(),
                WidgetControlType::ReplaceTree {
                    instance: instance.to_string(),
                    tree: tree_json,
                },
            );
        }
        "replace_children" => {
            let instance = message
                .get("instance")
                .and_then(Value::as_str)
                .unwrap_or("");
            let widget = message.get("widget").and_then(Value::as_str).unwrap_or("");
            if instance.is_empty() || widget.is_empty() {
                eprintln!("bun-ewwii: replace_children is missing an instance or widget name");
                return;
            }

            let children = message.get("children").unwrap_or(&Value::Null);
            let children_json = match serde_json::to_string(children) {
                Ok(json) => json,
                Err(err) => {
                    eprintln!("bun-ewwii: failed to serialize widget children: {err}");
                    return;
                }
            };

            ipc(
                shared.host.clone(),
                WidgetControlType::ReplaceChildren {
                    instance: instance.to_string(),
                    widget: widget.to_string(),
                    children: children_json,
                },
            );
        }
        "refresh" | "reload" => {
            // The next parse callback must return a snapshot from this sidecar,
            // not a freshly started one.
            shared.reload_pending.fetch_add(1, Ordering::SeqCst);
            shared
                .last_reload_request_ms
                .store(now_ms(), Ordering::SeqCst);

            let host = shared.host.clone();

            // Keep the reader thread free: the host handles this request on its
            // main thread and re-enters our parse callback, which needs us to
            // keep reading snapshot responses from Bun.
            std::thread::spawn(move || {
                let _ = host.ipc_request(IpcRequest::Reload);
            });
        }
        other => {
            eprintln!("bun-ewwii: unknown widget operation '{other}'");
        }
    }
}

fn send_ipc(host: &Arc<dyn EwwiiAPI>, control: WidgetControlType) {
    let _ = host.ipc_request(IpcRequest::WidgetControl(control));
}

fn ipc(host: Arc<dyn EwwiiAPI>, control: WidgetControlType) {
    std::thread::spawn(move || {
        send_ipc(&host, control);
    });
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn instance_of(message: &Value) -> Option<String> {
    message
        .get("instance")
        .and_then(Value::as_str)
        .filter(|instance| !instance.is_empty())
        .map(str::to_owned)
}

fn prop_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn find_bun() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("BUN_EWWII_BUN") {
        return Ok(PathBuf::from(path));
    }

    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("bun");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err("bun-ewwii: could not find `bun` in PATH (set BUN_EWWII_BUN to override)".to_string())
}

fn cache_root() -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);

    base.join("bun-ewwii").join(env!("CARGO_PKG_VERSION"))
}

fn write_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == contents {
            return Ok(());
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    }

    std::fs::write(path, contents)
        .map_err(|err| format!("failed to write {}: {err}", path.display()))
}

fn install_runtime_files() -> Result<PathBuf, String> {
    let root = cache_root();
    let ewwii_module = root.join("node_modules").join("ewwii");

    write_if_changed(&root.join("runtime.js"), RUNTIME_JS)?;
    write_if_changed(&ewwii_module.join("package.json"), PACKAGE_JSON)?;
    write_if_changed(&ewwii_module.join("widgets.js"), WIDGETS_JS)?;
    write_if_changed(&ewwii_module.join("tools.js"), TOOLS_JS)?;
    write_if_changed(&ewwii_module.join("reactive.js"), REACTIVE_JS)?;

    Ok(root)
}
