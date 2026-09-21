# NZXT Kraken Carousel

I wanted to add more images to my NZXT cooler screen, but CAM only allows 5 presets on the carousel
function. Not only that, I can't add an image with the watch face.

<img width="1874" height="925" alt="image" src="https://github.com/user-attachments/assets/e9aaf061-6fec-4735-9829-1fbb6dbf0001" />

So this was created: a way to show as many images, GIFs and even videos as you like on the Kraken LCD, each
with its own timing and its own overlay (CPU/GPU temperatures, an analog clock, a digital clock, or
nothing), managed from a visual editor, so you never have to touch code.

- Unlimited images, GIFs and videos, each with its own duration or number of plays
- Overlays: temperatures, analog clock (with temps under the hands), digital clock, or a quad of four
  readings, per item
- Crop and zoom each item by dragging it in a round preview of the screen
- Crossfades between items, with the next one preloaded so there are no black flashes
- Remote control from the editor: previous, next, jump to an item, pause
- NSFW tagging, with a switch that hides tagged items on the cooler instantly
- Changes you save show up on the cooler by themselves; no need to restart CAM

## Requirements

- An NZXT Kraken with an LCD screen, and NZXT CAM — **or** Kraken Host instead of CAM (see below)
- **Chrome or Edge** for the editor (it saves straight into the folder; Firefox can only download the playlist)

### Without NZXT CAM

CAM conflicts with other RGB software such as SignalRGB. The `app/` folder contains **Kraken Host**, a
small tray app that shows this carousel on the Kraken's screen without CAM, with live CPU, GPU and liquid
temperatures. It's display only: pump, fans and lighting are left to whatever software you use. Tested on
the Kraken Elite (2023); the other Kraken LCD models are enabled on a best-effort basis. Setup takes a few
commands — see [app/README.md](app/README.md).

## Setup

1. **Get the files.** Clone the repo, or use **Code → Download ZIP** and unzip it. Put the folder somewhere
   permanent, such as Documents: CAM loads the files from there every time.
2. **Open the editor.** Double-click `editor.html`, or drag it into Chrome or Edge.
3. **Connect the folder.** Click **Connect folder** in the top bar and pick this folder (the one with
   `index.html` in it). Allow the browser to edit files when it asks. You only do this once; on later
   visits you might need to click **Reconnect**.
4. **Add media.** Click **Add media**, or drag images and videos from Explorer onto the playlist. They are
   copied into a `media/` folder for you.
5. **Save** with the button or `Ctrl+S`. This writes `config.js`, your playlist.
6. **Point CAM at it.** Open `index.html` in your browser and copy the address from the address bar (it
   starts with `file:///`). In NZXT CAM, open your Kraken's LCD settings, choose **Web Integration**, and
   paste that address.

From then on, keep the editor open while you tweak things: the cooler picks up saved changes within about
15 seconds.

## Using the editor

**Playlist (left).** Drag rows to reorder them, or press `Alt + ↑/↓`. Use the eye icon to skip an item
without deleting it. Ctrl/Shift-click selects several rows so you can change them all at once. Files in
`media/` that aren't in the playlist are listed at the bottom, ready to add.

**Preview (centre).** Shows exactly what the cooler shows, overlay included. Drag the picture to reposition
it, scroll to zoom, double-click to reset. **Play playlist** runs the real carousel in the preview; tick
**Quick** to cap every item at 4 seconds.

**Item tab (right):**

- How long an image or GIF stays up, or how many times a video plays
- Fill or fit, zoom, and focus point
- Overlay: none, temps, clock, digital or quad, plus how much to dim the picture behind it and an optional text color
- NSFW tag, and whether the item is in the rotation at all
- Rename the file (pencil icon, `F2`, or double-click a name). This renames the actual file in `media/`.

**Display settings tab:**

- Title text, which two sensors to show (CPU, GPU or liquid temperature, CPU or GPU load), and °C/°F
- Quad overlay: which reading goes in each of its four corners
- Clock options: tick or sweep second hand, temps under the hands, 12/24h, date
- Colors, crossfade length, default image duration, and muting videos

