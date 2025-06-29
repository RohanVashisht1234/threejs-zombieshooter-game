import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';

// === Scene Setup ===
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 2, 30);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

// === Controls ===
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject());

document.body.addEventListener('click', () => controls.lock());

const keysPressed: Record<string, boolean> = {};
document.addEventListener('keydown', e => keysPressed[e.code] = true);
document.addEventListener('keyup', e => keysPressed[e.code] = false);

const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const moveSpeed = 10;

// === Lighting (Night Mood) ===
const ambient = new THREE.AmbientLight(0x222244, 0.8);
scene.add(ambient);

const moonLight = new THREE.DirectionalLight(0x8888ff, 0.5);
moonLight.position.set(20, 100, 50);
moonLight.castShadow = true;
scene.add(moonLight);

// === Load Map ===
const loader = new GLTFLoader();
loader.load(
  'map.glb',
  gltf => {
    const map = gltf.scene;
    map.traverse(o => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    scene.add(map);
  },
  undefined,
  console.error
);

// === Rain with MeshStandardMaterial ===
const rainCount = 15000;
const rainGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.3, 5);
const rainMat = new THREE.MeshStandardMaterial({
  color: 0xccccff,
  roughness: 2,
  metalness: 1,
  transparent: true,
  opacity: 0.2,
  emissive:0,
});

const rainGroup = new THREE.Group();
for (let i = 0; i < rainCount; i++) {
  const drop = new THREE.Mesh(rainGeo, rainMat);
  drop.position.set(
    THREE.MathUtils.randFloatSpread(300),
    THREE.MathUtils.randFloat(20, 100),
    THREE.MathUtils.randFloatSpread(300)
  );
  // drop.rotation.x = Math.PI / 2;
  drop.castShadow = false;
  drop.receiveShadow = false;
  rainGroup.add(drop);
}
scene.add(rainGroup);

// === Postprocessing ===
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.7, 0.99));
composer.addPass(new ShaderPass(GammaCorrectionShader));

// === Resize Handling ===
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});






// === Animation Loop ===
const clock = new THREE.Clock();

function animate() {
  const delta = clock.getDelta();

  // Update raindrops
  for (let i = 0; i < rainGroup.children.length; i++) {
    const drop = rainGroup.children[i];
    drop.position.y -= 0.5;
    if (drop.position.y < 0) {
      drop.position.y = THREE.MathUtils.randFloat(60, 100);
    }
  }

  // Movement
  velocity.set(0, 0, 0);
  direction.set(0, 0, 0);
  if (keysPressed['KeyW']) direction.z += 1;
  if (keysPressed['KeyS']) direction.z -= 1;
  if (keysPressed['KeyA']) direction.x -= 1;
  if (keysPressed['KeyD']) direction.x += 1;
  direction.normalize();
  velocity.copy(direction).multiplyScalar(moveSpeed * delta);
  controls.moveRight(velocity.x);
  controls.moveForward(velocity.z);

  composer.render();
  requestAnimationFrame(animate);
}

animate();