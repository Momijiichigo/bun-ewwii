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
 * Convert an ewwii variable string back to the type described by `initial`.
 *
 * Strings are kept as-is, so `variable<string>("name", "42")` still produces
 * `"42"` rather than the number `42`. For non-string initial values the string
 * is parsed as JSON; if that fails, the raw string is returned.
 *
 * @template T
 * @param {string} value
 * @param {T} [initial]
 * @returns {T}
 */
export function fromVariableString(value, initial) {
    if (typeof initial === "string" || initial === undefined) {
        return /** @type {T} */ (value);
    }
    try {
        return /** @type {T} */ (JSON.parse(value));
    } catch {
        return /** @type {T} */ (value);
    }
}

/**
 * A typed value shared with ewwii's variable store.
 *
 * Values changed with `ewwii update foo=bar` (or by another process using the
 * same ewwii daemon) are delivered to `on_change` listeners. Calling `.set()`
 * updates the same store and broadcasts to all other listeners.
 *
 * @template T
 */
export class ReactiveVariable {
    /**
     * Normally you should use `variable()` instead of constructing this
     * directly.
     *
     * @param {string} name
     * @param {T} [initial] If omitted, an existing value is preserved.
     */
    constructor(name, initial) {
        if (typeof name !== "string" || name.length === 0) {
            throw new TypeError("variable() requires a non-empty string name");
        }

        this.name = name;
        this._initial = initial;
        this._listeners = new Map();
        this._entry = runtime().registerVariable(
            name,
            initial === undefined || initial === null ? null : toVariableString(initial),
        );
    }

    /** Current value. Assignments are equivalent to `.set()`. */
    get value() {
        return this._parse(this._entry.value);
    }

    set value(value) {
        this.set(value);
    }

    /** Current value. */
    get() {
        return this._parse(this._entry.value);
    }

    /**
     * Set the value and broadcast it through ewwii's variable store.
     *
     * @param {T} value
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
     * @param {(value: T) => void} listener
     * @returns {() => void} unsubscribe function
     */
    on_change(listener) {
        if (typeof listener !== "function") {
            throw new TypeError("on_change() expects a function");
        }

        const wrapped = (raw) => listener(this._parse(raw));
        this._listeners.set(listener, wrapped);
        const unsubscribe = runtime().subscribeVariable(this.name, wrapped);
        return () => {
            this._listeners.delete(listener);
            unsubscribe();
        };
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
     * @param {(value: T) => void} listener
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
     * @param {(value: T) => void} listener
     * @returns {this}
     */
    off_change(listener) {
        const wrapped = this._listeners.get(listener);
        if (wrapped) {
            this._listeners.delete(listener);
            runtime().unsubscribeVariable(this.name, wrapped);
        }
        return this;
    }

    /**
     * Run a listener once for the next change.
     *
     * @param {(value: T) => void} listener
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

    /** @param {string} raw */
    _parse(raw) {
        return fromVariableString(raw, this._initial);
    }

    toString() {
        return this._entry.value;
    }

    valueOf() {
        return this._entry.value;
    }
}

/**
 * Create (or get) a typed variable backed by ewwii's variable store.
 *
 * @template T
 * @param {string} name
 * @param {T} [initial]
 * @returns {ReactiveVariable<T>}
 */
export function variable(name, initial) {
    return new ReactiveVariable(name, initial);
}
