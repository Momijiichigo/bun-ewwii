/**
 * Type declarations for bun-ewwii.
 *
 * Put this file in your ewwii configuration directory (next to `ewwii.ts` or
 * `ewwii.js`) and make sure your `tsconfig.json` / `jsconfig.json` includes
 * `*.d.ts` files. Prefer the filename `bun-ewwii.d.ts`; naming it
 * `ewwii.d.ts` makes TypeScript treat it as the declaration file for
 * `ewwii.ts` and can hide these global/module declarations.
 *
 * Note: the global `Widget`, `WidgetAPI`, and `LiveWidgetHandle` declarations
 * below are intentionally global. They are injected by the Bun runtime, not by
 * an ES module import.
 */

/**
 * Bun's `import.meta` additions.
 *
 * `import.meta.dir` is useful for resolving assets next to a configuration
 * file without relying on `process.cwd()`.
 */
interface ImportMeta {
    /** Absolute path to the directory containing the current module. */
    readonly dir: string;

    /** Absolute path to the current module. */
    readonly path: string;
}

/**
 * A widget node used to construct an Ewwii widget tree.
 *
 * Every widget receives an auto-generated stable `dyn_id` and, unless you set
 * one, an auto-generated hidden `widget_name`.
 */
interface Widget {
    /** The widget type, such as `"Box"` or `"Label"`. */
    readonly type: string;

    /** Properties assigned to this widget. */
    readonly props: Record<string, unknown>;

    /** Child widgets contained by this widget. */
    readonly children: Widget[];

    /**
     * Assign multiple properties to the widget.
     *
     * @returns The same widget for method chaining.
     */
    properties(values: Record<string, unknown>): this;

    /**
     * Assign one property to the widget.
     *
     * @returns The same widget for method chaining.
     */
    set_property(key: string, value: unknown): this;

    /**
     * Add a child widget at the end.
     *
     * If the widget is already rendered, the GTK tree is synchronized after
     * the current microtask (currently via a full window rebuild).
     *
     * @returns The same widget for method chaining.
     */
    add_child(child: Widget): this;

    /**
     * Insert a child at a specific index.
     *
     * The GTK tree is synchronized after the current microtask.
     *
     * @returns The same widget for method chaining.
     */
    insert_child(index: number, child: Widget): this;

    /**
     * Remove a child by instance or by `widget_name`.
     *
     * @returns The same widget for method chaining.
     */
    remove_child(child: Widget | string): this;

    /**
     * Replace all children.
     *
     * @returns The same widget for method chaining.
     */
    replace_children(children: Widget[]): this;

    /**
     * Remove all children.
     *
     * @returns The same widget for method chaining.
     */
    clear_children(): this;

    /**
     * Run a callback when this widget is mounted/initialized by ewwii.
     *
     * The callback receives a live handle for this widget. Property updates in
     * the callback are safe because the window has already been built.
     *
     * @returns The same widget for method chaining.
     */
    on_mount(
        callback: (handle: LiveWidgetHandle, context: MountContext) => void,
    ): this;

    /**
     * Remove a previously registered `on_mount` callback.
     *
     * @returns The same widget for method chaining.
     */
    off_mount(
        callback: (handle: LiveWidgetHandle, context: MountContext) => void,
    ): this;

    /** Validate child-count constraints recursively. */
    validate(): void;

    /** Convert the widget tree into a serializable object. */
    toJSON(): {
        type: string;
        props: Record<string, unknown>;
        children?: Widget[];
    };
}

/**
 * Context passed to a `Widget.on_mount()` callback.
 *
 * `windowName` is the Ewwii window definition name (for example `"bar"`), not
 * the `--id` instance id used by `ewwii open ... --id bar_0`.
 */
interface MountContext {
    /** Concrete window instance id, e.g. `"bar_0"`. */
    instanceId: string;

    /** Ewwii window definition name, e.g. `"bar"`. */
    windowName: string;

