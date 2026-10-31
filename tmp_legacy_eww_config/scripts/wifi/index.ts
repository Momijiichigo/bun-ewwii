#!/usr/bin/bun run
import {$} from "bun";
import {getEssid, getWifiIconColor, getWifiStatusIcon} from "./utils.ts";
import type {Connectivity} from "./utils.ts";
import {Some, None, Option} from "rusty-enums"

const arg = Bun.argv[2];
switch (arg) {
  case "main":
    await mainLoop();
    break;
  case "essid":
    console.log(await getEssid())
    break;
  case "icon":
    console.log(await getWifiStatusIcon())
    break;
  case "icon-color":
    console.log(await getWifiIconColor(None))
    break;
  default:
    break;
}
// ps o command | grep -qE '[/ \w]+\.config/eww/scripts/wifi/index\.ts main'
//
async function mainLoop() {
  const foundProcess = await $`ps o command | rg '[/ \w]+\.config/eww/scripts/wifi/index\.ts main'`
    .nothrow()
    .text();
  console.log("foundProcess:", foundProcess)
  const processNotRunning = foundProcess.trim().split('\n').length < 2;
  console.log("processNotRunning", processNotRunning)
  if (processNotRunning) {
    const proc = Bun.spawn(["nmcli", "monitor"])
    const reader = proc.stdout.getReader();

    const decoder = new TextDecoder();

    let done = false;
    while (!done) {
      const {value, done: d} = await reader.read()
      done = d;
      const text = decoder.decode(value);
      console.log(text)

      await handleLogMessage(text);

    }
  }
}

async function handleLogMessage(text: string) {
  // Example: Connectivity is now 'full'
  const connectivity = text
    .match(
      /Connectivity is now '(?<status>\w+)'/
    )
    ?.groups
    ?.status as Connectivity | undefined;
  if (connectivity) {
    let wifiIcon = ""
    switch (connectivity) {
      case "full":
        wifiIcon = "󰤨";
        break;
      case "limited":
        wifiIcon = "󰤠";
        break;
      default:
        wifiIcon = "󰤯";
        break;
    }
    console.log(wifiIcon)
    $`eww update WLAN_ICON="${wifiIcon}"`.text();
    $`eww update ESSID_WLAN="${await getEssid()}"`.text();
    $`eww update WLAN_ICON_COLOR="${
      await getWifiIconColor(Some(connectivity))
    }"`.text();
  }


}


