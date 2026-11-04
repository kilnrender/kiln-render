# Shots

Clips for `bun run capture scripts/shots/<shot>.json`; the format is in `scripts/capture.ts`. Camera views and setting values are first guesses: tune them in the viewer, press Share and copy the values over.

| Shot | Shows | Angle |
|------|-------|-------|
| `woodbranch-dive` | Zoom into 16 GB while bricks refine, then LOD colours | Hero: only what's in view is streamed |
| `kingsnake-refine` | Cold load in real time, bytes streamed on screen | 795 MB CT, sharp in seconds |
| `chameleon-shading` | Shading eases in mid-turn | Before and after in one clip |
| `chameleon-cutaway` | A clip plane slides through | Look inside |
| `kingsnake-slices` | A slice sweeps through the volume | Slices at full resolution |
| `fly-brain-channels` | Four channels fade in one by one | Multichannel fluorescence; image.sc |
| `vibrio-turntable` | Cryo-ET, float32, clipped | Cryo-ET in the browser; image.sc |
| `pawpawsaurus-turntable` | Isosurface | Dinosaur skull; broad audience |
| `backpack-turntable` | DVR, coolwarm | What's inside a backpack; broad audience |
| `chameleon-turntable` | Plain turntable | The minimal shot |

Time series: `{ "at": 0, "until": 10, "set": { "timepoint": 20 } }` plays timepoints 0–20.
