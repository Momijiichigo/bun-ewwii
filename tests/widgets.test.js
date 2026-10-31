import { beforeEach, describe, expect, test } from "bun:test";

let syncs = 0;
let windows = [];
let propertyOps = [];
let mountCalls = [];

globalThis.__BUN_EWWII__ = {
    idCounter: 0,
    newDynId() {
        this.idCounter += 1;
        return `test_${this.idCounter}`;
    },
    scheduleSync() {
        syncs += 1;
    },
    setWidgetProperty(widget, key, value) {
        propertyOps.push([widget, key, value]);
    },
    syncScheduled: false,
    liveInstances: new Map(),
    tryMountForWidget(widget) {
        if (!widget.__mounted) return;
        const owner = windows.find((window) => {
            const contains = (node) => {
                if (node === widget) return true;
                return node.children.some(contains);
            };
            return contains(window);
        });
        if (!owner) return;
        for (const instance of this.liveInstances.values()) {
            if (instance.windowName !== owner.props.name) continue;
            for (const entry of widget.__onMount) {
                if (entry.instances.has(instance.instanceId)) continue;
                entry.instances.add(instance.instanceId);
                entry.callback(
                    { widgetId: widget.props.widget_name, instanceId: instance.instanceId },
                    {
                        instanceId: instance.instanceId,
                        windowName: instance.windowName,
                        widgetName: widget.props.widget_name,
                        dynId: widget.props.dyn_id,
                        window: owner,
                        widget,
                    },
                );
            }
        }
    },
    handleWindowReady(instance) {
        this.liveInstances.set(instance.instanceId, instance);
        const visit = (node) => {
            this.tryMountForWidget(node);
            for (const child of node.children) visit(child);
        };
        for (const window of windows) visit(window);
    },
    registerWindow(widget) {
        windows.push(widget);
        const mark = (node) => {
            node.__mounted = true;
            for (const child of node.children) mark(child);
        };
        mark(widget);
        return { window: widget, name: widget.props.name };
    },
};

const Widgets = await import("../crates/bunjs/runtime/widgets.js");

beforeEach(() => {
    syncs = 0;
    windows = [];
    propertyOps = [];
    globalThis.__BUN_EWWII__.liveInstances = new Map();
    globalThis.__BUN_EWWII__.idCounter = 0;
});

describe("widget tree", () => {
    test("assigns stable dyn ids and hidden names", () => {
        const box = Widgets.Box();
        const label = Widgets.Label("hello");

        expect(box.props.dyn_id).toBe("test_1");
        expect(box.props.widget_name).toBe("__bun_ewwii_test_1");
        expect(label.props.dyn_id).toBe("test_2");
        expect(label.props.text).toBe("hello");
        expect(box.toJSON()).toEqual({
            type: "Box",
            props: { dyn_id: "test_1", widget_name: "__bun_ewwii_test_1" },
        });
    });

    test("removing a middle child asks for synchronization", () => {
        const box = Widgets.Box();
        const a = Widgets.Label("a");
        const b = Widgets.Label("b");
        const c = Widgets.Label("c");

        // Unmounted construction must not schedule host synchronization.
        box.add_child(a).add_child(b).add_child(c);
        expect(syncs).toBe(0);

        globalThis.__BUN_EWWII__.registerWindow(Widgets.Window("demo").add_child(box));
        box.remove_child(b);

        expect(box.children).toEqual([a, c]);
        expect(syncs).toBe(1);
    });

    test("mounted property changes are live, identity changes rebuild", () => {
        const label = Widgets.Label("a").properties({ widget_name: "label" });
        const box = Widgets.Box().add_child(label);
        Widgets.register(Widgets.Window("demo").add_child(box));

        label.set_property("text", "b");
        expect(propertyOps).toEqual([["label", "text", "b"]]);
        expect(syncs).toBe(0);

        label.set_property("widget_name", "renamed");
        expect(syncs).toBe(1);
    });

    test("on_mount fires per window instance", () => {
        const calls = [];
        const label = Widgets.Label("x")
            .properties({ widget_name: "label" })
            .on_mount((handle, info) => calls.push([handle.instanceId, info]));

        Widgets.register(Widgets.Window("demo").add_child(Widgets.Box().add_child(label)));
        expect(calls).toEqual([]);

        globalThis.__BUN_EWWII__.handleWindowReady({ instanceId: "demo_0", windowName: "demo" });
        globalThis.__BUN_EWWII__.handleWindowReady({ instanceId: "demo_1", windowName: "demo" });

        expect(calls.length).toBe(2);
        expect(calls[0][0]).toBe("demo_0");
        expect(calls[1][0]).toBe("demo_1");
        expect(calls[0][1].windowName).toBe("demo");
        expect(calls[0][1].widgetName).toBe("label");
        expect(calls[0][1].widget).toBe(label);
    });

    test("enforces child limits", () => {
        const scroll = Widgets.Scroll();
        expect(() => scroll.add_child(Widgets.Label("a"))).not.toThrow();
        expect(() => scroll.add_child(Widgets.Label("b"))).toThrow();

        const windowWidget = Widgets.Window("demo");
        expect(() => windowWidget.add_child(Widgets.Label("a"))).not.toThrow();
        expect(() => windowWidget.add_child(Widgets.Label("b"))).toThrow();
    });

    test("inserts children at the requested index", () => {
        const box = Widgets.Box();
        const a = Widgets.Label("a");
        const b = Widgets.Label("b");
        const c = Widgets.Label("c");

        box.add_child(a).add_child(c).insert_child(1, b);
        expect(box.children).toEqual([a, b, c]);
    });

    test("replaces and clears children", () => {
        const box = Widgets.Box();
        const a = Widgets.Label("a");
        const b = Widgets.Label("b");
        box.add_child(a);

        box.replace_children([a, b]);
        expect(box.children).toEqual([a, b]);

        box.clear_children();
        expect(box.children).toEqual([]);
    });

    test("register validates windows and returns the runtime handle", () => {
        expect(() => Widgets.register(Widgets.Box())).toThrow();
        expect(() => Widgets.register(Widgets.Window("demo"))).toThrow();

        const windowWidget = Widgets.Window("demo").add_child(Widgets.Label("x"));
        const handle = Widgets.register(windowWidget);
        expect(handle.window).toBe(windowWidget);
        expect(handle.name).toBe("demo");
        expect(windows.length).toBe(1);
    });
});
