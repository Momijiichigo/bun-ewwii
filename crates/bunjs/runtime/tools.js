// ewwii/tools - filesystem, process, and streaming helpers for bun-ewwii.
//
// Unlike jscore.ewwii, these are implemented using Bun/Node primitives instead
// of custom deno_core ops.

import * as nodeFs from "node:fs/promises";

function assertFunction(value, name) {
    if (typeof value !== "function") {
        throw new TypeError(`${name} expects a function`);
    }
}

async function* readLines(stream) {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = "";

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let newline;
            while ((newline = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                yield line.endsWith("\r") ? line.slice(0, -1) : line;
            }
        }

        buffer += decoder.decode();
        if (buffer.length > 0) {
            yield buffer;
        }
    } finally {
        reader.releaseLock();
    }
}

// === Command === //

const cmd = {
    /** @param {string} command */
    async run(command) {
        const proc = Bun.spawn(["sh", "-c", command], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "inherit",
        });
        await proc.exited;
    },

    /** @param {string} command */
    async run_read(command) {
        const proc = Bun.spawn(["sh", "-c", command], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "inherit",
        });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        return output;
    },

    /**
     * Listen to stdout lines from a long-running command.
     *
     * @param {string} command
     * @param {(line: string) => void | Promise<void>} callback
     */
    async listen(command, callback) {
        assertFunction(callback, "cmd.listen");

        const proc = Bun.spawn(["sh", "-c", command], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "inherit",
        });

        try {
            for await (const line of readLines(proc.stdout)) {
                try {
                    await callback(line.trim());
                } catch (err) {
                    console.error("Error in cmd.listen callback:", err);
                }
            }
        } finally {
            try {
                proc.kill();
            } catch {
                // already dead
            }
            await proc.exited;
        }
    },
};

// === File system === //

const fs = {
    /** @param {string} path */
    async read(path) {
        return await nodeFs.readFile(path, "utf8");
    },

    /** @param {string} path @param {string} content */
    async write(path, content) {
        await nodeFs.writeFile(path, content, "utf8");
    },

    /** @param {string} path @param {string} content */
    async append(path, content) {
        await nodeFs.appendFile(path, content, "utf8");
    },

    /** @param {string} path */
    async remove(path) {
        await nodeFs.rm(path, { recursive: true, force: true });
    },

    /** @param {string} path */
    async exists(path) {
        try {
            await nodeFs.access(path);
            return true;
        } catch {
            return false;
        }
    },

    /** @param {string} path */
    async mkdir(path) {
        await nodeFs.mkdir(path, { recursive: true });
    },

    /** @param {string} path */
    async readdir(path) {
        return await nodeFs.readdir(path);
    },

    /** @param {string} path */
    async stat(path) {
        const stat = await nodeFs.stat(path);
        return {
            size: stat.size,
            isFile: stat.isFile(),
            isDir: stat.isDirectory(),
            created: Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : null,
            modified: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null,
            accessed: Number.isFinite(stat.atimeMs) ? stat.atimeMs : null,
            mode: stat.mode & 0o777,
        };
    },

    /** @param {string} source @param {string} destination */
    async copy(source, destination) {
        await nodeFs.cp(source, destination, { recursive: true, force: true });
    },

    /** @param {string} source @param {string} destination */
    async move(source, destination) {
        await nodeFs.rename(source, destination);
    },
};

// === Streams === //

const stream = {
    /**
     * Run a callback periodically with a time context.
     *
     * @param {(context: {
     *   date: Date,
     *   timestamp: number,
     *   string: string,
     *   iso: string
     * }) => void | Promise<void>} callback
     * @param {number} [ms]
     */
    time(callback, ms = 1000) {
        assertFunction(callback, "stream.time");

        const intervalId = setInterval(async () => {
            try {
                const now = new Date();
                await callback({
                    date: now,
                    timestamp: now.getTime(),
                    string: now.toLocaleTimeString(),
                    iso: now.toISOString(),
                });
            } catch (err) {
                console.error("Error inside stream.time callback:", err);
            }
        }, ms);

        return {
            stop: () => clearInterval(intervalId),
        };
    },

    /**
     * Listen to volume changes.
     *
     * @param {(volume: string) => void | Promise<void>} callback
     */
    volume(callback) {
        assertFunction(callback, "stream.volume");

        return cmd.listen(
            `
get_vol() {
  if command -v pamixer &>/dev/null; then
    if [ "$(pamixer --get-mute)" = "true" ]; then
      echo 0
    else
      pamixer --get-volume
    fi
  else
    amixer -D pulse sget Master | awk -F '[^0-9]+' '/Left:/{print $3}'
  fi
}

get_vol

pactl subscribe | while read -r line; do
  if echo "$line" | grep -q "sink"; then
    get_vol
  fi
done
`,
            (line) => callback(line),
        );
    },
};

export { cmd, fs, stream };
