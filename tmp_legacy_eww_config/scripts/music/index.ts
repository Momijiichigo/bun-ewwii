#!/usr/bin/bun run
import {$} from "bun";
import {Some, None, Option} from "rusty-enums"

const arg = Bun.argv[2];
switch (arg) {
  case "main":
    await mainLoop();
    break;
  case "json":
    console.log(await getMetadata())
    break;
  default:
    break;
}
// ps o command | grep -qE '[/ \w]+\.config/eww/scripts/wifi/index\.ts main'
//
async function mainLoop() {
  const foundProcess = await $`ps o command | rg '[/ \w]+\.config/eww/scripts/music/index\.ts main'`
    .nothrow()
    .text();
  console.log("foundProcess:", foundProcess)
  const processNotRunning = foundProcess.trim().split('\n').length < 2;
  console.log("processNotRunning", processNotRunning)
  if (processNotRunning) {
    const proc = Bun.spawn([
      "playerctl",
      "-s",
      "-a",
      "metadata",
      "--format",
      "'{{ status }} {{ xesam:title }}'",
      "-F"
    ]);
    const reader = proc.stdout.getReader();

    const decoder = new TextDecoder();

    let done = false;
    while (!done) {
      const {value, done: d} = await reader.read()
      done = d;
      const text = decoder.decode(value);
      console.log(text)

      await updateMusicMetadata()
    }
    
  }
}

async function updateMusicMetadata() {
  await sleep(100);
  const info = await getMetadata();
  $`eww update music_metadata="${JSON.stringify(info.metadata)}"`.text();
  $`eww update music_players="${JSON.stringify(info.players)}"`.text();
  const song_status_each: {
    [player: string]: string
  } = {};
  await Promise.all(info.players.map(async (player) => {
    const songStatus = await $`playerctl -s --player=${player} status`.nothrow().text();
    song_status_each[player] = songStatus.trim();
  }))
  $`eww update song_status_each="${JSON.stringify(song_status_each)}"`.text();
  // const currentMusicPlayer = await $`eww get current_music_player`.text();
  // console.log("currentMusicPlayer", currentMusicPlayer)
  // $`eww update current_music_player="${metadata.players[0]}"`.text();
}

async function getMetadata() {
  const metaObj: {
    players: string[],
    metadata: {
      [key: string]: {
        [prop: string]: string
      }
    }
  } = {
    players: [],
    metadata: {}
  }
  const metadata = $`playerctl -a metadata`
    .nothrow()
    .lines();
  for await (const line of metadata) {
    const matched = line.match(/(\w+) +([\w:]+)(?: +(.+))?$/);
    if (matched) {
      const [_, player, prop, value] = matched;
      if (!metaObj.metadata[player]) {
        metaObj.metadata[player] = {}
        metaObj.players.push(player)
      }
      metaObj.metadata[player][prop] = value.trim() || "";
    }
  }
  return metaObj;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
