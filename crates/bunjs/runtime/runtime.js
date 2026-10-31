// bun-ewwii runtime bootstrap.
//
// The Rust plugin writes this file (plus the `ewwii` virtual package) into a
// cache directory, then starts `bun <this file>`. Communication with the plugin
// happens over newline-delimited JSON on stdin/stdout. User console output is
// forwarded as log messages so it never corrupts the protocol.

import { inspect } from "node:util";
import { pathToFileURL } from "node:url";
import { Widget } from "ewwii/widgets";

/** @param {unknown} message */
function send(message) {
    process.stdout.write(JSON.stringify(message) + "\n");
}

/** @param {unknown} value */
function format(value) {
    if (typeof value === "string") {
        return value;
    }
    return inspect(value, { depth: 4, colors: false, compact: true });
}

/** @param {unknown} error */
function formatError(error) {
    if (error instanceof Error) {
        return error.stack || error.message;
    }
    return String(error);
}

// Keep stdout clean for the bridge protocol.
for (const [method, level] of [
    ["log", "log"],
    ["info", "log"],
    ["debug", "log"],
    ["warn", "warn"],
    ["error", "error"],
]) {
    console[method] = (...args) => {
        send({ type: level, message: args.map(format).join(" ") });
    };
}

process.on("uncaughtException", (error) => {
    send({ type: "error", error: `Uncaught exception: ${formatError(error)}` });
});
process.on("unhandledRejection", (reason) => {
    send({ type: "error", error: `Unhandled rejection: ${formatError(reason)}` });
});

function markMounted(widget, mounted) {
    if (widget.__mounted === mounted) {
        return;
    }

    widget.__mounted = mounted;
    for (const child of widget.children) {
        markMounted(child, mounted);
    }
}

function findInTree(widget, name) {
    if (widget.props.widget_name === name) {
        return widget;
    }
    if (widget.type === "Window" && widget.props.name === name) {
        return widget;
    }
    for (const child of widget.children) {
        const found = findInTree(child, name);
        if (found) {
            return found;
        }
    }
    return null;
}

function normalizeClasses(value) {
    if (value === undefined || value === null) {
        return [];
    }
    if (Array.isArray(value)) {
        return value.map(String).filter(Boolean);
    }
    return String(value).split(/\s+/).filter(Boolean);
}

function addClass(node, className) {
    const classes = normalizeClasses(node.props.class);
    if (!classes.includes(className)) {
        classes.push(className);
    }
    node.props.class = classes.join(" ");
}

function removeClass(node, className) {
    const classes = normalizeClasses(node.props.class).filter((name) => name !== className);
    node.props.class = classes.join(" ");
}

