#!/usr/bin/sh

if $(eww active-windows | rg -q 'powermenu$'); then
  eww close powermenu
  echo "close"
else
  current_monitor=$(hyprctl activeworkspace | rg 'monitorID: (.+)' -o -r '$1')
  eww open powermenu --screen $current_monitor
  echo "open"
fi
