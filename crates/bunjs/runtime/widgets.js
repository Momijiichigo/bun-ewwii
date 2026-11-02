// ewwii/widgets - widget tree builder for bun-ewwii.
//
// This module is installed into the Bun sidecar's NODE_PATH by the Rust plugin.
// It deliberately mirrors jscore.ewwii's API, with additions for live child
// manipulation. All runtime state lives in `globalThis.__BUN_EWWII__`, which is
// created by runtime.js.

function runtime() {
    const rt = globalThis.__BUN_EWWII__;
    if (!rt) {
        throw new Error(
            "ewwii/widgets was loaded outside of bun-ewwii or before the runtime was initialized",
        );
    }
    return rt;
}

function cloneNodeForInstance(widget, instanceId) {
    const clone = Object.create(Widget.prototype);
    clone.type = widget.type;
    clone.props = { ...widget.props };
    clone.children = widget.children.map((child) => cloneNodeForInstance(child, instanceId));
    clone.max_child = widget.max_child;
    clone.min_child = widget.min_child;
    clone.__mounted = true;
    clone.__onMount = widget.__onMount.map((entry) => ({
        callback: entry.callback,
        instances: new Set(),
    }));
    clone.__dynId = widget.__dynId;
    clone.__instanceId = instanceId;
    return clone;
}

function prepareChild(parent, child) {
    if (parent.__instanceId && child.__instanceId !== parent.__instanceId) {
        return cloneNodeForInstance(child, parent.__instanceId);
    }
    return child;
}

function sameNode(left, right) {
    return left === right || (left?.__dynId && left.__dynId === right?.__dynId);
}

function scheduleStructural(parent) {
    if (!parent.__mounted) {
        return;
    }
    if (parent.__instanceId) {
        runtime().scheduleInstanceStructural(parent.__instanceId, parent.props.widget_name);
    } else {
        runtime().scheduleSync();
    }
}

function markMounted(widget, mounted) {
    if (widget.__mounted === mounted) {
        return;
    }

    widget.__mounted = mounted;
    if (!mounted) {
        for (const entry of widget.__onMount ?? []) {
            entry.instances.clear();
        }
    }

    for (const child of widget.children) {
        markMounted(child, mounted);
    }
}

/**
 * A widget node used to construct an ewwii widget tree.
 *
 * Every widget automatically receives a stable `dyn_id` and a hidden
 * `widget_name` when it is created. The stable `dyn_id` gives the host a
 * reliable identity for every widget when the GTK tree is rebuilt.
 */
export class Widget {
    constructor(type, defaultProp = null, defaultPropName = null, maxChild = null, minChild = 0) {
        const rt = runtime();

        this.type = type;
        this.props = {};
        this.children = [];
        this.max_child = maxChild;
        this.min_child = minChild;
        this.__mounted = false;
        this.__onMount = [];
        this.__dynId = rt.newDynId();

        if (defaultProp !== null && defaultProp !== undefined && defaultPropName !== null) {
            this.props[defaultPropName] = defaultProp;
        }

        if (this.props.dyn_id === undefined || this.props.dyn_id === null) {
            this.props.dyn_id = this.__dynId;
        }

        if (this.props.widget_name === undefined || this.props.widget_name === null) {
            this.props.widget_name = `__bun_ewwii_${this.__dynId}`;
        }
    }

    /**
     * Assign multiple properties. On a mounted widget, ordinary properties are
     * forwarded as live updates; identity changes force a tree rebuild.
     *
     * @param {Record<string, unknown>} values
     */
    properties(values) {
        Object.assign(this.props, values);
        if (this.__mounted) {
            if ("dyn_id" in values || "widget_name" in values) {
                this.__markChanged();
            } else {
                for (const [key, value] of Object.entries(values)) {
                    runtime().setWidgetProperty(
                        this.props.widget_name,
                        key,
                        value,
                        this.__instanceId ?? null,
                    );
                }
            }
        }
        return this;
    }

    /**
     * Assign one property. On a mounted widget this is applied live unless the
     * property changes the widget's identity (`dyn_id`/`widget_name`).
     *
     * @param {string} key @param {unknown} value
     */
    set_property(key, value) {
        this.props[key] = value;
        if (this.__mounted) {
            if (key === "dyn_id" || key === "widget_name") {
                this.__markChanged();
            } else {
                runtime().setWidgetProperty(
                    this.props.widget_name,
                    key,
                    value,
                    this.__instanceId ?? null,
                );
            }
        }
        return this;
    }

    /**
     * Run several structural changes as one transaction.
     *
     * The callback is synchronous. Structural operations inside it are
     * coalesced, and mounted instances receive one host update per affected
     * container when the transaction ends.
     *
     * @param {(widget: Widget) => void} callback
     * @returns {this}
     */
    edit(callback) {
        if (typeof callback !== "function") {
            throw new TypeError("edit() expects a function");
        }

        const rt = runtime();
        rt.beginStructuralEdit();
        try {
            callback(this);
        } finally {
            rt.endStructuralEdit();
        }
        return this;
    }

