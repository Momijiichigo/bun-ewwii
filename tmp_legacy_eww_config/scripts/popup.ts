#!/usr/bin/bun run

import {$} from 'bun'

const POPUP_NAMES = ['calendar', 'system', 'music_win', 'audio_ctl']



type PopupName = typeof POPUP_NAMES[number]

async function close(popupName: PopupName, closeOthers = false) {
  const activeWindows = (await $`eww active-windows`.text())
    .trim()
    .split('\n')
    .map(s => s.split(':')[0])

  console.log('Active windows:', activeWindows)
  if (activeWindows.includes(popupName)) {
    await $`eww close ${popupName}`.nothrow().text()
  }
  if (closeOthers) {
    const otherActivePopups = activeWindows
    .filter(id => POPUP_NAMES.includes(id))
    if (otherActivePopups.length !== 0) {
      await $`eww close ${
        otherActivePopups.join(' ')
      }`.nothrow().text()
    }
  }
}
async function open(popupName: PopupName) {
  const currentMonitor = await $`hyprctl activeworkspace | rg 'monitorID: (.+)' -o -r '$1'`
    .text()
    .then(s => s.trim())

  console.log('current monitor:', currentMonitor)

  await $`eww open --screen ${currentMonitor} ${popupName}`
    .text()
    .catch(console.error)
}

const reqCmd = Bun.argv[2]
const reqPopupName = Bun.argv[3]

if (POPUP_NAMES.includes(reqPopupName)) {
  switch (reqCmd) {
    case "open":
      await open(reqPopupName)
      break;
    case "close":
      await close(reqPopupName)
      break;
    default:
      console.error(`Invalid subcommand: ${reqCmd}`)
      break;
  }
} else {
  console.error(`Invalid popup name: ${reqPopupName}`)
}


