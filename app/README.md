# Kraken Host — the carousel without NZXT CAM

NZXT CAM fights with other RGB software (like SignalRGB) over the cooler. Kraken Host replaces the one
part of CAM this project needs: it puts the carousel on the Kraken's screen, with live temperatures.

It is **display only**. It never touches pump speed, fan speed or lighting — use whatever software you
like for those (SignalRGB, FanControl, liquidctl, the BIOS…). With CAM closed and nothing else
controlling it, the Kraken's own firmware runs the pump at 100%, which is safe.

- Renders `../index.html` (the same page CAM would show) and streams it to the screen at ~30 fps
- Everything from the editor keeps working: playlist, overlays, the Cooler remote controls, NSFW switch
- Shows CPU / GPU temperature and load, and the liquid temperature from the Kraken itself
- Sits in the tray, starts with Windows, reconnects after sleep, and steps aside if CAM is running

## Requirements

- Windows 10/11 and an **NZXT Kraken Elite (2023)** — the 640×640 model. Other Kraken LCD models use
  the same protocol but haven't been tested; they are not enabled yet.
- [Node.js](https://nodejs.org) 20 or newer
- [.NET 8 SDK](https://dotnet.microsoft.com/download) — to build the small sensor helper
- Optional, for **CPU temperature**: the [PawnIO](https://github.com/namazso/PawnIO.Setup/releases)
  driver. Without it the CPU temperature shows "–" and everything else still works.

## Setup

Open a terminal in this `app` folder:

```
npm install
npm run build-sensors
```

Then:

1. **Close NZXT CAM**, and in CAM's settings turn off starting with Windows. (CAM and Kraken Host can't
   both drive the screen. If CAM does start, Kraken Host simply waits until it's closed again.)
2. **Start Kraken Host with Windows:**

   ```
   npm run install-startup
   ```

   Approve the UAC prompt once. This creates a Task Scheduler entry that starts Kraken Host at login with
   admin rights (needed for the CPU temperature) without asking every time, and starts it right away.

To just try it without installing anything: `npm start` (the CPU temperature needs it to run as admin).

To remove it from startup: `npm run uninstall-startup`, then turn CAM's startup back on if you want CAM back.

## The tray icon

Right-click it for the status line (fps and temperatures), **Open editor**, **Reload display**,
**Open log** and **Quit**. The log lives at `%APPDATA%\kraken-host\kraken-host.log`.

## Troubleshooting

- **The screen still shows CAM's content / "NZXT CAM is running" in the tray.** Close CAM; Kraken Host
  picks the screen up within a few seconds.
- **CPU temperature shows "–".** PawnIO isn't installed, or Kraken Host isn't running as admin. The
  startup task runs it as admin; `npm start` from a normal terminal doesn't.
- **Other numbers show "–".** The sensor helper isn't built: run `npm run build-sensors`.
- **Nothing on the screen after waking the PC.** It reconnects by itself within a few seconds; if not,
  use **Reload display** or restart it from the tray.

## How it works

CAM's "web integration" is a hidden Chromium window whose frames are sent to the cooler. Kraken Host
does the same with Electron:

- **Rendering:** an off-screen 640×640 Electron window loads `index.html`. Every painted frame is rotated
  to match how the cooler is mounted and compressed to [q565](https://github.com/seritools/q565) (an
  RGB565 variant of QOI), which is what the Kraken decodes.
- **Streaming** (worked out from a USB capture of CAM): `36 01 00 01 08` on the HID interface, wait for
  `37 01`, send a 20-byte header and the frame over the bulk interface, `36 02`, wait for `37 02` (the
  cooler has drawn the frame) before the next one. The only other thing it sends is a status request
  to read the liquid temperature. See `lib/kraken.js`.
- **Sensors:** `sensors/` is a small read-only .NET helper built on
  [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor); it prints one
  JSON line per second. Readings reach the page through `window.nzxt.v1.onMonitoringDataUpdate`, the
  same hook CAM uses, so the carousel doesn't know the difference.

```
main.js               tray app: off-screen page, frame streaming, sensor feed
lib/kraken.js         USB: screen streaming and reads, nothing else
lib/q565.js           frame compression + rotation
lib/sensors.js        runs the sensor helper
sensors/              the sensor helper (C#, LibreHardwareMonitorLib)
scripts/              install / uninstall the startup task
tools/stream-test.js  stand-alone test pattern for the USB layer (CAM must be closed)
```

## Credits

- [liquidctl](https://github.com/liquidctl/liquidctl) — documented the Kraken's USB protocol
- [q565](https://github.com/seritools/q565) by Dennis Duda — the image format (MIT / Apache-2.0)
- [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) and
  [PawnIO](https://github.com/namazso/PawnIO.Setup) — sensor readings
