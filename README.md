# ewwii + Bun monorepo

A fork of [ewwii](https://github.com/ewwii-sh/ewwii) with a **built-in Bun/JavaScript configuration engine**.

- **Bun is the default and only bundled configuration language.**
- **Nbcl support has been removed** (the parser, CLI command, and runtime integration).
- ewwii itself, the Bun config engine, and the shared widget/plugin crates live in one workspace.
- Window-instance-aware live widget control is built into the host: the same window definition can run on multiple monitors with independent `LiveWidgetHandle`s.

```text
ewwii (GTK/Rust) ── built-in bridge ──> Bun sidecar
     ▲                                     │
     └──────── widget-control IPC ─────────┘
```

## Workspace layout

```text
crates/ewwii              ewwii daemon, CLI, GTK host
crates/bunjs              built-in Bun config engine + embedded JS runtime
crates/shared_utils       node/property/template utilities
crates/plugin_api         plugin API 2.0 (no Nbcl APIs)
crates/widget_node_derive derive helpers for WidgetNode

crates/bunjs/runtime/     JS modules installed to Bun's module path
types/ewwii.d.ts          TypeScript declarations for user configs
examples/ewwii.js         minimal JavaScript example config
examples/frutiger_bar/   TypeScript port of the legacy frutiger_bar
tests/                    Bun runtime tests
```

## Requirements

- Bun on `PATH` (tested with Bun 1.4.4)
- GTK4 / the same system dependencies ewwii normally needs
- Rust toolchain for building

If Bun is not on `PATH`, set `BUN_EWWII_BUN=/path/to/bun`.

## Build

```sh
cargo build --release -p ewwii
```

The binary is `target/release/ewwii`. Put it on your `PATH` (or run it directly).

```sh
./target/release/ewwii --version
./target/release/ewwii daemon
```

There is no plugin to install for JavaScript configuration anymore. The old
`plugins/libbun_ewwii.so` / `plugins/libjscore.so` are not used by this build.

## Configuration

Create the usual config directory:

```text
~/.config/ewwii/
├── ewwii.ts    # or ewwii.js
└── ewwii.scss
```

The built-in Bun engine accepts either `ewwii.ts` or `ewwii.js`. If both exist,
`ewwii.ts` takes precedence. Bun evaluates TypeScript directly, so no build step
is needed. The main file can import `ewwii/widgets`, `ewwii/tools`, and
`ewwii/reactive`, plus normal npm packages.

```js
import * as Widgets from "ewwii/widgets";

const list = Widgets.Box().properties({
  widget_name: "list",
  orientation: "v",
  spacing: 6,
});

list.add_child(Widgets.Label("Hello from Bun!"));

Widgets.register(
  Widgets.Window("demo").properties({
    geometry: {
      x: "0%",
      y: "0%",
      width: "320px",
      height: "180px",
      anchor: "top left",
    },
  }).add_child(list),
);
```

```sh
ewwii daemon
ewwii open demo
```

## Type checking

Copy the declarations to the config directory:

```sh
cp types/ewwii.d.ts ~/.config/ewwii/bun-ewwii.d.ts
```

Example `~/.config/ewwii/tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022",
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["*.ts", "*.js", "*.d.ts"]
}
```

For a JavaScript config, add `"allowJs": true` and `"checkJs": true` as needed.
`allowImportingTsExtensions` is only needed when your imports explicitly end in
`.ts` (for example `import { helper } from "./lib/helper.ts"`). Local imports
work at runtime either way; the option only affects `tsc`.
Remove any old `jscore.d.ts` so the `ewwii/*` module declarations do not collide.
The declarations are named `bun-ewwii.d.ts` in the config directory to avoid
colliding with `ewwii.ts`/`ewwii.js`.

## Widget API

```js
import * as Widgets from "ewwii/widgets";

const box = Widgets.Box()
  .properties({ widget_name: "root", orientation: "v" })
  .add_child(Widgets.Label("hello"));

const win = Widgets.register(Widgets.Window("demo").add_child(box));
```

`Widgets.register(window)` returns a `WindowHandle` extending
`LiveWidgetHandle`, scoped to the window's root child:

```js
win.append_child(Widgets.Label("added"));
win.find("widget_name").set_property("text", "updated");
win.window; // original Window Widget
win.name;   // "demo"
win.root;   // same handle as win
```

Supported widgets include `Box`, `FlowBox`, `Expander`, `Revealer`, `Scroll`,
`OverLay`, `Stack`, `EventBox`, `ToolTip`, `AspectFrame`, `Animation`, `Label`,
`Button`, `Image`, `Input`, `Progress`, `ComboBoxText`, `Scale`, `Checkbox`,
`Calendar`, `ColorButton`, `ColorChooser`, `CircularProgress`, `Graph`,
`Transform`, `GtkUI`, `Custom`, `Script`, `Poll`, `Listen`, and `Window`.

## Live handles

```js
/** @param {WidgetAPI} api */
export function after_render(api) {
  const list = api.find("list");

  list.set_property("spacing", 4);
  list.add_classes("accent", "large").remove_class("large");

  const child = Widgets.Label("dynamic").properties({ widget_name: "dynamic" });
  list.append_child(child);

  setTimeout(() => list.remove_child("dynamic"), 2000);
}
```

`LiveWidgetHandle` methods:

```ts
set_property(key, value)
add_class(name)
add_classes(...names)
remove_class(name)
remove_classes(...names)
append_child(child)
insert_child(index, child)
remove_child(childOrName)
replace_children(children)
clear_children()
child_names()
children()
```

Property and class updates are applied live. Structural changes rebuild the
affected window instance (or every instance for definition-level changes);
expect a brief rebuild and make structural changes sparingly.

## Multiple window instances / per-monitor bars

The host is now instance-aware. You can open the same window definition multiple
times:

```sh
ewwii open bar --id bar_0 --screen 0
ewwii open bar --id bar_1 --screen 1
```

Each instance has its own GTK widget registry, so property/class updates can be
targeted independently.

### `on_mount` gets instance info

```js
const label = Widgets.Label("waiting")
  .properties({ widget_name: "status" })
  .on_mount((handle, info) => {
    // info.instanceId -> "bar_0", "bar_1", ...
    // info.windowName -> "bar"
    // info.screen     -> 0 (numeric monitor selector, or null)
    // info.monitor    -> "0" / "eDP-1" / ...
    console.log("mounted", info.instanceId, info.screen);

    // This handle targets this instance only.
    handle.set_property("text", "mounted on " + info.instanceId);
  });
```

`on_mount` fires once per widget per window-instance initialization. On a window
rebuild/reload, closed instances are forgotten and their mount callbacks run
again for the rebuilt instances.

The context also contains `windowName`, `widgetName`, `dynId`, `window`, and
`widget`.

### Instance-scoped handles

```js
export function after_render(api) {
  // After windows are open:
  const forBar0 = api.find("status", "bar_0");
  const forBar1 = api.find("status", "bar_1");

  forBar0.set_property("text", "left monitor");
  forBar1.set_property("text", "right monitor");

  // Or:
  const win = Widgets.register(Widgets.Window("bar").add_child(box));
  win.forInstance("bar_0").set_property("text", "left");
}
```

`api.instances()` returns the currently initialized instances:

```js
[
  { instanceId: "bar_0", windowName: "bar", monitor: "0", screen: 0 },
  { instanceId: "bar_1", windowName: "bar", monitor: "1", screen: 1 },
]
```

CLI widget control also accepts `--instance` / `-i`:

```sh
ewwii widget-control property-get -w status text -i bar_0
ewwii widget-control add-class -w status active -i bar_1
```

### Structural changes: definition vs instance

Structural methods are instance-aware when invoked through an instance handle:

```js
.on_mount((handle, info) => {
  if (info.instanceId === "bar_1") {
    handle.append_child(Widgets.Label("right only"));
  }
});

// Later:
win.forInstance("bar_0").remove_child("some-child");
api.find("root", "bar_1").clear_children();
```

- **Instance handle** (`on_mount`, `api.find(name, instanceId)`,
  `win.forInstance(id)`): mutates only that instance's tree and rebuilds only
  that instance.
- **Definition handle** (`Widget.add_child` on the shared tree,
  `win.append_child`, `api.find(name)` where only one instance exists): mutates
  the shared window definition and reloads every instance.

Reactive variables are still global to the ewwii daemon, not per instance.

## `on_mount`

```js
const label = Widgets.Label("loading")
  .properties({ widget_name: "status" })
  .on_mount((handle, info) => {
    handle.set_property("text", "mounted");
  });

Widgets.register(Widgets.Window("demo").add_child(label));
```

- Runs after the window instance has been built, so handle operations are safe.
- Runs once per unmounted → mounted transition per instance.
- `off_mount(callback)` removes a callback.
- Does not run while no window is open; it waits for the next init.

## Reactive variables

`ewwii update` and `ewwii state` use the same global variable store:

```js
import * as Widgets from "ewwii/widgets";
// Or: import { variable } from "ewwii/reactive";

const volume = Widgets.variable("volume", "0");

volume.on_change((value) => {
  console.log("volume:", value);
});

volume.set(42);
volume.value = "43";
```

```sh
ewwii update 'volume=42'
ewwii state
```

Values are strings. `.set()` updates locally and broadcasts; external updates
arrive asynchronously. `variable(name)` without an initial value preserves an
existing value. Values survive config reloads while the daemon runs.

Bind a variable to a widget:

```js
const win = Widgets.register(Widgets.Window("demo").add_child(list));
const volume = Widgets.variable("volume", "0");

volume.bind(win.find("volume-label"), "text");
// Per instance:
volume.bind(win.find("volume-label", "bar_0"), "text");
```

## Tools

```js
import * as Tools from "ewwii/tools";

await Tools.cmd.run("notify-send hi");
const output = await Tools.cmd.run_read("echo hi");
Tools.cmd.listen("pactl subscribe", (line) => console.log(line));

await Tools.fs.write("note.txt", "hello");
console.log(await Tools.fs.read("note.txt"));

const timer = Tools.stream.time(({ iso, string }) => console.log(iso, string));
timer.stop();
```

`cmd.*` uses `sh -c` via `Bun.spawn`; `fs.*` uses `node:fs/promises`;
`stream.time` uses timers; `stream.volume` uses PulseAudio/PipeWire polling.

## npm packages

```sh
cd ~/.config/ewwii && bun add lodash
```

```js
import lodash from "lodash";
console.log(lodash.chunk([1, 2, 3, 4], 2));
```

## Plugin API changes

The plugin API is now **2.0.0**:

- Nbcl-specific registration APIs (`register_function`, `register_library`,
  `inject_nbcl_bootstrap`) and types (`NbclType`, `PluginValue`,
  `LibraryItem`, `NativeFn`) were removed.
- `WidgetControlType` is instance-aware. Widget-targeted operations carry an
  optional `instance: Option<String>`.
- `IpcRequest::HotReload` and `IpcRequest::PathInfo` are present; hot reload is
  currently treated as a full reload in this fork.
- Custom plugin configuration engines can still replace the built-in Bun engine
  via `register_config_engine`, but Bun is initialized by default.

Existing compiled plugins must be rebuilt against API 2.0.0.

## Footguns and limitations

- Do not write directly to `process.stdout`; it is the Bun bridge protocol.
  Use `console.*`.
- Do not `await` a long-running command at module top level; module evaluation
  blocks the initial parse. Start long work in `after_render`.
- Structural changes rebuild windows. High-frequency child churn is expensive.
- With multiple instances of a window, `api.find(name)` without an instance id
  fails as ambiguous. Use `on_mount` or pass an instance id.
- Per-instance structural overrides live in memory. A config reload or daemon
  restart rebuilds instances from their window definitions.
- A real `node_modules/ewwii` package would shadow the built-in virtual modules.

## Development

```sh
cargo test
bun test
cargo build --release -p ewwii
```

For an isolated end-to-end test:

```sh
CFG=$(mktemp -d)
cp /path/to/ewwii.ts "$CFG/ewwii.ts"
printf '* {}\n' > "$CFG/ewwii.scss"
target/release/ewwii -c "$CFG" daemon --no-daemonize --debug
target/release/ewwii -c "$CFG" open demo
target/release/ewwii -c "$CFG" debug
target/release/ewwii -c "$CFG" kill
```
