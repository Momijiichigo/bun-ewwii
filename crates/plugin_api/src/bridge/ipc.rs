use serde::{Deserialize, Serialize};

// === ipc access implementation  === //
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum IpcRequest {
    /// Control widgets
    WidgetControl(WidgetControlType),
    /// 1. Property
    /// 2. Value
    Update(String, String),
    Close(Vec<String>),
    /// 1. Name of window to open
    /// 2. Whether to toggle the window
    Open(String, bool),
    /// Reload config and css
    Reload,
    /// Hot reload config (currently mapped to a full reload by ewwii)
    HotReload,
    /// Close all windows
    CloseAll,
    /// Get path info of known files/dirs
    PathInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WidgetControlType {
    /// Perform an action on a widget
    Action(WidgetActionType),
    /// Remove a widget
    Remove {
        instance: Option<String>,
        widget: String,
    },
    /// Get the property of a widget
    PropertyGet {
        instance: Option<String>,
        widget: String,
        prop: String,
    },
    /// Set a property of a widget
    PropertyUpdate {
        instance: Option<String>,
        widget: String,
        prop: String,
        value: String,
    },
    /// Add a class to a widget
    AddClass {
        instance: Option<String>,
        widget: String,
        class: String,
    },
    /// Remove the class of a widget
    RemoveClass {
        instance: Option<String>,
        widget: String,
        class: String,
    },
    /// Replace the widget tree of one specific window instance.
    ReplaceTree { instance: String, tree: String },
    /// Replace the children of one widget in a specific window instance.
    ///
    /// `children` is a JSON array of widget nodes. The host updates the live
    /// GTK container without closing/reopening the window.
    ReplaceChildren {
        instance: String,
        widget: String,
        children: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WidgetActionType {
    /// Scroll a widget (must be ScrolledWindow)
    Scroll {
        instance: Option<String>,
        widget: String,
        value: f64,
    },
    /// Focus a widget
    Focus {
        instance: Option<String>,
        widget: String,
    },
}
