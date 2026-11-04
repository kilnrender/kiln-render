# Shots

Clips for `bun run capture scripts/shots/<shot>.json`. Camera paths are first guesses: fly to a better view, press Share and paste its `cam=` value.

| Shot | Shows | Angle |
|------|-------|-------|
| `kingsnake-refine` | Cold load, real time | 795 MB CT, sharp in seconds, nothing downloaded up front |
| `woodbranch-lod` | Cold load of 16 GB, LOD colours, real time | Which level each brick streams at; for graphics people |
| `woodbranch-dive` | Zoom from overview into fine detail | 16 GB µCT, every frame at full resolution in the browser |
| `chameleon-turntable` | Plain DVR | Baseline for the shading comparison |
| `chameleon-shaded` | Gradient shading and boundaries | Same view with lighting; see side by side below |
| `pawpawsaurus-turntable` | Isosurface | Dinosaur skull; broad audience |
| `backpack-turntable` | DVR, coolwarm | What's inside a backpack; broad audience |
| `vibrio-turntable` | Cryo-ET, float32, clipped | Cryo-ET in the browser; image.sc |
| `fly-brain-turntable` | 4-channel MIP, 1920 × 1920 × 752 | Multichannel fluorescence; image.sc |

Side by side (shading off / on):

```
ffmpeg -i captures/chameleon-turntable.mp4 -i captures/chameleon-shaded.mp4 \
  -filter_complex hstack -c:v libx264 -crf 16 -pix_fmt yuv420p captures/chameleon-shading.mp4
```
