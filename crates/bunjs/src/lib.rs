mod convert;
mod engine;

use ewwii_plugin_api::shared_utils::ast::WidgetNode;
use ewwii_plugin_api::EwwiiAPI;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Configuration extension served by the built-in Bun engine.
pub const EXTENSION: &str = "js";
/// Default JavaScript main configuration file.
pub const MAIN_FILE: &str = "ewwii.js";
/// TypeScript main configuration file supported by Bun out of the box.
pub const TYPESCRIPT_MAIN_FILE: &str = "ewwii.ts";
/// Main configuration files checked by the built-in engine, in priority order.
pub const MAIN_FILE_CANDIDATES: [&str; 2] = [TYPESCRIPT_MAIN_FILE, MAIN_FILE];

/// Resolve the main configuration file in `config_dir`.
///
/// TypeScript is checked first, so a directory that has only `ewwii.ts` works
/// without renaming it. Existing `ewwii.js` configurations continue to work.
pub fn resolve_main_file(config_dir: &Path) -> PathBuf {
    for candidate in MAIN_FILE_CANDIDATES {
        let path = config_dir.join(candidate);
        if path.is_file() {
            return path;
        }
    }
    config_dir.join(MAIN_FILE)
}

/// Information about a concrete window instance, sent to the JS sidecar when
/// ewwii initializes a window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInstanceInfo {
    pub instance_id: String,
    pub window_name: String,
    /// Monitor selector as provided on the command line (`0`, `eDP-1`, ...).
    pub monitor: Option<String>,
    /// Numeric monitor index when the selector is numeric.
    pub screen: Option<i32>,
}

/// The built-in Bun configuration engine.
#[derive(Clone)]
pub struct BunConfigEngine {
    runtime: Arc<engine::Runtime>,
}

impl BunConfigEngine {
    pub fn new(host: Arc<dyn EwwiiAPI>) -> Self {
        Self {
            runtime: Arc::new(engine::Runtime::new(host)),
        }
    }

    pub fn parse(&self, source: &str, path: &str) -> Result<WidgetNode, String> {
        self.runtime.parse(source, path)
    }

    pub fn notify_window_init(&self, info: &WindowInstanceInfo) {
        self.runtime.notify_window_init(info);
    }

    pub fn notify_window_close(&self, instance_id: &str) {
        self.runtime.notify_window_close(instance_id);
    }
}

/// Parse one window JSON object into a `WidgetNode` without a Bun runtime.
pub fn parse_window_json(json: &str) -> Result<WidgetNode, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|err| format!("Invalid window JSON: {err}"))?;
    convert::convert_window(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn resolves_typescript_entry_before_javascript() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("bun-ewwii-entry-{unique}"));
        let js_dir = root.join("js");
        let ts_dir = root.join("ts");
        let empty_dir = root.join("empty");
        fs::create_dir_all(&js_dir).unwrap();
        fs::create_dir_all(&ts_dir).unwrap();
        fs::create_dir_all(&empty_dir).unwrap();

        fs::write(js_dir.join(MAIN_FILE), "").unwrap();
        assert_eq!(resolve_main_file(&js_dir), js_dir.join(MAIN_FILE));

        fs::write(js_dir.join(TYPESCRIPT_MAIN_FILE), "").unwrap();
        assert_eq!(
            resolve_main_file(&js_dir),
            js_dir.join(TYPESCRIPT_MAIN_FILE)
        );

        fs::write(ts_dir.join(TYPESCRIPT_MAIN_FILE), "").unwrap();
        assert_eq!(
            resolve_main_file(&ts_dir),
            ts_dir.join(TYPESCRIPT_MAIN_FILE)
        );

        assert_eq!(resolve_main_file(&empty_dir), empty_dir.join(MAIN_FILE));

        fs::remove_dir_all(root).unwrap();
    }
}
