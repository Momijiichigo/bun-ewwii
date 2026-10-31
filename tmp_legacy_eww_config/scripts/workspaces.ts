#!/usr/bin/bun run

import {$} from "bun";

type Workspace = {
  "id": number,
  "name": `${number}`,
  "monitor": string,
  "monitorID": number,
  "windows": number,
  "hasfullscreen": boolean,
  "lastwindow": string,
  "lastwindowtitle": string,
}
export async function getWorkspaces() {
  const workspaces: Workspace[] = await $`hyprctl workspaces -j`
    .json()
    .catch(() => [])

  const monitorWorkspaces: number[][] = []

  workspaces.forEach(ws => {
    monitorWorkspaces[ws.monitorID] ??= []
    const workspaceList = monitorWorkspaces[ws.monitorID]
    workspaceList.push(ws.id)
    workspaceList.sort((a, b) => a - b)
  })
  return monitorWorkspaces
}

export async function setEwwVar() {
  $`eww update wspaces="${JSON.stringify(await getWorkspaces())}"`.nothrow().text()
}

const arg = Bun.argv[2];
switch (arg) {
  case "print": {
    console.log(
      getWorkspaces()
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