const runtime = {
    windows: /** @type {Widget[]} */ ([]),
    idCounter: 0,
    initialParsed: false,
    syncScheduled: false,
    liveInstances: /** @type {Map<string, any>} */ (new Map()),
    instanceTrees: /** @type {Map<string, Widget>} */ (new Map()),
    instanceSyncScheduled: /** @type {Set<string>} */ (new Set()),
    afterRender: /** @type {((api: WidgetAPI) => unknown) | null} */ (null),
    afterRenderStarted: false,

    newDynId() {
        this.idCounter += 1;
        return `bun_${this.idCounter}`;
    },

    registerWindow(widget) {
        this.windows.push(widget);
        markMounted(widget, true);

        // Registering a window from inside `after_render` or a timer needs a
        // reload so the host learns about the new window definition.
        if (this.initialParsed) {
            this.scheduleSync();
        }

        return new WindowHandle(widget);
    },

    // === Mount hooks / per-instance trees === //

    /** @param {any} instance */
    handleWindowReady(instance) {
        if (!instance || typeof instance.instanceId !== "string" || instance.instanceId === "") {
            send({ type: "error", error: "Received invalid window_ready payload" });
            return;
        }

        this.liveInstances.set(instance.instanceId, instance);

        let tree = this.instanceTrees.get(instance.instanceId);
        if (!tree) {
            const definition = this.windows.find(
                (candidate) => candidate.props.name === instance.windowName,
            );
            if (!definition) {
                send({
                    type: "warn",
                    message: `window_ready for unknown window definition '${instance.windowName}'`,
                });
                return;
            }
            tree = definition.cloneForInstance(instance.instanceId);
            this.instanceTrees.set(instance.instanceId, tree);
        }

        const visit = (node) => {
            this.fireMount(node, instance, tree);
            for (const child of node.children) {
                visit(child);
            }
        };
        visit(tree);
    },

    /** @param {string} instanceId */
    handleWindowClose(instanceId) {
        this.liveInstances.delete(instanceId);
        this.instanceTrees.delete(instanceId);
    },

    /** @param {Widget} widget */
    tryMountForWidget(widget) {
        if (!widget.__mounted) {
            return;
        }

        if (widget.__instanceId) {
            const instance = this.liveInstances.get(widget.__instanceId);
            const tree = this.instanceTrees.get(widget.__instanceId);
            if (instance && tree) {
                this.fireMount(widget, instance, tree);
            }
            return;
        }

        const owner = this.findOwningWindow(widget);
        if (!owner) {
            return;
        }

        const windowName = String(owner.props.name ?? "");
        const widgetName = String(widget.props.widget_name ?? "");

        for (const instance of this.liveInstances.values()) {
            if (instance.windowName !== windowName) {
                continue;
            }

            const tree = this.instanceTrees.get(instance.instanceId);
            if (!tree) {
                continue;
            }

            const target = findInTree(tree, widgetName);
            if (!target) {
                continue;
            }

            // Definitions can gain new on_mount callbacks after instances exist.
            for (const entry of widget.__onMount ?? []) {
                if (!target.__onMount.some((existing) => existing.callback === entry.callback)) {
                    target.__onMount.push({ callback: entry.callback, instances: new Set() });
                }
            }

            this.fireMount(target, instance, tree);
        }
    },

    /** @param {Widget} widget @param {(value: string) => void} callback */
    removeMountCallbackFromInstances(widget, callback) {
        const widgetName = String(widget.props.widget_name ?? "");
        for (const tree of this.instanceTrees.values()) {
            const target = findInTree(tree, widgetName);
            if (target) {
                target.__onMount = target.__onMount.filter(
                    (entry) => entry.callback !== callback,
                );
            }
        }
    },

    /**
     * @param {Widget} widget
     * @param {any} instance
     * @param {Widget} ownerWindow
     */
    fireMount(widget, instance, ownerWindow) {
        if (!widget.__onMount || widget.__onMount.length === 0) {
            return;
        }

        const handle = new LiveWidgetHandle(
            String(widget.props.widget_name ?? ""),
            instance.instanceId,
        );
        const context = {
            instanceId: instance.instanceId,
            windowName: instance.windowName,
            monitor: instance.monitor ?? null,
            screen: instance.screen ?? null,
            widgetName: String(widget.props.widget_name ?? ""),
            dynId: String(widget.props.dyn_id ?? ""),
            window: ownerWindow,
            widget,
        };

        for (const entry of widget.__onMount) {
            if (entry.instances.has(instance.instanceId)) {
                continue;
            }
            entry.instances.add(instance.instanceId);
            try {
                entry.callback(handle, context);
            } catch (error) {
                send({
                    type: "error",
                    error: `on_mount callback failed: ${formatError(error)}`,
                });
            }
        }
    },

    /** @param {Widget} target */
    findOwningWindow(target) {
        /** @param {Widget} node */
        const contains = (node) => {
            if (node === target) return true;
            for (const child of node.children) {
                if (contains(child)) return true;
            }
            return false;
        };

        for (const window of this.windows) {
            if (contains(window)) {
                return window;
            }
        }
        return null;
    },

    /** @param {string} instanceId */
    scheduleInstanceSync(instanceId) {
        if (!this.instanceTrees.has(instanceId) || this.instanceSyncScheduled.has(instanceId)) {
            return;
        }

        this.instanceSyncScheduled.add(instanceId);
        queueMicrotask(() => {
            this.instanceSyncScheduled.delete(instanceId);
            const tree = this.instanceTrees.get(instanceId);
            if (!tree) {
                return;
            }

            try {
                tree.validate();
            } catch (error) {
                send({
                    type: "error",
                    error: `Refusing to synchronize an invalid instance tree: ${formatError(error)}`,
                });
                return;
            }

            send({
                type: "op",
                op: "replace_tree",
                instance: instanceId,
                tree: tree.toJSON(),
            });
        });
    },

    // === Reactive variables === //

    variables:
        /** @type {Map<string, { value: string, listeners: Set<(value: string) => void>, registered: boolean }>} */ (
            new Map()
        ),

    /** @param {string} name @param {string | null} initial */
    registerVariable(name, initial) {
        let entry = this.variables.get(name);
        if (entry?.registered) {
            return entry;
        }

        if (!entry) {
            entry = {
                value: initial ?? "",
                listeners: new Set(),
                registered: false,
            };
            this.variables.set(name, entry);
        } else if (entry.value === "" && initial !== null) {
            entry.value = initial;
        }

        entry.registered = true;
        send({ type: "op", op: "register_variable", name, initial });
        return entry;
    },

    /**
     * @param {string} widget
     * @param {string} key
     * @param {unknown} value
     * @param {string | null} instance
     */
    setWidgetProperty(widget, key, value, instance = null) {
        send({ type: "op", op: "set_property", widget, key, value, instance });
    },

    /** @param {string} name @param {string} value */
    setVariable(name, value) {
        send({ type: "op", op: "set_variable", name, value });
        // Notify local listeners immediately. The host broadcasts the value
        // back, but dispatchSignal ignores unchanged values.
        this.dispatchSignal(name, value);
    },

    /** @param {string} name */
    refreshVariable(name) {
        send({ type: "op", op: "query_variable", name });
    },

    /**
     * @param {string} name
     * @param {(value: string) => void} listener
     */
    subscribeVariable(name, listener) {
        if (typeof listener !== "function") {
            throw new TypeError("variable listeners must be functions");
        }

        const entry = this.registerVariable(name, null);
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
    },

    /** @param {string} name @param {(value: string) => void} listener */
    unsubscribeVariable(name, listener) {
        const entry = this.variables.get(name);
        if (entry) {
            entry.listeners.delete(listener);
        }
    },

    /** @param {string} name @param {string} value */
    dispatchSignal(name, value) {
        let entry = this.variables.get(name);
        if (!entry) {
            entry = { value, listeners: new Set(), registered: false };
            this.variables.set(name, entry);
            return;
        }

        if (entry.value === value) {
            return;
        }
        entry.value = value;

        for (const listener of [...entry.listeners]) {
            try {
                listener(value);
            } catch (error) {
                send({
                    type: "error",
                    error: `variable listener for '${name}' failed: ${formatError(error)}`,
                });
            }
        }
    },

    snapshot() {
        return this.windows.map((window) => window.toJSON());
    },

    find(name, instanceId = null) {
        if (instanceId) {
            const tree = this.instanceTrees.get(instanceId);
            return tree ? findInTree(tree, name) : null;
        }

        for (const window of this.windows) {
            const found = findInTree(window, name);
            if (found) {
                return found;
            }
        }
        return null;
    },

    requireNode(name, instanceId = null) {
        const node = this.find(name, instanceId);
        if (!node) {
            throw new Error(
                instanceId
                    ? `No widget with widget_name '${name}' was found in instance '${instanceId}'`
                    : `No widget with widget_name '${name}' was found`,
            );
        }
        return node;
    },

    validateAll() {
        for (const window of this.windows) {
            window.validate();
        }
    },

    /**
     * Ask the host to synchronize the GTK tree after structural changes.
     *
     * The released ewwii plugin API only provides a full configuration reload
     * (`IpcRequest::Reload`), so windows are rebuilt from the live sidecar
     * snapshot. Multiple changes in the same microtask are coalesced.
     */
    scheduleSync() {
        if (!this.initialParsed) {
            return;
        }

        if (this.syncScheduled) {
            return;
        }
        this.syncScheduled = true;

        queueMicrotask(() => {
            this.syncScheduled = false;

            try {
                this.validateAll();
            } catch (error) {
                send({
                    type: "error",
                    error: `Refusing to synchronize an invalid widget tree: ${formatError(error)}`,
                });
                return;
            }

            // A definition-wide structural change rebuilds every instance from
            // the (possibly changed) definition tree.
            this.instanceTrees.clear();
            this.liveInstances.clear();
            send({ type: "op", op: "reload" });
        });
    },

    async runAfterRender() {
        if (this.afterRenderStarted) {
            return;
        }
        this.afterRenderStarted = true;

        if (!this.afterRender) {
            return;
        }

        try {
            await this.afterRender(new WidgetAPI());
        } catch (error) {
            send({ type: "error", error: `after_render failed: ${formatError(error)}` });
        }
    },
};

