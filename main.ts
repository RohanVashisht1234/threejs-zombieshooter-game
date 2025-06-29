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
renderer.shadowMap.enabled = true;
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

// === Lighting ===
scene.add(new THREE.AmbientLight(0x222244, 0.8));
const moonLight = new THREE.DirectionalLight(0x8888ff, 0.5);
moonLight.position.set(20, 100, 50);
moonLight.castShadow = true;
scene.add(moonLight);

// === Load Map ===
new GLTFLoader().load('/map.glb', gltf => {
  gltf.scene.castShadow = true;
  gltf.scene.receiveShadow = true;

  gltf.scene.traverse(o => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  scene.add(gltf.scene);
}, undefined, console.error);

// === Animated Model ===
let mixer: THREE.AnimationMixer;
let zombie: THREE.Object3D;
new GLTFLoader().load('/zombie_hazmat.glb', (gltf) => {
  const model = gltf.scene;
  model.scale.x = 1.5;
  model.scale.y = 1.5;
  model.scale.z = 1.5;
  model.position.y = 0.1;
  model.castShadow = true;
  model.receiveShadow = true;
  const animations = gltf.animations;
  mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(animations[3]);
  action.play();
  scene.add(model);
  zombie = model;
}, undefined, console.error);

// === Rain System ===
const rainCount = 2000;
const rainGeo = new THREE.PlaneGeometry(0.02, 0.4);
const rainMat = new THREE.MeshStandardMaterial({
  color: 0xaaaaee,
  transparent: true,
  opacity: 0.3,
  metalness: 0.4,
  roughness: 0.85,
  side: THREE.DoubleSide,
});
const rainGroup = new THREE.InstancedMesh(rainGeo, rainMat, rainCount);
const rainPositions: THREE.Vector3[] = [];
const rainVelocities: number[] = [];

for (let i = 0; i < rainCount; i++) {
  const pos = new THREE.Vector3(
    THREE.MathUtils.randFloat(-25, 25),
    THREE.MathUtils.randFloat(0, 100),
    THREE.MathUtils.randFloat(-25, 25)
  );
  rainPositions.push(pos);
  rainVelocities.push(THREE.MathUtils.randFloat(0.3, 0.8));
  const matrix = new THREE.Matrix4().setPosition(pos);
  rainGroup.setMatrixAt(i, matrix);
}
scene.add(rainGroup);

// === Postprocessing ===
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.5, 0.85));
composer.addPass(new ShaderPass(GammaCorrectionShader));

// === Resize Handling ===
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// === Animation ===
const clock = new THREE.Clock();
const direction = new THREE.Vector3();
const velocity = new THREE.Vector3();
const moveSpeed = 10;

function updateRainFixedArea() {
  for (let i = 0; i < rainCount; i++) {
    const pos = rainPositions[i];
    pos.y -= rainVelocities[i];
    if (pos.y < 0) {
      pos.y = THREE.MathUtils.randFloat(60, 100);
      pos.x = THREE.MathUtils.randFloat(-25, 25);
      pos.z = THREE.MathUtils.randFloat(-25, 25);
    }
    const matrix = new THREE.Matrix4().setPosition(pos);
    rainGroup.setMatrixAt(i, matrix);
  }
  rainGroup.instanceMatrix.needsUpdate = true;
}

function moveAZombieTowardCamera() {
  if (!zombie || !camera) return;
  const zombiePos = zombie.position.clone();
  const camPos = camera.position.clone();
  const dir = new THREE.Vector3().subVectors(camPos, zombiePos);
  dir.y = 0;
  const dist = dir.length();
  if (dist > 0.5) {
    dir.normalize();
    zombie.position.add(dir.multiplyScalar(0.05));
    zombie.lookAt(camPos.x, zombie.position.y, camPos.z);
  }
}

const light = new THREE.SpotLight(0xffffff, 100);
light.position.set(5, 10, 5);
light.castShadow = true;
scene.add(light);



function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  // Movement
  direction.set(0, 0, 0);
  if (keysPressed['KeyW']) direction.z += 1;
  if (keysPressed['KeyS']) direction.z -= 1;
  if (keysPressed['KeyA']) direction.x -= 1;
  if (keysPressed['KeyD']) direction.x += 1;
  direction.normalize();
  velocity.copy(direction).multiplyScalar(moveSpeed * delta);
  controls.moveRight(velocity.x);
  controls.moveForward(velocity.z);

  updateRainFixedArea();
  moveAZombieTowardCamera();

  if (mixer) mixer.update(delta);
  composer.render();
}

animate();