    /** Monitor selector passed to `ewwii open` (`"0"`, `"eDP-1"`, ...). */
    monitor: string | null;

    /** Numeric monitor index when the selector is numeric. */
    screen: number | null;

    /** The `widget_name` of the mounted widget. */
    widgetName: string;

    /** Stable auto-generated widget identity. */
    dynId: string;

    /** The owning Window Widget, if one could be resolved. */
    window: Widget | null;

    /** The mounted widget itself. */
    widget: Widget;
}

/** Information about an initialized window instance. */
interface WindowInstanceInfo {
    instanceId: string;
    windowName: string;
    monitor: string | null;
    screen: number | null;
}

/**
 * A handle for modifying a widget after it has been rendered.
 *
 * Widgets are looked up by their `widget_name` property. When `instanceId` is
 * set, property/class and structural changes are scoped to that window instance.
 * With `null`, structural changes affect the shared window definition.
 */
declare class LiveWidgetHandle {
    constructor(widgetId: string, instanceId?: string | null);

    /** The `widget_name` of the associated widget. */
    readonly widgetId: string;

    /**
     * The window instance this handle targets, or `null` for an
     * instance-agnostic/definition-level handle.
     */
    readonly instanceId: string | null;

    /**
     * Set a widget property.
     *
     * @returns The same handle for method chaining.
     */
    set_property(key: string, value: unknown): this;

    /**
     * Add a CSS class.
     *
     * @returns The same handle for method chaining.
     */
    add_class(className: string): this;

    /**
     * Add multiple CSS classes.
     *
     * @returns The same handle for method chaining.
     */
    add_classes(...classNames: string[]): this;

    /**
     * Remove a CSS class.
     *
     * @returns The same handle for method chaining.
     */
    remove_class(className: string): this;

    /**
     * Remove multiple CSS classes.
     *
     * @returns The same handle for method chaining.
     */
    remove_classes(...classNames: string[]): this;

    /**
     * Append a child widget to this widget after it has been rendered.
     *
     * @returns The same handle for method chaining.
     */
    append_child(child: Widget): this;

    /**
     * Insert a child widget at a specific index after rendering.
     *
     * @returns The same handle for method chaining.
     */
    insert_child(index: number, child: Widget): this;

    /**
     * Remove a rendered child by widget instance or `widget_name`.
     *
     * @returns The same handle for method chaining.
     */
    remove_child(child: Widget | string): this;

    /**
     * Replace all rendered children.
     *
     * @returns The same handle for method chaining.
     */
    replace_children(children: Widget[]): this;

    /**
     * Remove all rendered children.
     *
     * @returns The same handle for method chaining.
     */
    clear_children(): this;

    /** The `widget_name`s of all direct children. */
    child_names(): string[];

    /** Handles for all direct children. */
    children(): LiveWidgetHandle[];
}

/**
 * Handle returned by `Widgets.register()`.
 *
 * It extends `LiveWidgetHandle` for the window's root child, so structural and
 * property methods operate on the window content. Use `.window` for the raw
 * Window widget object.
 */
declare class WindowHandle extends LiveWidgetHandle {
    constructor(widget: Widget);

    /** The registered Window widget. */
    readonly window: Widget;

    /** The window name. */
    readonly name: string;

    /** This same handle (the window's root widget). */
    readonly root: WindowHandle;

    /**
     * Handle for a specific window instance (the root widget).
     *
     * Structural, property, and class operations are scoped to that instance.
     */
    forInstance(instanceId: string): LiveWidgetHandle;

    /** Find a rendered widget by `widget_name`. */
    find(widgetId: string, instanceId?: string | null): LiveWidgetHandle;
}

/**
 * API available to `after_render`.
 */
declare class WidgetAPI {
    /**
     * Find a rendered widget by its `widget_name`.
     *
     * If `instanceId` is omitted, Ewwii resolves the widget if it exists in
     * exactly one open window. Pass an instance id when the same window is open
     * multiple times.
     */
    find(widgetId: string, instanceId?: string | null): LiveWidgetHandle;

