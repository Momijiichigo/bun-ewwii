use crate::{
    paths::EwwiiPaths, plugin::CustomConfigEngine,
    window::backend_window_options::BackendWindowOptionsDef,
};
use anyhow::{bail, Context, Result};
use ewwii_bunjs::{BunConfigEngine, WindowInstanceInfo};
use ewwii_shared_utils::ast::WidgetNode;
use ewwii_shared_utils::prop::{Callback, PropertyMap};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

#[derive(Clone)]
pub enum ConfigEngine {
    /// Built-in Bun/JavaScript engine. This is the default.
    Bun(BunConfigEngine),
    /// A configuration engine provided by a plugin.
    Custom(CustomConfigEngine),
}

impl ConfigEngine {
    pub fn extension(&self) -> String {
        match self {
            Self::Bun(_) => ewwii_bunjs::EXTENSION.to_string(),
            Self::Custom(c) => c.extension(),
        }
    }

    /// Path to the main configuration file for this engine.
    ///
    /// The Bun engine accepts either `ewwii.ts` or `ewwii.js` and prefers
    /// `ewwii.ts` when both exist.
    pub fn main_file_path(&self, config_dir: &Path) -> PathBuf {
        match self {
            Self::Bun(_) => ewwii_bunjs::resolve_main_file(config_dir),
            Self::Custom(c) => config_dir.join(c.main_file()),
        }
    }

    pub fn handle_callback(&self, callback: &Callback) {
        match self {
            Self::Bun(_) => {}
            Self::Custom(c) => c.handle_callback(callback),
        }
    }

    pub fn parse_source(
        &mut self,
        source: String,
        config_path: PathBuf,
    ) -> Result<WidgetNode, String> {
        match self {
            Self::Bun(engine) => {
                let path = config_path.to_string_lossy();
                engine.parse(&source, &path)
            }
            Self::Custom(c) => c.parse_source(source, config_path),
        }
    }

    pub fn notify_window_init(&self, info: &WindowInstanceInfo) {
        if let Self::Bun(engine) = self {
            engine.notify_window_init(info);
        }
    }

    pub fn notify_window_close(&self, instance_id: &str) {
        if let Self::Bun(engine) = self {
            engine.notify_window_close(instance_id);
        }
    }
}

// NOTE: These global variables are used for the proper functioning
// of bind function and for access to AST across the whole program.
thread_local! {
    pub static EWWII_CONFIG_PARSER: RefCell<Option<ConfigEngine>> = const { RefCell::new(None) };
}

/// Load an [`EwwiiConfig`] from the config dir of the given [`crate::EwwiiPaths`].
pub fn read_from_ewwii_paths(paths: &EwwiiPaths) -> Result<EwwiiConfig> {
    EwwiiConfig::read_from_dir(paths)
}

/// Notify the active configuration engine that a window instance was initialized.
pub fn notify_window_init(info: &WindowInstanceInfo) {
    EWWII_CONFIG_PARSER.with(|parser| {
        if let Ok(parser) = parser.try_borrow() {
            if let Some(parser) = parser.as_ref() {
                parser.notify_window_init(info);
            }
        }
    });
}

/// Notify the active configuration engine that a window instance was closed.
pub fn notify_window_close(instance_id: &str) {
    EWWII_CONFIG_PARSER.with(|parser| {
        if let Ok(parser) = parser.try_borrow() {
            if let Some(parser) = parser.as_ref() {
                parser.notify_window_close(instance_id);
            }
        }
    });
}

/// Ewwii configuration structure.
#[derive(Debug, Clone, Default)]
pub struct EwwiiConfig {
    windows: HashMap<String, WindowDefinition>,
    root_node: Option<Rc<WidgetNode>>,
}

#[derive(Debug, Clone)]
pub struct WindowDefinition {
    pub name: String,
    pub props: PropertyMap,
    pub backend_options: BackendWindowOptionsDef,
    pub root_widget: Rc<WidgetNode>,
}

impl EwwiiConfig {
    /// Load an [`EwwiiConfig`] from the config dir of the given [`crate::EwwiiPaths`], reading the main config file.
    pub fn read_from_dir(ewwii_paths: &EwwiiPaths) -> Result<Self> {
        EWWII_CONFIG_PARSER.with(|p| {
            let mut parser = p.borrow_mut();
            let config_parser = parser.as_mut().context("Config parser not initialized")?;

            let configlang_path = config_parser.main_file_path(ewwii_paths.get_config_dir());
            if !configlang_path.exists() {
                bail!(
                    "The configuration file `{}` does not exist",
                    configlang_path.display()
                );
            }

            let source = crate::paths::code_from_file(&configlang_path)?;

            let config_tree = config_parser
                .parse_source(source, configlang_path)
                .map_err(|e| anyhow::anyhow!(e))?;

            let mut window_definitions = HashMap::new();

            match config_tree.clone() {
                WidgetNode::Tree(children) => {
                    for node in children {
                        if let WidgetNode::DefWindow { name, props, node } = node {
                            let backend_options = BackendWindowOptionsDef::from_map(&props)?;
                            let win_def = WindowDefinition {
                                name,
                                props,
                                backend_options,
                                root_widget: Rc::new(*node),
                            };
                            window_definitions.insert(win_def.name.clone(), win_def);
                        }
                    }
                }
                _ => bail!("Expected root node to be `Enter`, but got something else."),
            }

            Ok(EwwiiConfig {
                windows: window_definitions,
                root_node: Some(Rc::new(config_tree)),
            })
        })
    }

    pub fn get_windows(&self) -> &HashMap<String, WindowDefinition> {
        &self.windows
    }

    pub fn get_window(&self, name: &str) -> Result<&WindowDefinition> {
        self.windows.get(name).with_context(|| {
            format!(
                "No window named '{}' exists in config.\nThis may also be caused by your config failing to load properly, \
                 please check for any other errors in that case.",
                name
            )
        })
    }

    pub fn get_root_node(&self) -> Result<Rc<WidgetNode>> {
        self.root_node
            .clone()
            .ok_or_else(|| anyhow::anyhow!("root_node is missing"))
    }

    pub fn replace_data(&mut self, new_dat: Self) {
        self.windows = new_dat.windows;
        self.root_node = new_dat.root_node;
    }
}
