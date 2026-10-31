import { beforeEach, describe, expect, test } from "bun:test";

let variables = new Map();
let sent = [];

globalThis.__BUN_EWWII__ = {
    registerVariable(name, initial) {
        let entry = variables.get(name);
        if (entry) {
            return entry;
        }
        entry = { value: initial ?? "", listeners: new Set() };
        variables.set(name, entry);
        sent.push({ op: "register_variable", name, initial });
        return entry;
    },

    setVariable(name, value) {
        const entry = this.registerVariable(name, null);
        entry.value = value;
        sent.push({ op: "set_variable", name, value });
    },

    refreshVariable(name) {
        sent.push({ op: "query_variable", name });
    },

    subscribeVariable(name, listener) {
        const entry = this.registerVariable(name, null);
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
    },

    unsubscribeVariable(name, listener) {
        variables.get(name)?.listeners.delete(listener);
    },

    emit(name, value) {
        const entry = this.registerVariable(name, null);
        entry.value = value;
        for (const listener of [...entry.listeners]) listener(value);
    },
};

const { ReactiveVariable, variable, toVariableString } = await import("../crates/bunjs/runtime/reactive.js");

beforeEach(() => {
    variables = new Map();
    sent = [];
});

describe("reactive variables", () => {
    test("converts values to ewwii strings", () => {
        expect(toVariableString(null)).toBe("");
        expect(toVariableString(undefined)).toBe("");
        expect(toVariableString("hi")).toBe("hi");
        expect(toVariableString(42)).toBe("42");
        expect(toVariableString(true)).toBe("true");
        expect(toVariableString({ a: 1 })).toBe('{"a":1}');
    });

    test("registers once and preserves existing values", () => {
        const v = variable("foo", "init");
        expect(v.value).toBe("init");
        expect(sent[0]).toEqual({
            op: "register_variable",
            name: "foo",
            initial: "init",
        });

        variables.get("foo").value = "from-ewwii";
        const again = variable("foo", "ignored");
        expect(again.value).toBe("from-ewwii");
        expect(sent.filter((m) => m.op === "register_variable").length).toBe(1);
    });

    test("set() updates the cache and sends a broadcast", () => {
        const v = variable("foo", "init");
        v.set(12);
        expect(v.value).toBe("12");
        expect(sent.at(-1)).toEqual({ op: "set_variable", name: "foo", value: "12" });

        v.value = "next";
        expect(v.get()).toBe("next");
    });

    test("delivers external updates to listeners", () => {
        const v = new ReactiveVariable("foo", "init");
        const seen = [];
        const off = v.on_change((value) => seen.push(value));

        globalThis.__BUN_EWWII__.emit("foo", "a");
        globalThis.__BUN_EWWII__.emit("foo", "b");
        off();
        globalThis.__BUN_EWWII__.emit("foo", "c");

        expect(seen).toEqual(["a", "b"]);
        expect(v.value).toBe("c");
    });

    test("supports on(), once_change(), and off_change()", () => {
        const v = variable("foo", "init");
        const seen = [];

        expect(() => v.on("nope", () => {})).toThrow();
        v.on("change", (value) => seen.push(`on:${value}`));
        v.once_change((value) => seen.push(`once:${value}`));

        globalThis.__BUN_EWWII__.emit("foo", "1");
        globalThis.__BUN_EWWII__.emit("foo", "2");

        expect(seen).toEqual(["on:1", "once:1", "on:2"]);

        const listener = () => seen.push("removed");
        v.on_change(listener);
        v.off_change(listener);
        globalThis.__BUN_EWWII__.emit("foo", "3");
        expect(seen).not.toContain("removed");
    });

    test("supports refresh() and bind()", () => {
        const v = variable("foo", "init");
        v.refresh();
        expect(sent.at(-1)).toEqual({ op: "query_variable", name: "foo" });

        const writes = [];
        const handle = {
            set_property(key, value) {
                writes.push([key, value]);
            },
        };

        const off = v.bind(handle, "label");
        expect(writes).toEqual([["label", "init"]]);

        globalThis.__BUN_EWWII__.emit("foo", "live");
        expect(writes).toEqual([
            ["label", "init"],
            ["label", "live"],
        ]);

        off();
        globalThis.__BUN_EWWII__.emit("foo", "after-off");
        expect(writes.length).toBe(2);
    });
});
