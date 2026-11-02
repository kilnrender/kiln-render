/**
 * Phase-one integration spike for Kiln 0.6.1.
 *
 * Uses KilnViewer's public camera and independent WebGL overlay.
 * This deliberately does NOT claim shared GPU rendering or depth-correct occlusion.
 * The new headless KilnEngine API is the foundation for a future single-device compositor.
 */
import * as THREE from 'https://esm.sh/three@0.180.0';
import { KilnViewer } from '../../src/viewer.ts';

const volumeCanvas = document.querySelector('#volume');
const geometryCanvas = document.querySelector('#geometry');
const status = document.querySelector('#status');
const params = new URLSearchParams(location.search);
const dataset = params.get('dataset') ??
  'https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr';

let viewer;
let frameId = 0;
let observer;
let overlay;

try {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser.');
  viewer = await KilnViewer.create(volumeCanvas, dataset, {
    mode: 'dvr',
    renderScale: 0.65,
    atlasBudgetBytes: 256 * 1024 * 1024,
  });

  overlay = new THREE.WebGLRenderer({ canvas: geometryCanvas, alpha: true, antialias: true });
  overlay.setClearColor(0x000000, 0);
  overlay.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;

  const grid = new THREE.GridHelper(1.4, 14, 0x64a9ff, 0x37617f);
  grid.rotation.x = Math.PI / 2;
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  scene.add(grid);

  const axes = new THREE.AxesHelper(0.85);
  scene.add(axes);

  const torus = new THREE.Mesh(
    new THREE.TorusGeometry(0.36, 0.012, 10, 96),
    new THREE.MeshBasicMaterial({ color: 0xffbc60, depthTest: true }),
  );
  torus.rotation.x = Math.PI / 4;
  scene.add(torus);

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x6bf5cf }),
  );
  marker.position.set(0.45, 0.12, 0.15);
  scene.add(marker);

  function resize() {
    const width = Math.max(1, volumeCanvas.clientWidth);
    const height = Math.max(1, volumeCanvas.clientHeight);
    overlay.setSize(width, height, false);
  }

  observer = new ResizeObserver(resize);
  observer.observe(volumeCanvas);
  resize();

  function draw(time) {
    // wgpu-matrix and Three.js both store matrices column-major.
    const aspect = geometryCanvas.width / geometryCanvas.height;
    const view = viewer.camera.getViewMatrix();
    const projection = viewer.camera.getProjectionMatrix(aspect);

    camera.matrixWorldInverse.fromArray(view);
    camera.matrixWorld.copy(camera.matrixWorldInverse).invert();
    camera.projectionMatrix.fromArray(projection);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    torus.rotation.z = time * 0.00018;
    overlay.render(scene, camera);
    frameId = requestAnimationFrame(draw);
  }
  frameId = requestAnimationFrame(draw);
  status.textContent = 'Ready — camera synchronized';
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}

window.addEventListener('pagehide', () => {
  cancelAnimationFrame(frameId);
  observer?.disconnect();
  overlay?.dispose();
  viewer?.dispose();
}, { once: true });
