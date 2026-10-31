use ewwii_shared_utils::ast::WidgetNode;
use std::sync::Arc;

// === register_config implementation === //
pub struct ConfigInfo {
    pub extension: &'static str,
    pub main_file: &'static str,
}

pub type ParseFn = Arc<dyn Fn(&str, &str) -> Result<WidgetNode, String> + Send + Sync>;

pub trait ParseFnExt {
    fn new<F>(f: F) -> Self
    where
        F: Fn(&str, &str) -> Result<WidgetNode, String> + Send + Sync + 'static;
}

impl ParseFnExt for ParseFn {
    fn new<F>(f: F) -> Self
    where
        F: Fn(&str, &str) -> Result<WidgetNode, String> + Send + Sync + 'static,
    {
        Arc::new(f)
    }
}
