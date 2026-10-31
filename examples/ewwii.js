import * as Widgets from "ewwii/widgets";
import * as Tools from "ewwii/tools";

const list = Widgets.Box().properties({
    widget_name: "list",
    orientation: "v",
    spacing: 6,
    class: "list",
});

list.add_child(Widgets.Label("Hello from Bun!").properties({ widget_name: "clock" }));
list.add_child(Widgets.Label("0").properties({ widget_name: "volume-label" }));

const windowWidget = Widgets.Window("bun-demo").properties({
    geometry: {
        x: "0%",
        y: "0%",
        width: "320px",
        height: "180px",
        anchor: "top left",
    },
    stacking: "fg",
});

windowWidget.add_child(list);

// register() returns a live handle for the window's root widget.
const win = Widgets.register(windowWidget);

// This variable is also visible to `ewwii update volume=42` / `ewwii state`.
const volume = Widgets.variable("volume", "0");
// For multi-instance windows, bind from on_mount with an instance-scoped handle.
volume.bind(win.find("volume-label"), "text");

/** @param {WidgetAPI} api */
export function after_render(api) {
    const clock = api.find("clock");

    Tools.stream.time((time) => {
        clock.set_property("text", time.string);
    });

    let dynamic;

    setTimeout(() => {
        dynamic = Widgets.Label("Dynamically added!")
            .properties({ widget_name: "dynamic-label", class: "accent" })
            .on_mount((handle, info) => {
                // info.instanceId is e.g. "bun-demo_0" when opened with --id.
                handle.set_property("text", `Mounted in ${info.instanceId}`);
            });

        win.append_child(dynamic);
    }, 1500);

    setTimeout(() => {
        if (dynamic) {
            win.remove_child(dynamic);
        }
    }, 4500);
}
