// Frutiger Aero bar — Bun/ewwii port of the legacy Eww bar.
//
// Open one instance per monitor:
//   ewwii open frutiger_bar --screen 0 --id frutiger_bar_0
//   ewwii open frutiger_bar --screen 1 --id frutiger_bar_1
//
// Popups, wallpaper widgets, systray, brightness, memory and CPU modules are
// intentionally out of scope for this first conversion.

import * as Widgets from "ewwii/widgets";
import * as Tools from "ewwii/tools";
import type { ReactiveVariable } from "ewwii/reactive";

type Wspaces = number[][];

interface HyprWorkspace {
    id?: number;
    monitorID?: number;
}

interface WorkspaceHandles {
    dot: LiveWidgetHandle;
    label: LiveWidgetHandle;
}

interface WorkspaceView {
    instanceId: string;
    screen: number;
    handle: LiveWidgetHandle;
    signature: string;
    dots: Map<number, WorkspaceHandles>;
}

interface MusicView {
    instanceId: string;
    art: LiveWidgetHandle;
    title: LiveWidgetHandle;
    reveal: LiveWidgetHandle;
    play: LiveWidgetHandle;
}

interface LabelView {
    instanceId: string;
    icon: LiveWidgetHandle;
}

interface BatteryView {
    instanceId: string;
    box: LiveWidgetHandle;
    icon: LiveWidgetHandle;
    text: LiveWidgetHandle;
}

interface NotificationView {
    instanceId: string;
    label: LiveWidgetHandle;
}

interface SwayncStatus {
    dnd?: boolean;
    count?: number;
}

interface ClockParts {
    date: string;
    weekday: string;
    hour: string;
    minute: string;
    seconds: number;
    tooltip: string;
}

interface ClockView {
    instanceId: string;
    root: LiveWidgetHandle;
    date: LiveWidgetHandle;
    weekday: LiveWidgetHandle;
    hour: LiveWidgetHandle;
    minute: LiveWidgetHandle;
    seconds: LiveWidgetHandle;
}

interface SleepView {
    instanceId: string;
    root: LiveWidgetHandle;
    label: LiveWidgetHandle;
}

// ---------------------------------------------------------------------------
// Shared variables (also usable through `ewwii update name=value`)
// ---------------------------------------------------------------------------

const wspaces = Widgets.variable("wspaces", "[[], [], [], []]");
const currentWorkspace = Widgets.variable("current_workspace", "1");
const metaPressed = Widgets.variable("meta_pressed", "false");

const dontSleep = Widgets.variable("dont_sleep", "false");
const musicReveal = Widgets.variable("music_reveal", "false");

const batteryIcons = ["󰂎", "󰁺", "󰁼", "󰁽", "󰁾", "󰁿", "󰁿", "󰂀", "󰂁", "󰂂", "󰁹"];
const batteryIconsCharging = [
    "󰢟",
    "󰢜",
    "󰂆",
    "󰂇",
    "󰂈",
    "󰢝",
    "󰂉",
    "󰢞",
    "󰂊",
    "󰂋",
    "󰂅",
];

const BLUETOOTH_ICON = "󰂯";
const BLUETOOTH_ICON_COLOR = "#8fc7f2";

const configDir = import.meta.dir;
const defaultMusicArt = `${configDir}/images/music.png`;

