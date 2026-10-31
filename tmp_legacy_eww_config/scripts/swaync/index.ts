#!/usr/bin/bun run
import {$} from "bun";
import {Some, None, Option} from "rusty-enums"

const arg = Bun.argv[2];
switch (arg) {
  case "main":
    await mainLoop();
    break;
  default:
    break;
}
// ps o command | grep -qE '[/ \w]+\.config/eww/scripts/wifi/index\.ts main'
//
async function mainLoop() {
  const foundProcess = await $`ps o command | rg '[/ \w]+\.config/eww/scripts/swaync/index\.ts main'`
    .nothrow()
    .text();
  console.log("foundProcess:", foundProcess)
  const processNotRunning = foundProcess.trim().split('\n').length < 2;
  console.log("processNotRunning", processNotRunning)
  if (processNotRunning) {
    // swaync-client --subscribe
    const proc = Bun.spawn(["swaync-client", "--subscribe"])
    const reader = proc.stdout.getReader();

    const decoder = new TextDecoder();

    let done = false;
    while (!done) {
      const {value, done: d} = await reader.read()
      done = d;
      const text = decoder.decode(value);
      console.log(text)

      await handleLogMessage(JSON.parse(text));

    }
  }
}

type StatusInfo = {
  count: number,
  dnd: boolean,
  visible: boolean,
  inhibited: boolean
}
async function handleLogMessage({count, dnd, visible, inhibited}: StatusInfo) {

  let notificationIcon = ""
  let iconColor = ""
  if (dnd) {
    notificationIcon = "󰂛"
    iconColor = "#c09dd1"
  } else if (count === 0) {
    notificationIcon = "󰂚"
    iconColor = "#a1bdce"
  } else {
    notificationIcon = `󱅫 ${count}`
    iconColor = "#bcd49f"
  }
  console.log(notificationIcon)
  $`eww update NOTIFICATION_ICON="${notificationIcon}"`.text();
  $`eww update NOTIFICATION_ICON_COLOR="${iconColor}"`.text();
}