**Cooler controls (under the preview)** act on the cooler itself, not the preview:

- **⏮ / ⏭** step through the playlist
- **Show selected** jumps to the item selected in the editor
- **‖** pauses on the current item (videos loop) until you resume
- **NSFW** shows or hides items tagged NSFW

They reach the cooler within about a second. Turning NSFW off while a tagged item is on screen takes it down
straight away. NSFW is off by default, and it stays off if anything is missing or unreadable.

**Shortcuts:** `Ctrl+S` save · `Ctrl+Z` / `Ctrl+Y` undo/redo · `Delete` remove · `Ctrl+D` duplicate ·
`F2` rename · `H` show/hide · `N` NSFW tag · `Space` play/stop · `↑/↓` select · `Alt+↑/↓` move

## Videos: use H.264

The cooler can only play **H.264** video, which is what most MP4 files are. **HEVC / H.265** videos (common
from phones and some downloads) play fine in Chrome and Edge but are skipped on the cooler, because CAM's
built-in browser can't decode them. The editor marks these with **⚠ HEVC — won't play on the cooler**.

To convert one, use HandBrake with an H.264 preset, or ffmpeg:

```
ffmpeg -i input.mp4 -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a copy -movflags +faststart output.mp4
```

The screen is 640×640, so anything above 720p only costs performance. Add `-vf scale=-2:720` to shrink it.

## Troubleshooting

- **The cooler says config.js is missing.** Open the editor, add something, and save.
- **A video never shows on the cooler.** It's almost certainly HEVC; see above.
- **Changes don't appear.** Make sure you saved, then give it up to 15 seconds. The cooler controls are
  instant but need the folder connected.
- **The editor keeps asking to reconnect.** Browsers ask again after a while, or when the folder has moved.
  Click **Reconnect**, or **Connect folder** and pick it again.
- **The cooler shows the old version after an update.** Restart CAM, or re-select the web integration, so
  it reloads the page.

## Files

```
index.html     the page NZXT CAM shows on the cooler
editor.html    the editor
css/, js/      the code shared by both
media/         your images and videos            (created by the editor, not committed)
config.js      your playlist and settings        (written by the editor, not committed)
remote.js      cooler controls and NSFW switch   (written by the editor, not committed)
```

Your media and playlist stay on your machine: `media/`, `config.js`, `config.backup.js` and `remote.js` are
listed in `.gitignore`. Every save also keeps the previous playlist as `config.backup.js`.

### config.js format

Plain JSON wrapped in one assignment, so it can be edited by hand:

```js
window.CAROUSEL_CONFIG = {
  "version": 2,
  "settings": { "title": "NZXT", "tempUnit": "C", "transitionMs": 600 },
  "items": [
    {"src":"media/clip.mp4","plays":3,"overlay":"clock","dim":40,"zoom":100,"x":50,"y":15},
    {"src":"media/pic.gif","duration":60,"overlay":"temps","dim":20,"zoom":120,"x":50,"y":50,"nsfw":true}
  ]
};
```

| field | meaning |
|---|---|
| `src` | path relative to this folder |
| `duration` | seconds on screen (images and GIFs) |
| `plays` | how many times a video plays before moving on |
| `overlay` | `none`, `temps`, `clock`, `digital` or `quad` |
| `dim` | darkening behind the overlay, 0–100 % |
| `zoom` | 100 = no zoom |
| `x`, `y` | focus point in % (0 0 = top-left), also the zoom anchor |
| `fit` | `"contain"` shows the whole picture; the default fills the screen |
| `color` | text color for this item's overlay |
| `enabled` | `false` keeps the item but skips it |
| `nsfw` | `true` hides the item on the cooler unless the NSFW switch is on |

## Coming from the old version

The original version kept the playlist in a `mediaFiles` list inside `script.js`. In the editor, open
**Display settings → Tools → Import old script.js…** and pick your old `script.js`, and the list is
converted. If you connect a folder that only has an old `script.js`, the editor offers to import it.