/** Convert an MPRIS art URL into something GTK can load. */
function artPath(url: string): string {
    if (!url) {
        return defaultMusicArt;
    }
    if (url.startsWith("file://")) {
        try {
            return decodeURIComponent(url.slice("file://".length));
        } catch {
            return url.slice("file://".length);
        }
    }
    if (/^https?:/i.test(url)) {
        // GTK's Image widget loads local files, not remote URLs.
        return defaultMusicArt;
    }
    return url;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setIfChanged(variable: ReactiveVariable, value: string): void {
    if (variable.value !== value) {
        variable.set(value);
    }
}

/** Run a shell command and return trimmed stdout (never throws). */
async function read(command: string): Promise<string> {
    try {
        return (await Tools.cmd.run_read(`${command} 2>/dev/null`)).trim();
    } catch {
        return "";
    }
}

/**
 * Find a descendant handle by widget_name, walking instance-scoped handles.
 */
function findHandle(root: LiveWidgetHandle, name: string): LiveWidgetHandle | null {
    if (root.widgetId === name) {
        return root;
    }
    for (const child of root.children()) {
        const found = findHandle(child, name);
        if (found) {
            return found;
        }
    }
    return null;
}

function parseJson<T>(value: string, fallback: T): T {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function parsedWspaces(): Wspaces {
    const value = parseJson<unknown>(wspaces.value, []);
    return Array.isArray(value) ? (value as Wspaces) : [];
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

const workspaceViews = new Map<string, WorkspaceView>();

/**
 * Update workspace dots. Only rebuild the GTK tree when the workspace list
 * changes; active/meta changes just update the existing dot classes/text.
 */
function renderWorkspaces(view: WorkspaceView): void {
    try {
        const workspaces = parsedWspaces()[view.screen] ?? [];
        const active = Number(currentWorkspace.value);
        const showNumbers = metaPressed.value === "true";
        const signature = workspaces.join(",");

        if (signature !== view.signature || view.dots.size !== workspaces.length) {
            view.handle.clear_children();
            view.dots.clear();

            for (const id of workspaces) {
                const dot = Widgets.EventBox()
                    .properties({
                        widget_name: `workspace-dot-${id}`,
                        class: `workspace-dot ${id === active ? "active" : ""}`,
                        onclick: `hyprctl dispatch 'hl.dsp.focus({ workspace = ${id} })'`,
                    })
                    .add_child(
                        Widgets.Label(showNumbers ? String(id) : " ").properties({
                            widget_name: `workspace-label-${id}`,
                        }),
                    );

                view.handle.append_child(dot);
            }

            view.signature = signature;
            for (const id of workspaces) {
                const dot = findHandle(view.handle, `workspace-dot-${id}`);
                const label = findHandle(view.handle, `workspace-label-${id}`);
                if (dot && label) {
                    view.dots.set(id, { dot, label });
                }
            }
            return;
        }

        for (const [id, handles] of view.dots) {
            handles.dot.set_property(
                "class",
                `workspace-dot ${id === active ? "active" : ""}`,
            );
            handles.label.set_property("text", showNumbers ? String(id) : " ");
        }
    } catch {
        // The window may have been closed while a variable update was in flight.
        workspaceViews.delete(view.instanceId);
    }
}

function renderAllWorkspaces(): void {
    for (const view of [...workspaceViews.values()]) {
        renderWorkspaces(view);
    }
}

wspaces.on_change(renderAllWorkspaces);
currentWorkspace.on_change(renderAllWorkspaces);
metaPressed.on_change(renderAllWorkspaces);

const workspacesWidget = Widgets.Box()
    .properties({
        widget_name: "workspaces",
        class: "works",
        orientation: "h",
        spacing: 5,
        space_evenly: false,
    })
    .on_mount((handle, info) => {
        const view = {
            instanceId: info.instanceId,
            screen: info.screen ?? 0,
            handle,
            signature: "",
            dots: new Map(),
        };
        workspaceViews.set(info.instanceId, view);
        renderWorkspaces(view);
    });

// Poll Hyprland directly so the bar also works without the old helper scripts.
async function pollHyprland(): Promise<void> {
    const workspaces = parseJson<HyprWorkspace[]>(await read("hyprctl workspaces -j"), []);
    const active = parseJson<{ id?: number }>(await read("hyprctl activeworkspace -j"), {});

    if (Array.isArray(workspaces)) {
        const maxMonitor = workspaces.reduce(
            (max, workspace) => Math.max(max, Number(workspace.monitorID ?? 0)),
            3,
        );
        const grouped: number[][] = Array.from({ length: maxMonitor + 1 }, () => []);

        for (const workspace of workspaces) {
            if (typeof workspace.id === "number" && typeof workspace.monitorID === "number") {
                grouped[workspace.monitorID].push(workspace.id);
            }
        }
        for (const list of grouped) {
            list.sort((left, right) => left - right);
        }

        setIfChanged(wspaces, JSON.stringify(grouped));
    }

    if (active && typeof active.id === "number") {
        setIfChanged(currentWorkspace, String(active.id));
    }
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

const musicViews = new Map<string, MusicView>();

function applyMusicReveal(): void {
    for (const view of [...musicViews.values()]) {
        try {
            view.reveal.set_property("reveal", musicReveal.value === "true");
        } catch {
            musicViews.delete(view.instanceId);
        }
    }
}

musicReveal.on_change(applyMusicReveal);

const musicArt = Widgets.Image(defaultMusicArt).properties({
    widget_name: "music-art",
    class: "cover_art_image",
    content_fit: "cover",
    can_shrink: true,
    image_width: 22,
    image_height: 14,
});

const musicCover = Widgets.Box()
    .properties({
        widget_name: "music-cover",
        class: "cover_art",
    })
    .add_child(musicArt)
    .add_child(Widgets.Box().properties({ class: "song_cover_art_glass" }));

const musicTitle = Widgets.Label("").properties({
    widget_name: "music-title",
    class: "song",
    limit_width: 20,
});

const musicPlayLabel = Widgets.Label("󰐊").properties({
    widget_name: "music-play",
    class: "song_btn_play-icon",
});

const musicControls = Widgets.Revealer()
    .properties({
        widget_name: "music-reveal",
        transition: "fade",
        reveal: false,
        duration: "350ms",
    })
    .add_child(
        Widgets.Box()
            .properties({ orientation: "h" })
            .add_child(
                Widgets.EventBox()
                    .properties({
                        class: "glass_block song_btn_prev",
                        onclick: "playerctl previous",
                    })
                    .add_child(Widgets.Label("")),
            )
            .add_child(
                Widgets.EventBox()
                    .properties({
                        class: "glass_block song_btn_play",
                        onclick: "playerctl play-pause",
                    })
                    .add_child(musicPlayLabel),
            )
            .add_child(
                Widgets.EventBox()
                    .properties({
                        class: "glass_block song_btn_next",
                        onclick: "playerctl next",
                    })
                    .add_child(Widgets.Label("")),
            ),
    );

const musicWidget = Widgets.EventBox()
    .properties({
        onhover: "ewwii update 'music_reveal=true'",
        onhoverlost: "ewwii update 'music_reveal=false'",
    })
    .add_child(
        Widgets.Box()
            .properties({
                widget_name: "music-module",
                class: "music_module",
                orientation: "h",
                space_evenly: false,
            })
            .add_child(
                Widgets.Box()
                    .properties({ orientation: "h", space_evenly: false })
                    .add_child(musicCover)
                    .add_child(musicTitle),
            )
            .add_child(musicControls),
    )
    .on_mount((handle, info) => {
        const art = findHandle(handle, "music-art");
        const title = findHandle(handle, "music-title");
        const reveal = findHandle(handle, "music-reveal");
        const play = findHandle(handle, "music-play");
        if (!art || !title || !reveal || !play) {
            return;
        }
        const view = { instanceId: info.instanceId, art, title, reveal, play };
        musicViews.set(info.instanceId, view);
        applyMusicReveal();
    });

async function pollMusic(): Promise<void> {
    const raw = await read(
        "playerctl -s metadata --format '{{status}}|||{{xesam:title}}|||{{mpris:artUrl}}'",
    );
    const [status = "", title = "", art = ""] = raw.split("|||");
    const artwork = artPath(art);

    for (const view of [...musicViews.values()]) {
        try {
            view.title.set_property("text", title);
            view.play.set_property("text", status === "Playing" ? "󰏤" : "󰐊");
            view.art.set_property("path", artwork);
        } catch {
            musicViews.delete(view.instanceId);
        }
    }
}

// ---------------------------------------------------------------------------
// Wi-Fi
// ---------------------------------------------------------------------------

const wifiViews = new Map<string, LabelView>();

const wifiLabel = Widgets.Label("")
    .properties({
        widget_name: "wifi-icon",
        class: "icon wifi",
        style: `color: ${"#a1ceb2"};`,
        tooltip: "Wi-Fi",
        text: "󰤨",
    })
    .on_mount((handle, info) => {
        wifiViews.set(info.instanceId, { instanceId: info.instanceId, icon: handle });
    });

const wifiWidget = Widgets.EventBox()
    .properties({
        class: "glass_block",
        style: "padding: 0px 1em;",
        onclick: "alacritty --class nmtui --command nmtui &",
    })
    .add_child(wifiLabel);

async function pollWifi(): Promise<void> {
    const connectivity = (await read("nmcli networking connectivity")) || "none";
    const essid =
        (await read(
            `nmcli -t -f NAME,TYPE connection show --active | awk -F: '$2=="802-11-wireless"{print $1; exit}'`,
        )) || "No Wifi Connected";

    let icon = "󰤯";
    let color = "#cea1a1";
    if (connectivity === "full") {
        icon = "󰤨";
        color = "#a1ceb2";
    } else if (connectivity === "limited") {
        icon = "󰤠";
        color = "#cccea1";
    }

    for (const view of [...wifiViews.values()]) {
        try {
            view.icon.set_property("text", icon);
            view.icon.set_property("style", `color: ${color};`);
            view.icon.set_property("tooltip", essid);
        } catch {
            wifiViews.delete(view.instanceId);
        }
    }
}

// ---------------------------------------------------------------------------
// Bluetooth
// ---------------------------------------------------------------------------

const bluetoothViews = new Map<string, LabelView>();

const bluetoothLabel = Widgets.Label(BLUETOOTH_ICON)
    .properties({
        widget_name: "bluetooth-icon",
        class: "icon bluetooth",
        style: `color: ${BLUETOOTH_ICON_COLOR};`,
        text: BLUETOOTH_ICON,
        tooltip: "No device connected",
    })
    .on_mount((handle, info) => {
        bluetoothViews.set(info.instanceId, { instanceId: info.instanceId, icon: handle });
    });

const bluetoothWidget = Widgets.EventBox()
    .properties({
        class: "glass_block",
        style: "padding: 0px 1em;",
        onclick: "rfkill unblock bluetooth && alacritty --class float --command bluetuith &",
    })
    .add_child(bluetoothLabel);

async function pollBluetooth(): Promise<void> {
    const device =
        (await read(
            "bluetoothctl devices Connected | sed -n 's/^Device [0-9A-F:]* //p' | head -n1",
        )) || "No device connected";

    for (const view of [...bluetoothViews.values()]) {
        try {
            view.icon.set_property("tooltip", device);
        } catch {
            bluetoothViews.delete(view.instanceId);
        }
    }
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

const batteryViews = new Map<string, BatteryView>();

const batteryIconLabel = Widgets.Label("󰁹").properties({
    widget_name: "battery-icon",
    class: "iconbat",
    show_truncated: false,
    wrap: false,
});

const batteryTextLabel = Widgets.Label("--%").properties({
    widget_name: "battery-text",
});

const batteryBox = Widgets.Box()
    .properties({
        widget_name: "battery-module",
        class: "bat_module",
        vexpand: false,
        hexpand: false,
        tooltip: "Battery",
    })
    .add_child(batteryIconLabel)
    .add_child(batteryTextLabel)
    .on_mount((handle, info) => {
        const icon = findHandle(handle, "battery-icon");
        const text = findHandle(handle, "battery-text");
        if (!icon || !text) return;
        batteryViews.set(info.instanceId, {
            instanceId: info.instanceId,
            box: handle,
            icon,
            text,
        });
    });

async function pollBattery(): Promise<void> {
    const capacity = Number(await read("cat /sys/class/power_supply/BAT0/capacity")) || 0;
    const status =
        (await read("cat /sys/class/power_supply/BAT0/status")) || "Unknown";

    // Preserve the legacy mapping (79% displayed as 100%).
    const normalized = Math.round(capacity / 0.79);
    const index = Math.min(
        10,
        Math.max(0, Math.round(Math.round(normalized) / 10)),
    );
    const icons = status === "Charging" ? batteryIconsCharging : batteryIcons;
    const icon = icons[index] ?? icons[10];
    const color = normalized < 20 ? "#fc8665" : "#dae6cf";

    for (const view of [...batteryViews.values()]) {
        try {
            view.box.set_property("tooltip", status);
            view.box.set_property("style", `color: ${color};`);
            view.icon.set_property("text", icon);
            view.text.set_property("text", `${normalized}%`);
        } catch {
            batteryViews.delete(view.instanceId);
        }
    }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

let notificationIcon = "󰂚";
let notificationColor = "#a1bdce";

const notificationViews = new Map<string, NotificationView>();

function applyNotificationView(): void {
    for (const view of [...notificationViews.values()]) {
        try {
            view.label.set_property("text", notificationIcon);
            view.label.set_property("style", `color: ${notificationColor};`);
        } catch {
            notificationViews.delete(view.instanceId);
        }
    }
}

const notificationLabel = Widgets.Label(notificationIcon)
    .properties({
        widget_name: "notification-icon",
        class: "module-notification",
        style: `color: ${notificationColor};`,
        text: notificationIcon,
    })
    .on_mount((handle, info) => {
        notificationViews.set(info.instanceId, { instanceId: info.instanceId, label: handle });
        applyNotificationView();
    });

const notificationWidget = Widgets.EventBox()
    .properties({
        class: "glass_block",
        onclick: "swaync-client -rs && swaync-client -R && swaync-client -op",
    })
    .add_child(notificationLabel);

Tools.cmd.listen("swaync-client --subscribe", (line) => {
    const status = parseJson<SwayncStatus | null>(line, null);
    if (!status) return;

    if (status.dnd) {
        notificationIcon = "󰂛";
        notificationColor = "#c09dd1";
    } else if (status.count === 0) {
        notificationIcon = "󰂚";
        notificationColor = "#a1bdce";
    } else {
        notificationIcon = `󱅫 ${status.count}`;
        notificationColor = "#bcd49f";
    }
    applyNotificationView();
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

const clockViews = new Map<string, ClockView>();

function clockParts(date: Date): ClockParts {
    return {
        date: `${pad2(date.getDate())}-${pad2(date.getMonth() + 1)}`,
        weekday: date.toLocaleDateString(undefined, { weekday: "short" }),
        hour: pad2(date.getHours()),
        minute: pad2(date.getMinutes()),
        seconds: date.getSeconds(),
        tooltip: date.toLocaleDateString(undefined, {
            day: "2-digit",
            month: "short",
            year: "numeric",
        }),
    };
}

function applyClockView(view: ClockView, date: Date): void {
    const parts = clockParts(date);
    try {
        view.date.set_property("text", parts.date);
        view.weekday.set_property("text", parts.weekday);
        view.hour.set_property("text", parts.hour);
        view.minute.set_property("text", parts.minute);
        view.seconds.set_property("value", parts.seconds);
        view.root.set_property("tooltip", parts.tooltip);
    } catch {
        clockViews.delete(view.instanceId);
    }
}

const clockDate = Widgets.Label("").properties({
    widget_name: "clock-date",
    class: "clock_date",
});
const clockWeekday = Widgets.Label("").properties({
    widget_name: "clock-weekday",
    class: "weekday",
});
const clockHour = Widgets.Label("").properties({
    widget_name: "clock-hour",
    class: "clock_hour_class",
});
const clockSeconds = Widgets.Scale().properties({
    widget_name: "clock-seconds",
    class: "time-progress",
    value: 0,
    max: 60,
    round_digits: 0,
    orientation: "v",
    flipped: true,
});
const clockMinute = Widgets.Label("").properties({
    widget_name: "clock-minute",
    class: "clock_minute_class",
});

const clockWidget = Widgets.Box()
    .properties({
        widget_name: "clock-module",
        class: "module clock_module",
        space_evenly: false,
        orientation: "h",
        tooltip: "",
    })
    .add_child(clockDate)
    .add_child(clockWeekday)
    .add_child(clockHour)
    .add_child(clockSeconds)
    .add_child(clockMinute)
    .on_mount((handle, info) => {
        const date = findHandle(handle, "clock-date");
        const weekday = findHandle(handle, "clock-weekday");
        const hour = findHandle(handle, "clock-hour");
        const minute = findHandle(handle, "clock-minute");
        const seconds = findHandle(handle, "clock-seconds");
        if (!date || !weekday || !hour || !minute || !seconds) return;
        const view = {
            instanceId: info.instanceId,
            root: handle,
            date,
            weekday,
            hour,
            minute,
            seconds,
        };
        clockViews.set(info.instanceId, view);
        applyClockView(view, new Date());
    });

Tools.stream.time((context) => {
    for (const view of [...clockViews.values()]) {
        applyClockView(view, context.date);
    }
}, 1000);

// ---------------------------------------------------------------------------
// Sleep blocker
// ---------------------------------------------------------------------------

const sleepViews = new Map<string, SleepView>();

function applySleepViews(): void {
    const active = dontSleep.value === "true";
    for (const view of [...sleepViews.values()]) {
        try {
            view.root.set_property(
                "class",
                `glass_block sleep_block_button ${active ? "dont_sleep" : "allow_sleep"}`,
            );
            view.label.set_property("text", active ? "󰒳 " : "󰒲 ");
            view.label.set_property(
                "tooltip",
                active ? "Don't allow system to sleep" : "Allow system to sleep",
            );
        } catch {
            sleepViews.delete(view.instanceId);
        }
    }
}

dontSleep.on_change(applySleepViews);

const sleepLabel = Widgets.Label(dontSleep.value === "true" ? "󰒳 " : "󰒲 ")
    .properties({
        widget_name: "dont-sleep-label",
        tooltip: "Allow system to sleep",
    });

const sleepWidget = Widgets.EventBox()
    .properties({
        widget_name: "dont-sleep-button",
        class: "glass_block sleep_block_button allow_sleep",
        onclick: "ewwii update 'dont_sleep=true'",
        onrightclick: "ewwii update 'dont_sleep=false'",
    })
    .add_child(sleepLabel)
    .on_mount((handle, info) => {
        const label = findHandle(handle, "dont-sleep-label");
        if (!label) return;
        sleepViews.set(info.instanceId, { instanceId: info.instanceId, root: handle, label });
        applySleepViews();
    });

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const left = Widgets.Box()
    .properties({
        orientation: "h",
        space_evenly: false,
        halign: "start",
        class: "left_modules",
    })
    .add_child(workspacesWidget);

const center = Widgets.Box()
    .properties({
        orientation: "h",
        space_evenly: false,
        halign: "center",
        class: "center_modules",
    })
    .add_child(musicWidget);

const right = Widgets.Box()
    .properties({
        orientation: "h",
        space_evenly: false,
        halign: "end",
        class: "right_modules",
    })
    .add_child(bluetoothWidget)
    .add_child(wifiWidget)
    // systray is not implemented by ewwii
    .add_child(sleepWidget)
    .add_child(
        Widgets.Box()
            .properties({
                class: "glass_block",
                style: "padding: 0px 1em;",
                halign: "end",
            })
            .add_child(batteryBox),
    )
    .add_child(notificationWidget)
    .add_child(
        Widgets.Box()
            .properties({ class: "glass_block" })
            .add_child(clockWidget),
    );

const bar = Widgets.Box()
    .properties({ class: "frutiger_bar", orientation: "h" })
    .add_child(left)
    .add_child(center)
    .add_child(right);

Widgets.register(
    Widgets.Window("frutiger_bar")
        .properties({
            geometry: {
                x: "0%",
                y: "0px",
                width: "100%",
                height: "10px",
                anchor: "top center",
            },
            stacking: "fg",
            windowtype: "toolbar",
            exclusive: true,
            namespace: "eww-blur",
        })
        .add_child(bar),
);

// ---------------------------------------------------------------------------
// Pollers
// ---------------------------------------------------------------------------

// Initial values.
void pollHyprland();
void pollMusic();
void pollWifi();
void pollBluetooth();
void pollBattery();

Tools.stream.time(() => {
    void pollHyprland();
    void pollMusic();
}, 1000);

Tools.stream.time(() => {
    void pollWifi();
    void pollBluetooth();
    void pollBattery();
}, 5000);

export function after_render(_api: WidgetAPI): void {
    // Pollers and variable subscriptions are set up at module load.
}