    /** Currently initialized window instances. */
    instances(): WindowInstanceInfo[];
}

declare module "ewwii/widgets" {
    /** Create a generic vertical/horizontal container widget. */
    export function Box(): Widget;

    /** Create a flow container widget. */
    export function FlowBox(): Widget;

    /** Create a single-child expander widget. */
    export function Expander(): Widget;

    /** Create a single-child revealer widget. */
    export function Revealer(): Widget;

    /** Create a scroll widget. */
    export function Scroll(): Widget;

    /** Create an overlay widget. */
    export function OverLay(): Widget;

    /** Create a stack container widget. */
    export function Stack(): Widget;

    /** Create an event box widget. */
    export function EventBox(): Widget;

    /** Create a tooltip widget (exactly two children). */
    export function ToolTip(): Widget;

    /** Create an aspect-frame widget. */
    export function AspectFrame(): Widget;

    /** Create an animation wrapper widget. */
    export function Animation(): Widget;

    /**
     * Create a label widget.
     *
     * @param text Initial label text.
     */
    export function Label(text?: string): Widget;

    /**
     * Create a button widget.
     *
     * @param text Initial button text.
     */
    export function Button(text?: string): Widget;

    /**
     * Create an image widget.
     *
     * @param path Image path.
     */
    export function Image(path?: string): Widget;

    /** Create an input widget. */
    export function Input(): Widget;

    /** Create a progress widget. */
    export function Progress(): Widget;

    /** Create a combo-box text widget. */
    export function ComboBoxText(): Widget;

    /** Create a scale widget. */
    export function Scale(): Widget;

    /** Create a checkbox widget. */
    export function Checkbox(): Widget;

    /** Create a calendar widget. */
    export function Calendar(): Widget;

    /** Create a color-button widget. */
    export function ColorButton(): Widget;

    /** Create a color-chooser widget. */
    export function ColorChooser(): Widget;

    /** Create a circular-progress widget. */
    export function CircularProgress(): Widget;

    /** Create a graph widget. */
    export function Graph(): Widget;

    /** Create a transform widget. */
    export function Transform(): Widget;

    /** Create a GTK UI widget. */
    export function GtkUI(): Widget;

    /** Create a plugin/custom widget wrapper. */
    export function Custom(name: string): Widget;

    /** Create a script widget. */
    export function Script(): Widget;

    /** Create a poll widget. */
    export function Poll(variable: string): Widget;

    /** Create a listen widget. */
    export function Listen(variable: string): Widget;

    /**
     * Create a top-level window widget.
     *
     * @param name Window name.
     */
    export function Window(name: string): Widget;

    /**
     * Register a window widget tree with Ewwii.
     *
     * @param widget A widget created with `Window()`.
     * @returns A live handle scoped to the window's root widget.
     */
    export function register(widget: Widget): WindowHandle;

    /**
     * Create or get a reactive variable backed by ewwii's variable store.
     *
     * This is a convenience re-export of `variable` from `ewwii/reactive`.
     *
     * @param name Variable name, as used by `ewwii update name=value`.
     * @param initial Optional initial value. If omitted, an existing value is
     *   preserved.
     */
    export function variable(
        name: string,
        initial?: unknown,
    ): import("ewwii/reactive").ReactiveVariable;
}

declare module "ewwii/reactive" {
    /** Convert a JS value to ewwii's string variable representation. */
    export function toVariableString(value: unknown): string;

    /**
     * A reactive string variable synchronized with ewwii's variable store.
     *
     * `ewwii update name=value` and `.set()` both update the same value and
     * notify `on_change` listeners.
     */
    export class ReactiveVariable {
        constructor(name: string, initial?: unknown);

        /** Variable name. */
        readonly name: string;

        /** Current value. Assigning to this property calls `set()`. */
        value: string;

