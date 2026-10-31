#!/usr/bin/env bun
// Open one frutiger_bar instance per Hyprland monitor.
//
// The ewwii daemon must already be running. By default this uses the standard
// ewwii config directory. For a config elsewhere:
//
//   EWWII_BIN=target/release/ewwii \
//   EWWII_CONFIG=examples/frutiger_bar \
//   bun examples/frutiger_bar/launch_bar.ts

import { $ } from "bun";

const ewwii = process.env.EWWII_BIN ?? "ewwii";
const config = process.env.EWWII_CONFIG;

const monitors = (await $`hyprctl monitors -j`.json()) as Array<{
    id: number;
    name: string;
}>;

for (const [index, monitor] of monitors.entries()) {
    const instance = `frutiger_bar_${monitor.id}`;
    const args = [];
    if (config) {
        args.push("-c", config);
    }
    args.push("open", "frutiger_bar", "--screen", String(index), "--id", instance);

    const proc = Bun.spawn([ewwii, ...args], {
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        console.error(`failed to open ${instance} (exit ${exitCode})`);
    }
}
