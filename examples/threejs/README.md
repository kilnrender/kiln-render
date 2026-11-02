# Kiln × Three.js prototype (Kiln 0.6.1)

Open `/examples/threejs/` from the repository's Vite dev server:

```sh
bun install
bun run dev
```

The demo loads a public Beechnut OME-Zarr dataset by default. Override it with
`?dataset=<encoded-OME-Zarr-URL>`. WebGPU and a WebGL context are required.

## Architecture and limitations

This is a **phase-one integration prototype**, deliberately isolated under `examples/`.
It uses the **Kiln 0.6.1 `KilnViewer` API** and the actual camera view/projection
matrices to align a Three.js WebGL overlay. The volume canvas owns input; the
Three.js canvas is pointer-transparent. The scene includes a grid, axes,
an animated torus, and a sphere marker.

**Not yet supported:** correct mutual occlusion between volume and meshes,
shared WebGPU device, single render pass, or embedding Kiln as a Three.js
scene object. A transparent WebGL overlay can only composite on top of the
volume; it cannot use the volume's depth. Do not use this demo to claim
depth-correct integration.

Kiln 0.6.1 exports `KilnEngine` for a future headless integration with a
host-supplied GPU device, camera, frame loop and color target. That is the
appropriate next step for correct composition rather than adding hooks to
`KilnViewer`.

The Three.js dependency is loaded from a pinned ESM CDN to avoid adding a
production dependency to Kiln. The example requires internet access.

**Validation:** not browser-tested in the connector environment. Check in a
WebGPU-capable browser before merging.
