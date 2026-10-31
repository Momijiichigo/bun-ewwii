# Frutiger Aero bar for bun/ewwii

A Bun/ewwii port of `tmp_legacy_eww_config/yuck/frutiger_bar/bar.yuck`.

The entry point is `ewwii.ts`. Bun runs TypeScript directly; no build step is
needed. The built-in ewwii engine looks for `ewwii.ts` first and falls back to
`ewwii.js`.

Only the bar is implemented. Wallpaper widgets, popups, brightness, memory and
CPU modules are intentionally left out for now.

## Install / run

Copy this directory to your ewwii config (or run it in place):

```sh
mkdir -p ~/.config/ewwii
cp -r examples/frutiger_bar/* ~/.config/ewwii/

ewwii daemon
ewwii open frutiger_bar --screen 0 --id frutiger_bar_0
```

To open one bar per monitor automatically:

```sh
./examples/frutiger_bar/launch_bar.ts
```

If your config is not in `~/.config/ewwii`, pass it explicitly:

```sh
EWWII_BIN=target/release/ewwii \
EWWII_CONFIG=examples/frutiger_bar \
bun examples/frutiger_bar/launch_bar.ts
```

Or directly from the repository:

```sh
target/release/ewwii -c examples/frutiger_bar daemon
target/release/ewwii -c examples/frutiger_bar open frutiger_bar --screen 0 --id frutiger_bar_0
```

Make sure the `ewwii` you start is this build, not an old installed version.
The hover/sleep-click commands use `ewwii` from `PATH`.

`launch_bar.ts` opens one bar per Hyprland monitor:

```text
frutiger_bar_<monitor-id> --screen <monitor-index>
```

`on_mount` receives `info.screen`, which is used to select `wspaces[screen]`.

## Type checking

The repository `tsconfig.json` includes `../../types/ewwii.d.ts`. To check the
example in place:

```sh
bunx --bun tsc --noEmit -p examples/frutiger_bar/tsconfig.json
```

If this directory is your `~/.config/ewwii`, copy the declarations there too:

```sh
cp types/ewwii.d.ts ~/.config/ewwii/bun-ewwii.d.ts
```

Use the name `bun-ewwii.d.ts`; naming it `ewwii.d.ts` conflicts with the
`ewwii.ts` entry point.

Local modules work normally:

```ts
import { makeLabel } from "./lib/helper.ts";
```

`tsconfig.json` enables `allowImportingTsExtensions` for the explicit `.ts`
extension. At runtime Bun resolves local `.ts` imports directly; no build step
is involved.

## Runtime dependencies

- `bun`
- `hyprctl` (workspaces, active workspace)
- `playerctl` (music)
- `nmcli` (Wi-Fi)
- `bluetoothctl` (Bluetooth)
- `swaync-client` (notification icon)
- `alacritty` for the Wi-Fi/Bluetooth launch buttons
- Nerd Fonts (FiraCode Nerd Font, DaddyTimeMono NF, ...)

## What works

- Per-monitor workspaces, from `wspaces` (`[[ws...], [ws...], ...]` indexed by
  monitor/screen).
- Active workspace highlighting and click-to-focus.
- Current music cover/title and play/pause/previous/next controls (revealed on
  hover).
- Wi-Fi icon/color/ESSID.
- Bluetooth icon/tooltip.
- Battery icon/percentage.
- `dont_sleep` visual state; left click sets it true, right click false.
- Notification icon via `swaync-client --subscribe`.
- Clock with date/weekday/hour/minute and seconds scale.

`wspaces`, `current_workspace`, `dont_sleep` and `music_reveal` are ewwii
variables, so they can also be changed with:

```sh
ewwii update 'dont_sleep=true'
ewwii update 'music_reveal=true'
```

The workspaces are polled from `hyprctl` once per second, so the old external
`workspaces.ts` / `current_workspace.ts` loops are not required.

## Not implemented yet

- `systray` (ewwii does not expose a systray widget)
- Popup windows/scripts (`calendar`, `system`, `music_win`, `powermenu`)
- Brightness/memory/CPU modules (they were commented out in the legacy bar)
- Wallpaper widgets

## Notes

- The legacy `button` children are represented as `EventBox` + children because
  ewwii buttons do not host child widgets.
- The default music cover uses `images/music.png`; MPRIS `file://` art URLs are
  used as local paths. Remote HTTP(s) art URLs fall back to the default image.
- `music_reveal` is driven by `ewwii update` commands from `onhover` /
  `onhoverlost`.
