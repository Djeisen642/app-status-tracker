# App icons

The icon set referenced by `tauri.conf.json` (`bundle.icon`). The tray reuses the
embedded window icon at runtime.

**These files are build inputs, not build outputs.** `tauri::generate_context!`
embeds them at compile time, so a missing PNG fails `cargo check` with
`failed to open icon icons/32x32.png`. They must stay committed.

## The design

A green status dot with two blue rings pinging out from it: something is being
watched. Same palette as the sibling task-tracker (the tile, the accent blue, the
"done" green) so the two read as one family, but a different shape, so they
don't blur together in a crowded tray.

The green dot is deliberate: it is the "all operational" state. When the tray
icon starts reflecting status (phase 1), the degraded, outage and unknown
variants recolor the dot and keep everything else, so the icon stays
recognizable in every state.

## Two masters, on purpose

| File             | Used for                                                     |
| ---------------- | ------------------------------------------------------------ |
| `icon.svg`       | Everything ≥48px. Two rings, the outer one faded.            |
| `icon-small.svg` | 16–32px only. One fat ring, larger dot, no faded outer ring. |

At 16px the full master's faded outer ring is a one-pixel smear and the gap
between the rings closes up. The small master is the _same_ icon with detail
dropped and shapes fattened. Keep the two in sync when the design changes.

> Verify this rather than trusting it. Render both at 16/24/32px and view them
> magnified with `image-rendering: pixelated` before committing. Judging a tray
> icon from the 512px artboard is how you ship a smudge.

| Output           | Size      | Rendered from    | Used for                           |
| ---------------- | --------- | ---------------- | ---------------------------------- |
| `32x32.png`      | 32×32     | `icon-small.svg` | Windows window/tray icon           |
| `128x128.png`    | 128×128   | `icon.svg`       | Linux window icon                  |
| `128x128@2x.png` | 256×256   | `icon.svg`       | HiDPI                              |
| `icon.png`       | 1024×1024 | `icon.svg`       | Default icon + `tauri icon` source |
| `icon.ico`       | multi     | both             | Windows executable/installer       |
| `icon.icns`      | multi     | `icon.svg`       | macOS bundle                       |

## Regenerating

```bash
# From the project root: `tauri icon` crashes if run from inside this folder.
rsvg-convert -w 1024 -h 1024 src-tauri/icons/icon.svg -o src-tauri/icons/icon.png
pnpm tauri icon src-tauri/icons/icon.png
```

`tauri icon` rasterizes **every** platform format from that one source, which
means it overwrites the hand-tuned small art and scatters assets this desktop
app never ships. Always follow it with:

```bash
cd src-tauri/icons
rm -rf android ios 64x64.png Square*.png StoreLogo.png     # unused Appx/mobile assets

# Restore the hand-tuned sizes that `tauri icon` just clobbered.
rsvg-convert -w 32   -h 32   icon-small.svg -o 32x32.png
rsvg-convert -w 128  -h 128  icon.svg       -o 128x128.png
rsvg-convert -w 256  -h 256  icon.svg       -o '128x128@2x.png'
rsvg-convert -w 1024 -h 1024 icon.svg       -o icon.png
```

### The `.ico`

`tauri icon` derives every sub-size in the `.ico` from the single detailed
source, so its 16 and 32px entries get the blurry art, which is exactly the entry
Windows shows in the taskbar. Assemble it from per-size PNGs instead, small
master for the small entries.

Check the entry count afterwards. `png-to-ico` has silently dropped sizes here
(seven PNGs in, four entries out), so the current file was written with a few
lines of Python that pack the PNGs into ICO entries directly:

```bash
for s in 16 24 32; do rsvg-convert -w $s -h $s icon-small.svg -o /tmp/$s.png; done
for s in 48 64 128 256; do rsvg-convert -w $s -h $s icon.svg -o /tmp/$s.png; done
python3 - <<'PY'
import struct
sizes = [16, 24, 32, 48, 64, 128, 256]
blobs = [open(f'/tmp/{s}.png', 'rb').read() for s in sizes]
head = struct.pack('<HHH', 0, 1, len(sizes))
offset, body = 6 + 16 * len(sizes), b''
for size, blob in zip(sizes, blobs):
    head += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(blob), offset)
    offset += len(blob)
    body += blob
open('icon.ico', 'wb').write(head + body)
PY
```

Keep `icon.icns` from `tauri icon`; macOS's small entries aren't worth
hand-tuning until the app has been run there.

## Rasterizer notes

- An `objectBoundingBox` gradient collapses on any shape with a zero-width or
  zero-height bounding box and silently renders black. Both masters use
  `gradientUnits="userSpaceOnUse"`.
- Headless-Chromium screenshots come out blank below roughly a 200px viewport;
  use a real rasterizer (`rsvg-convert`) for the small sizes.
