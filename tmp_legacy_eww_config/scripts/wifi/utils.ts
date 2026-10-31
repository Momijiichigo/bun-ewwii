import {$} from "bun"
import {Some, None, Option} from "rusty-enums"
export async function getEssid() {
  return await $`nmcli connection show --active`
    .text()
    .then((text) => {
      const lines = text.split("\n")
      const essidLine = lines.find((line) => line.includes("wlp") || line.includes("wlan") )
      const nameStrLength = lines[0].indexOf("UUID")

      return essidLine?.slice(0, nameStrLength).trim() || "No Wifi Connected"
    })

}

export type Connectivity = "full" | "limited" | "none"
async function getWifiStatus() {
  const text = await $`nmcli networking connectivity`
    .text()
  return text.trim() as Connectivity
}
export async function getWifiIconColor(connectivity: Option<Connectivity>) {
  const status = connectivity.unwrap_or(await getWifiStatus())

  switch (status) {
    case "full":
      return "#a1ceb2"
    case "limited":
      return "#cccea1"
    default:
      return "#cea1a1"
  }
}

export async function getWifiStatusIcon() {
  const status = await getWifiStatus()

  switch (status) {
    case "full":
      return "󰤨"
    case "limited":
      return "󰤠"
    default:
      return "󰤯"
  }
}
