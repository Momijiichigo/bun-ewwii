import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const runtimeSource = path.join(import.meta.dir, "..", "crates", "bunjs", "runtime");

test("Bun sidecar emits a parsed tree and handles dynamic children", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bun-ewwii-test-"));
    const ewwiiModule = path.join(root, "node_modules", "ewwii");
    await fs.mkdir(ewwiiModule, { recursive: true });

    await fs.copyFile(path.join(runtimeSource, "runtime.js"), path.join(root, "runtime.js"));
    await fs.copyFile(path.join(runtimeSource, "widgets.js"), path.join(ewwiiModule, "widgets.js"));
    await fs.copyFile(path.join(runtimeSource, "tools.js"), path.join(ewwiiModule, "tools.js"));
    await fs.copyFile(
        path.join(runtimeSource, "reactive.js"),
        path.join(ewwiiModule, "reactive.js"),
    );
    await fs.copyFile(
        path.join(runtimeSource, "ewwii-package.json"),
        path.join(ewwiiModule, "package.json"),
    );

    const entry = path.join(root, "entry.js");
    await fs.writeFile(
        entry,
        `
import * as Widgets from "ewwii/widgets";

const list = Widgets.Box().properties({ widget_name: "list", orientation: "v" });
list.add_child(
    Widgets.Label("first")
        .properties({ widget_name: "first" })
        .on_mount((handle, info) =>
            console.log("MOUNTED:" + info.windowName + ":" + info.instanceId + ":" + handle.instanceId + ":" + handle.widgetId),
        ),
);
Widgets.register(Widgets.Window("demo").add_child(list));

export function after_render(api) {
    const handle = api.find("list");
    handle.append_child(Widgets.Label("dynamic").properties({ widget_name: "dynamic" }));
    handle.remove_child("first");
}
`,
    );

    const proc = Bun.spawn([process.execPath, "--no-orphans", path.join(root, "runtime.js")], {
        cwd: root,
        env: {
            ...process.env,
            BUN_EWWII_ENTRY: entry,
            BUN_EWWII_CONFIG_DIR: root,
            NODE_PATH: path.join(root, "node_modules"),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
    });

    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    let buffer = "";

    const nextMessage = async (timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (true) {
            const newline = buffer.indexOf("\n");
            if (newline !== -1) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line) return JSON.parse(line);
                continue;
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error("timed out waiting for sidecar message");

            const read = reader.read();
            const result = await Promise.race([
                read,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("timed out waiting for sidecar message")), remaining),
                ),
            ]);
            if (result.done) throw new Error("sidecar stdout closed");
            buffer += decoder.decode(result.value, { stream: true });
        }
    };

    const send = (message) => {
        proc.stdin.write(JSON.stringify(message) + "\n");
        proc.stdin.flush();
    };

    try {
        const parsed = await nextMessage();
        expect(parsed.type).toBe("parsed");
        expect(parsed.tree[0].type).toBe("Window");
        expect(parsed.tree[0].children[0].children.map((child) => child.props.widget_name)).toEqual([
            "first",
        ]);

        send({
            type: "window_ready",
            instance: {
                instanceId: "demo_0",
                windowName: "demo",
                monitor: "0",
                screen: 0,
            },
        });
        let mounted = false;
        for (let i = 0; i < 20 && !mounted; i++) {
            const message = await nextMessage();
            if (
                message.type === "log" &&
                message.message === "MOUNTED:demo:demo_0:demo_0:first"
            ) {
                mounted = true;
            }
        }
        expect(mounted).toBe(true);

        send({ type: "run_after_render" });

        let reload = null;
        for (let i = 0; i < 20 && !reload; i++) {
            const message = await nextMessage();
            if (message.type === "op" && message.op === "reload") reload = message;
        }
        expect(reload).not.toBeNull();

        send({ type: "snapshot", id: 42 });
        let snapshot = null;
        for (let i = 0; i < 20 && !snapshot; i++) {
            const message = await nextMessage();
            if (message.type === "snapshot_result" && message.id === 42) snapshot = message;
        }

        expect(snapshot).not.toBeNull();
        expect(
            snapshot.tree[0].children[0].children.map((child) => child.props.widget_name),
        ).toEqual(["dynamic"]);

        send({ type: "shutdown" });
        await proc.exited;
    } finally {
        try {
            proc.kill();
        } catch {
            // already exited
        }
        await fs.rm(root, { recursive: true, force: true });
    }
});
