import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const runtimeSource = path.join(import.meta.dir, "..", "crates", "bunjs", "runtime");

test("instance edit() coalesces child changes into one replace_children op", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bun-ewwii-children-test-"));
    const ewwiiModule = path.join(root, "node_modules", "ewwii");
    await fs.mkdir(ewwiiModule, { recursive: true });

    await fs.copyFile(path.join(runtimeSource, "runtime.js"), path.join(root, "runtime.js"));
    for (const file of ["widgets.js", "tools.js", "reactive.js"]) {
        await fs.copyFile(path.join(runtimeSource, file), path.join(ewwiiModule, file));
    }
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
list.add_child(Widgets.Label("first").properties({ widget_name: "first" }));
Widgets.register(Widgets.Window("demo").add_child(list));

export function after_render(api) {
    const handle = api.find("list", "demo_0");
    handle.edit((h) => {
        h.clear_children();
        h.append_child(Widgets.Label("a").properties({ widget_name: "a" }));
        h.append_child(Widgets.Label("b").properties({ widget_name: "b" }));
    });
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

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
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
            const result = await Promise.race([
                reader.read(),
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error("timed out waiting for sidecar message")),
                        remaining,
                    ),
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

        send({
            type: "window_ready",
            instance: {
                instanceId: "demo_0",
                windowName: "demo",
                monitor: "0",
                screen: 0,
            },
        });
        send({ type: "run_after_render" });

        const sync = await nextMessage();
        expect(sync.type).toBe("op");
        expect(sync.op).toBe("replace_children");
        expect(sync.instance).toBe("demo_0");
        expect(sync.widget).toBe("list");
        expect(sync.children.map((child) => child.props.widget_name)).toEqual(["a", "b"]);

        // The transaction must not also request a full tree/window rebuild.
        const extra = await nextMessage(500).catch(() => null);
        expect(extra).toBeNull();

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
