import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const runtimeSource = path.join(import.meta.dir, "..", "crates", "bunjs", "runtime");

test("Bun sidecar resolves local TypeScript imports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bun-ewwii-ts-test-"));
    const ewwiiModule = path.join(root, "node_modules", "ewwii");
    await fs.mkdir(ewwiiModule, { recursive: true });
    await fs.mkdir(path.join(root, "modules"), { recursive: true });

    for (const file of ["runtime.js"]) {
        await fs.copyFile(path.join(runtimeSource, file), path.join(root, file));
    }
    for (const file of ["widgets.js", "tools.js", "reactive.js"]) {
        await fs.copyFile(path.join(runtimeSource, file), path.join(ewwiiModule, file));
    }
    await fs.copyFile(
        path.join(runtimeSource, "ewwii-package.json"),
        path.join(ewwiiModule, "package.json"),
    );

    await fs.writeFile(
        path.join(root, "modules", "helper.ts"),
        `
import * as Widgets from "ewwii/widgets";

export function makeLabel(): Widget {
    return Widgets.Label("from local ts").properties({ widget_name: "local" });
}
`,
    );

    const entry = path.join(root, "ewwii.ts");
    await fs.writeFile(
        entry,
        `
import * as Widgets from "ewwii/widgets";
import { makeLabel } from "./modules/helper.ts";

Widgets.register(
    Widgets.Window("ts-demo").add_child(Widgets.Box().add_child(makeLabel())),
);

export function after_render(_api: WidgetAPI): void {}
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

    try {
        const parsed = await nextMessage();
        expect(parsed.type).toBe("parsed");
        expect(parsed.tree[0].type).toBe("Window");
        expect(parsed.tree[0].children[0].children[0].props.text).toBe("from local ts");

        proc.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
        proc.stdin.flush();
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
