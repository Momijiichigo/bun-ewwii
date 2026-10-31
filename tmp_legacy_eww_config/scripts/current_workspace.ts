#!/usr/bin/bun run

import {$} from "bun";

export async function getCurrentWorkspace() {
  const windowInfo: WindowInfo = await $`hyprctl activewindow -j`
    .json()
    .catch(() => ({workspace: {id: 0, name: ""}}))

  type WindowInfo = {
    workspace: {
      id: number,
      name: string,
    }
  }
  return windowInfo?.workspace?.id ?? 0
}

export async function setEwwVar() {
  $`eww update current_workspace="${await getCurrentWorkspace()}"`
    .nothrow()
    .text()
}
const arg = Bun.argv[2];

switch (arg) {
  case "print": {
    console.log(
      getCurrentWorkspace()
    )
    break;
  }
  case "setEwwVar": {
    setEwwVar()
    break;
  }
  default:
    break;
}