    /** @param {Widget} child */
    add_child(child) {
        assertWidget(child, "add_child");
        if (this.max_child !== null && this.children.length >= this.max_child) {
            throw new Error(
                `Widget '${this.type}' can hold a maximum of ${this.max_child} child node(s).`,
            );
        }

        const actual = prepareChild(this, child);
        this.children.push(actual);
        if (this.__mounted) {
            markMounted(actual, true);
            scheduleStructural(this);
        }
        return this;
    }

    /**
     * Insert a child at a specific index.
     *
     * @param {number} index
     * @param {Widget} child
     */
    insert_child(index, child) {
        assertWidget(child, "insert_child");

        const existing = this.children.findIndex((candidate) => sameNode(candidate, child));
        if (existing !== -1) {
            this.children.splice(existing, 1);
        }

        if (this.max_child !== null && this.children.length >= this.max_child) {
            throw new Error(
                `Widget '${this.type}' can hold a maximum of ${this.max_child} child node(s).`,
            );
        }

        const actual = prepareChild(this, child);
        const numericIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
        const target = Math.max(0, Math.min(numericIndex, this.children.length));
        this.children.splice(target, 0, actual);

        if (this.__mounted) {
            markMounted(actual, true);
            scheduleStructural(this);
        }
        return this;
    }

    /**
     * Remove a child by widget instance or `widget_name`.
     *
     * @param {Widget | string} child
     */
    remove_child(child) {
        const index =
            typeof child === "string"
                ? this.children.findIndex((candidate) => candidate.props.widget_name === child)
                : this.children.findIndex((candidate) => sameNode(candidate, child));

        if (index === -1) {
            return this;
        }

        if (this.children.length - 1 < this.min_child) {
            throw new Error(
                `Widget '${this.type}' requires at least ${this.min_child} child node(s).`,
            );
        }

        const [removed] = this.children.splice(index, 1);
        markMounted(removed, false);
        scheduleStructural(this);
        return this;
    }

    /** @param {Widget[]} children */
    replace_children(children) {
        if (!Array.isArray(children)) {
            throw new TypeError("replace_children expects an array of widgets");
        }
        for (const child of children) {
            assertWidget(child, "replace_children");
        }
        if (children.length < this.min_child) {
            throw new Error(
                `Widget '${this.type}' requires at least ${this.min_child} child node(s).`,
            );
        }
        if (this.max_child !== null && children.length > this.max_child) {
            throw new Error(
                `Widget '${this.type}' can hold a maximum of ${this.max_child} child node(s).`,
            );
        }

        const prepared = children.map((child) => prepareChild(this, child));
        const newIds = new Set(prepared.map((child) => child.__dynId));
        for (const child of this.children) {
            if (!newIds.has(child.__dynId)) {
                markMounted(child, false);
            }
        }

        this.children = prepared;

        if (this.__mounted) {
            for (const child of this.children) {
                markMounted(child, true);
            }
            scheduleStructural(this);
        }
        return this;
    }

    clear_children() {
        if (this.min_child > 0) {
            throw new Error(
                `Widget '${this.type}' requires at least ${this.min_child} child node(s).`,
            );
        }
        for (const child of this.children) {
            markMounted(child, false);
        }
        this.children = [];
        scheduleStructural(this);
        return this;
    }

    /**
     * Run a callback when this widget is mounted/initialized by ewwii.
     *
     * The callback receives an instance-scoped `LiveWidgetHandle` and a context
     * object containing `instanceId`, `windowName`, `monitor`, `screen`,
     * `widgetName`, `dynId`, `window`, and `widget`. It fires after a window
     * instance has been initialized, so property updates are safe. It runs once
     * per widget per window instance.
     *
     * @param {(handle: LiveWidgetHandle, context: {
     *   instanceId: string,
     *   windowName: string,
     *   monitor: string | null,
     *   screen: number | null,
     *   widgetName: string,
     *   dynId: string,
     *   window: Widget | null,
     *   widget: Widget
     * }) => void} callback
     * @returns {this}
     */
    on_mount(callback) {
        if (typeof callback !== "function") {
            throw new TypeError("on_mount() expects a function");
        }

        this.__onMount.push({ callback, instances: new Set() });

        if (this.__mounted) {
            runtime().tryMountForWidget(this);
        }

        return this;
    }

    /**
     * Remove a previously registered `on_mount` callback.
     *
     * @param {(handle: LiveWidgetHandle, context: {
     *   instanceId: string,
     *   windowName: string,
     *   monitor: string | null,
     *   screen: number | null,
     *   widgetName: string,
     *   dynId: string,
     *   window: Widget | null,
     *   widget: Widget
     * }) => void} callback
     * @returns {this}
     */
    off_mount(callback) {
        this.__onMount = this.__onMount.filter((entry) => entry.callback !== callback);
        if (!this.__instanceId) {
            runtime().removeMountCallbackFromInstances(this, callback);
        }
        return this;
    }