globalThis.__BUN_EWWII__ = runtime;

/**
 * A handle for modifying a rendered widget by its `widget_name`.
 */
class LiveWidgetHandle {
    /**
     * @param {string} widgetId
     * @param {string | null} instanceId
     */
    constructor(widgetId, instanceId = null) {
        this.widgetId = widgetId;
        this.instanceId = instanceId;
    }

    /** @param {string} key @param {unknown} value */
    set_property(key, value) {
        if (this.instanceId === null) {
            const node = runtime.find(this.widgetId);
            if (node) {
                node.props[key] = value;
            }
        }
        runtime.setWidgetProperty(this.widgetId, key, value, this.instanceId);
        return this;
    }

    /** @param {string} className */
    add_class(className) {
        if (this.instanceId === null) {
            const node = runtime.find(this.widgetId);
            if (node) {
                addClass(node, className);
            }
        }
        send({
            type: "op",
            op: "add_class",
            widget: this.widgetId,
            class: className,
            instance: this.instanceId,
        });
        return this;
    }

    /** @param {...string} classNames */
    add_classes(...classNames) {
        for (const className of classNames) {
            this.add_class(className);
        }
        return this;
    }

    /** @param {string} className */
    remove_class(className) {
        if (this.instanceId === null) {
            const node = runtime.find(this.widgetId);
            if (node) {
                removeClass(node, className);
            }
        }
        send({
            type: "op",
            op: "remove_class",
            widget: this.widgetId,
            class: className,
            instance: this.instanceId,
        });
        return this;
    }

