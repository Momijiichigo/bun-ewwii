// ewwii/reactive - variables shared with `ewwii update name=value`.
//
// ewwii already has a global variable store and a watch/broadcast mechanism
// used by `ewwii update`/`ewwii state`. We register JS variables as plugin
// signals, subscribe to updates, and forward them to the JS sidecar.

function runtime() {
    const rt = globalThis.__BUN_EWWII__;
    if (!rt) {
        throw new Error("ewwii/reactive was loaded outside of bun-ewwii");
    }
    return rt;
}

/**
 * Convert a JS value to the string representation used by ewwii variables.
 *
 * @param {unknown} value
 */
export function toVariableString(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * A string value shared with ewwii's variable store.
 *
 * Values changed with `ewwii update foo=bar` (or by another process using the
 * same ewwii daemon) are delivered to `on_change` listeners. Calling `.set()`
 * updates the same store and broadcasts to all other listeners.
 */
export class ReactiveVariable {
    /**
     * Normally you should use `variable()` instead of constructing this
     * directly.
     *
     * @param {string} name
     * @param {unknown} [initial] If omitted, an existing value is preserved.
     */
    constructor(name, initial) {
        if (typeof name !== "string" || name.length === 0) {
            throw new TypeError("variable() requires a non-empty string name");
        }

        this.name = name;
        this._entry = runtime().registerVariable(
            name,
            initial === undefined || initial === null ? null : toVariableString(initial),
        );
    }

    /** Current value as a string. Assignments are equivalent to `.set()`. */
    get value() {
        return this._entry.value;
    }

    set value(value) {
        this.set(value);
    }

    /** Current value as a string. */
    get() {
        return this._entry.value;
    }

    /**
     * Set the value and broadcast it through ewwii's variable store.
     *
     * @param {unknown} value
     * @returns {this}
     */
    set(value) {
        runtime().setVariable(this.name, toVariableString(value));
        return this;
    }

    /**
     * Re-query the current value from ewwii's store. Normally unnecessary:
     * updates from `ewwii update` are pushed automatically.
     *
     * @returns {this}
     */
    refresh() {
        runtime().refreshVariable(this.name);
        return this;
    }

    /**
     * Run a listener whenever the value changes.
     *
     * @param {(value: string) => void} listener
     * @returns {() => void} unsubscribe function
     */
    on_change(listener) {
        return runtime().subscribeVariable(this.name, listener);
    }

    /** Alias of `on_change`. */
    subscribe(listener) {
        return this.on_change(listener);
    }

    /**
     * Event-style listener registration. Supported events: `"change"`,
     * `"update"`, `"value"`.
     *
     * @param {"change" | "update" | "value"} event
     * @param {(value: string) => void} listener
     * @returns {() => void} unsubscribe function
     */
    on(event, listener) {
        if (event !== "change" && event !== "update" && event !== "value") {
            throw new TypeError(`Unsupported variable event '${event}'`);
        }
        return this.on_change(listener);
    }

    /**
     * Remove a listener.
     *
     * @param {(value: string) => void} listener
     * @returns {this}
     */
    off_change(listener) {
        runtime().unsubscribeVariable(this.name, listener);
        return this;
    }

    /**
     * Run a listener once for the next change.
     *
     * @param {(value: string) => void} listener
     * @returns {() => void} unsubscribe function
     */
    once_change(listener) {
        const unsubscribe = this.on_change((value) => {
            unsubscribe();
            listener(value);
        });
        return unsubscribe;
    }

    /**
     * Keep a live widget property in sync with this variable.
     *
     * @param {{ set_property(key: string, value: unknown): unknown }} handle
     * @param {string} [property]
     * @returns {() => void} unsubscribe function
     */
    bind(handle, property = "text") {
        if (!handle || typeof handle.set_property !== "function") {
            throw new TypeError("bind() expects a LiveWidgetHandle (or compatible object)");
        }

        handle.set_property(property, this.value);
        return this.on_change((value) => {
            handle.set_property(property, value);
        });
    }

    toString() {
        return this._entry.value;
    }

    valueOf() {
        return this._entry.value;
    }
}

/**
 * Create (or get) a variable backed by ewwii's variable store.
 *
 * @param {string} name
 * @param {unknown} [initial]
 */
export function variable(name, initial) {
    return new ReactiveVariable(name, initial);
}