    validate() {
        if (this.children.length < this.min_child) {
            throw new Error(
                `Widget '${this.type}' requires a minimum of ${this.min_child} child node(s), ` +
                    `but only has ${this.children.length}.`,
            );
        }
        if (this.max_child !== null && this.children.length > this.max_child) {
            throw new Error(
                `Widget '${this.type}' can hold a maximum of ${this.max_child} child node(s), ` +
                    `but has ${this.children.length}.`,
            );
        }

        for (const child of this.children) {
            assertWidget(child, "validate");
            child.validate();
        }
    }

    __markChanged() {
        scheduleStructural(this);
    }

    /**
     * Deep-clone this subtree for one concrete window instance.
     *
     * @param {string} instanceId
     * @returns {Widget}
     */
    cloneForInstance(instanceId) {
        return cloneNodeForInstance(this, instanceId);
    }

    toJSON() {
        const props = { ...this.props };

        if (props.dyn_id === undefined || props.dyn_id === null) {
            props.dyn_id = this.__dynId;
        }
        if (props.widget_name === undefined || props.widget_name === null) {
            props.widget_name = `__bun_ewwii_${this.__dynId}`;
        }

        /** @type {{ type: string, props: Record<string, unknown>, children?: unknown[] }} */
        const json = { type: this.type, props };

        if (this.children.length > 0) {
            json.children = this.children.map((child) => child.toJSON());
        }

        return json;
    }
}

function assertWidget(value, where) {
    if (!(value instanceof Widget)) {
        throw new TypeError(`${where}() expects a Widget instance`);
    }
}

// === Containers === //

export const Box = () => new Widget("Box");
export const FlowBox = () => new Widget("FlowBox");
export const Expander = () => new Widget("Expander", null, null, 1, 1);
export const Revealer = () => new Widget("Revealer", null, null, 1, 0);
export const Scroll = () => new Widget("Scroll", null, null, 1, 1);
export const OverLay = () => new Widget("OverLay", null, null, null, 1);
export const Stack = () => new Widget("Stack");
export const EventBox = () => new Widget("EventBox", null, null, 1, 1);
export const ToolTip = () => new Widget("ToolTip", null, null, 2, 2);
export const AspectFrame = () => new Widget("AspectFrame", null, null, 1, 1);
export const Animation = () => new Widget("Animation", null, null, 1, 1);

// === Leaf widgets === //

export const Label = (text) => new Widget("Label", text, "text", 0, 0);
export const Button = (text) => new Widget("Button", text, "text", 0, 0);
export const Image = (path) => new Widget("Image", path, "path", 0, 0);
export const Input = () => new Widget("Input", null, null, 0, 0);
export const Progress = () => new Widget("Progress", null, null, 0, 0);
export const ComboBoxText = () => new Widget("ComboBoxText", null, null, 0, 0);
export const Scale = () => new Widget("Scale", null, null, 0, 0);
export const Checkbox = () => new Widget("Checkbox", null, null, 0, 0);
export const Calendar = () => new Widget("Calendar", null, null, 0, 0);
export const ColorButton = () => new Widget("ColorButton", null, null, 0, 0);
export const ColorChooser = () => new Widget("ColorChooser", null, null, 0, 0);
export const CircularProgress = () => new Widget("CircularProgress", null, null, 0, 0);
export const Graph = () => new Widget("Graph", null, null, 0, 0);
export const Transform = () => new Widget("Transform", null, null, 0, 0);

// === Special widgets === //

export const GtkUI = () => new Widget("GtkUI", null, null, 0, 0);
export const Custom = (name) => new Widget("Custom", name, "name", 0, 0);
export const Script = () => new Widget("Script", null, null, 0, 0);
export const Poll = (variable) => new Widget("Poll", variable, "var", 0, 0);
export const Listen = (variable) => new Widget("Listen", variable, "var", 0, 0);

// === Top-level === //

export const Window = (name) => {
    if (!name) {
        throw new TypeError("Window requires a name.");
    }
    return new Widget("Window", name, "name", 1, 1);
};

/**
 * Register a window and return a live `WindowHandle`.
 *
 * The handle extends `LiveWidgetHandle` for the window's root child, so
 * `append_child()`, `clear_children()`, `set_property()`, etc. operate on the
 * window content.
 *
 * @param {Widget} widget
 */
export function register(widget) {
    if (!(widget instanceof Widget)) {
        throw new TypeError("register() requires a valid Widget instance.");
    }
    if (widget.type !== "Window") {
        throw new TypeError("Widget instance must be of type 'Window'.");
    }
    if (widget.children.length !== 1) {
        throw new TypeError("Window must have exactly one child assigned to it.");
    }

    widget.validate();
    return runtime().registerWindow(widget);
}

// Convenience re-export: `Widgets.variable(...)` works, and
// `import { variable } from "ewwii/reactive"` is the canonical form.
export { variable, ReactiveVariable } from "./reactive.js";