    /** @param {...string} classNames */
    remove_classes(...classNames) {
        for (const className of classNames) {
            this.remove_class(className);
        }
        return this;
    }

    /** @param {Widget} child */
    append_child(child) {
        runtime.requireNode(this.widgetId, this.instanceId).add_child(child);
        return this;
    }

    /** @param {number} index @param {Widget} child */
    insert_child(index, child) {
        runtime.requireNode(this.widgetId, this.instanceId).insert_child(index, child);
        return this;
    }

    /** @param {Widget | string} child */
    remove_child(child) {
        runtime.requireNode(this.widgetId, this.instanceId).remove_child(child);
        return this;
    }

    /** @param {Widget[]} children */
    replace_children(children) {
        runtime.requireNode(this.widgetId, this.instanceId).replace_children(children);
        return this;
    }

    clear_children() {
        runtime.requireNode(this.widgetId, this.instanceId).clear_children();
        return this;
    }

    /** @returns {string[]} */
    child_names() {
        const node = runtime.requireNode(this.widgetId, this.instanceId);
        return node.children.map((child) => String(child.props.widget_name));
    }

    /** @returns {LiveWidgetHandle[]} */
    children() {
        return this.child_names().map((name) => new LiveWidgetHandle(name, this.instanceId));
    }
}