        /** Current value as a string. */
        get(): string;

        /** Update the value and broadcast it through ewwii. */
        set(value: unknown): this;

        /** Re-query the current value from ewwii's store. */
        refresh(): this;

        /** Run a listener whenever the value changes. */
        on_change(listener: (value: string) => void): () => void;

        /** Alias of `on_change`. */
        subscribe(listener: (value: string) => void): () => void;

        /** Event-style listener registration (`change`, `update`, or `value`). */
        on(
            event: "change" | "update" | "value",
            listener: (value: string) => void,
        ): () => void;

        /** Remove a listener. */
        off_change(listener: (value: string) => void): this;

        /** Run a listener once for the next change. */
        once_change(listener: (value: string) => void): () => void;

        /**
         * Keep a widget property in sync with this variable.
         *
         * @returns An unsubscribe function.
         */
        bind(
            handle: { set_property(key: string, value: unknown): unknown },
            property?: string,
        ): () => void;

        toString(): string;
        valueOf(): string;
    }

    /** Create (or get) a variable backed by ewwii's variable store. */
    export function variable(name: string, initial?: unknown): ReactiveVariable;
}

declare module "ewwii/tools" {
    /**
     * Context passed to a `stream.time` callback.
     */
    export interface TimeContext {
        /** Current date and time. */
        date: Date;

        /** Unix timestamp in milliseconds. */
        timestamp: number;

        /** Localized time string. */
        string: string;

        /** ISO 8601 date-time string. */
        iso: string;
    }

    /**
     * A running stream that can be stopped.
     */
    export interface StreamHandle {
        /** Stop the stream. */
        stop(): void;
    }

    /** File metadata returned by `fs.stat`. */
    export interface StatResult {
        size: number;
        isFile: boolean;
        isDir: boolean;
        created: number | null;
        modified: number | null;
        accessed: number | null;
        mode: number;
    }

    export namespace cmd {
        /**
         * Execute a shell command and discard its output.
         *
         * @param command Shell command to execute.
         */
        function run(command: string): Promise<void>;

        /**
         * Execute a shell command and return its stdout.
         *
         * @param command Shell command to execute.
         */
        function run_read(command: string): Promise<string>;

        /**
         * Listen to stdout lines produced by a long-running command.
         *
         * @param command Shell command to execute.
         * @param callback Called for each output line.
         */
        function listen(
            command: string,
            callback: (line: string) => void | Promise<void>,
        ): Promise<void>;
    }

    export namespace fs {
        /** Read a file as UTF-8 text. */
        function read(path: string): Promise<string>;

        /** Replace a file's contents. */
        function write(path: string, content: string): Promise<void>;

        /** Append text to a file. */
        function append(path: string, content: string): Promise<void>;

        /** Remove a file or directory (recursively). */
        function remove(path: string): Promise<void>;

        /** Check whether a path exists. */
        function exists(path: string): Promise<boolean>;

        /** Create a directory and its parents. */
        function mkdir(path: string): Promise<void>;

        /** Read directory entry names. */
        function readdir(path: string): Promise<string[]>;

        /** Read file or directory metadata. */
        function stat(path: string): Promise<StatResult>;

        /** Copy a file or directory (recursively). */
        function copy(source: string, destination: string): Promise<void>;

        /** Move/rename a file or directory. */
        function move(source: string, destination: string): Promise<void>;
    }

    export namespace stream {
        /**
         * Run a callback periodically.
         *
         * @param callback Callback invoked on every tick.
         * @param ms Interval in milliseconds. Defaults to `1000`.
         */
        function time(
            callback: (context: TimeContext) => void | Promise<void>,
            ms?: number,
        ): StreamHandle;

        /**
         * Listen for system-volume changes.
         *
         * @param callback Callback invoked with the current volume output.
         */
        function volume(
            callback: (volume: string) => void | Promise<void>,
        ): Promise<void>;
    }
}