/**
 * API passed to `after_render`.
 */
class WidgetAPI {
    /**
     * @param {string} widgetId
     * @param {string | null} instanceId
     */
    find(widgetId, instanceId = null) {
        return new LiveWidgetHandle(widgetId, instanceId);
    }

    /** Currently initialized window instances. */
    instances() {
        return [...runtime.liveInstances.values()].map((instance) => ({ ...instance }));
    }
}

/**
 * Handle returned by `Widgets.register()`.
 *
 * It extends `LiveWidgetHandle` for the window's root child, so methods such as
 * `append_child()` / `clear_children()` operate on the window's content. Use
 * `.window` for the raw Window Widget object.
 */
class WindowHandle extends LiveWidgetHandle {
    /** @param {Widget} widget */
    constructor(widget) {
        super(widget.children[0].props.widget_name);
        this.window = widget;
        this.name = widget.props.name;
        this.root = this;
    }

    /**
     * Handle scoped to a specific window instance.
     *
     * @param {string} instanceId
     */
    forInstance(instanceId) {
        return new LiveWidgetHandle(this.widgetId, instanceId);
    }

    /** @param {string} widgetId @param {string | null} instanceId */
    find(widgetId, instanceId = null) {
        return new LiveWidgetHandle(widgetId, instanceId);
    }
}

globalThis.WidgetAPI = WidgetAPI;
globalThis.LiveWidgetHandle = LiveWidgetHandle;
globalThis.WindowHandle = WindowHandle;

async function handleCommand(line) {
    let message;
    try {
        message = JSON.parse(line);
    } catch (error) {
        send({ type: "error", error: `Invalid bridge command: ${formatError(error)}` });
        return;
    }

    switch (message.type) {
        case "snapshot":
            send({ type: "snapshot_result", id: message.id, tree: runtime.snapshot() });
            break;
        case "signal":
            runtime.dispatchSignal(String(message.name ?? ""), String(message.value ?? ""));
            break;
        case "window_ready":
            runtime.handleWindowReady(message.instance);
            break;
        case "window_close":
            runtime.handleWindowClose(String(message.instanceId ?? ""));
            break;
        case "run_after_render":
            // Do not block the bridge command loop: user callbacks may await
            // long-running work, while snapshots and property ops must keep
            // flowing.
            runtime.runAfterRender().catch((error) => {
                send({ type: "error", error: `after_render failed: ${formatError(error)}` });
            });
            break;
        case "shutdown":
            process.exit(0);
            break;
        default:
            send({ type: "error", error: `Unknown bridge command '${message.type}'` });
            break;
    }
}

async function stdinLoop() {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of Bun.stdin.stream()) {
        buffer += decoder.decode(chunk, { stream: true });

        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
                await handleCommand(line);
            }
        }
    }
}

async function loadEntry() {
    const entry = process.env.BUN_EWWII_ENTRY;
    if (!entry) {
        send({ type: "fatal", error: "BUN_EWWII_ENTRY is not set" });
        return;
    }

    try {
        const module = await import(pathToFileURL(entry).href);
        runtime.afterRender =
            typeof module.after_render === "function" ? module.after_render : null;

        if (runtime.windows.length === 0) {
            send({ type: "warn", message: "no windows were registered with Widgets.register()" });
        }

        runtime.initialParsed = true;
        send({ type: "parsed", tree: runtime.snapshot() });
    } catch (error) {
        send({ type: "fatal", error: `Failed to evaluate ${entry}: ${formatError(error)}` });
    }
}

const input = stdinLoop().catch((error) => {
    send({ type: "error", error: `bridge input loop failed: ${formatError(error)}` });
});

await loadEntry();

// When the plugin closes stdin the parent is gone; don't leave streams/timers
// running as an orphan process.
await input;
process.exit(0);
