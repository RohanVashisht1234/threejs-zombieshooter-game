import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 2, 30);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject());
document.body.addEventListener('click', () => controls.lock());

const keysPressed: Record<string, boolean> = {};
document.addEventListener('keydown', e => keysPressed[e.code] = true);
document.addEventListener('keyup', e => keysPressed[e.code] = false);

scene.add(new THREE.AmbientLight(0x222244, 0.8));
const moonLight = new THREE.DirectionalLight(0x8888ff, 0.5);
moonLight.position.set(20, 100, 50);
moonLight.castShadow = true;
scene.add(moonLight);

const loader = new GLTFLoader();
loader.load('/map.glb', gltf => {
  gltf.scene.traverse(o => {
    o.castShadow = o.receiveShadow = true;
    if ((o as THREE.PointLight).isLight) (o as THREE.PointLight).shadow.bias = -0.0009;
  });
  scene.add(gltf.scene);
}, undefined, console.error);

let mixer: THREE.AnimationMixer;
let zombie: THREE.Object3D;
loader.load('/zombie_hazmat.glb', gltf => {
  const model = gltf.scene;
  model.scale.set(1.5, 1.5, 1.5);
  model.position.y = 0.05;
  model.traverse(child => child.castShadow = child.receiveShadow = true);
  mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(gltf.animations[3]);
  action.play();
  action.timeScale = 2;
  scene.add(zombie = model);
}, undefined, console.error);

let fpsGun: THREE.Object3D;
let gunMixer: THREE.AnimationMixer;
let gunActions: THREE.AnimationAction[] = [];
let currentGunAction = -1;
let shootTimer = 0;
let reloadTimer = 0;
let isReloading = false;

loader.load('/fps_gun_person_view.glb', gltf => {
  fpsGun = gltf.scene;
  fpsGun.scale.set(0.8, 0.8, 0.8);
  fpsGun.position.set(0.2, -0.5, -0.3);
  fpsGun.rotation.y = THREE.MathUtils.degToRad(-180);
  fpsGun.traverse(child => child.castShadow = child.receiveShadow = true);
  gunMixer = new THREE.AnimationMixer(fpsGun);
  gunActions = gltf.animations.map(a => gunMixer.clipAction(a));
  playGunAction(0); // static by default
  camera.add(fpsGun);
  scene.add(camera);
}, undefined, console.error);

const aimDot = document.createElement('div');
aimDot.style.cssText = `position:fixed;top:50%;left:50%;width:8px;height:8px;background:#f00;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:10`;
document.body.appendChild(aimDot);

const rainCount = 2000;
const rainGroup = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(0.02, 0.4),
  new THREE.MeshStandardMaterial({
    color: 0xaaaaee,
    transparent: true,
    opacity: 0.3,
    metalness: 0.4,
    roughness: 0.85,
    side: THREE.DoubleSide,
  }),
  rainCount
);

const rainPositions: THREE.Vector3[] = [], rainVelocities: number[] = [];
for (let i = 0; i < rainCount; i++) {
  const pos = new THREE.Vector3(
    THREE.MathUtils.randFloat(-25, 25),
    THREE.MathUtils.randFloat(0, 100),
    THREE.MathUtils.randFloat(-25, 25)
  );
  rainPositions.push(pos);
  rainVelocities.push(THREE.MathUtils.randFloat(0.3, 0.8));
  rainGroup.setMatrixAt(i, new THREE.Matrix4().setPosition(pos));
}
scene.add(rainGroup);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.5, 0.85));
composer.addPass(new ShaderPass(GammaCorrectionShader));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
const direction = new THREE.Vector3();
const velocity = new THREE.Vector3();
const moveSpeed = 10;

function playGunAction(index: number) {
  if (!gunActions.length || index === currentGunAction) return;
  gunActions.forEach(a => a.stop());
  gunActions[index].reset().play();
  currentGunAction = index;

  if (index === 4) shootTimer = 0.3;
  if (index === 7) {
    reloadTimer = 3.5;
    isReloading = true;
  }
}

document.addEventListener('mousedown', e => {
  if (e.button === 0 && reloadTimer <= 0 && !isReloading) playGunAction(4);
});

document.addEventListener('keydown', e => {
  if (e.code === 'KeyR' && shootTimer <= 0 && !isReloading) playGunAction(7);
});

function isWalking(): boolean {
  return keysPressed['KeyW'] || keysPressed['KeyA'] || keysPressed['KeyS'] || keysPressed['KeyD'];
}

function updateRain() {
  for (let i = 0; i < rainCount; i++) {
    const pos = rainPositions[i];
    pos.y -= rainVelocities[i];
    if (pos.y < 0) {
      pos.set(
        THREE.MathUtils.randFloat(-25, 25),
        THREE.MathUtils.randFloat(60, 100),
        THREE.MathUtils.randFloat(-25, 25)
      );
    }
    rainGroup.setMatrixAt(i, new THREE.Matrix4().setPosition(pos));
  }
  rainGroup.instanceMatrix.needsUpdate = true;
}

function moveZombie() {
  if (!zombie) return;
  const dir = new THREE.Vector3().subVectors(camera.position, zombie.position);
  dir.y = 0;
  const dist = dir.length();
  if (dist > 0.5) {
    zombie.position.add(dir.normalize().multiplyScalar(0.05));
    zombie.lookAt(camera.position.x, zombie.position.y, camera.position.z);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  direction.set(0, 0, 0);
  if (keysPressed['KeyW']) direction.z += 1;
  if (keysPressed['KeyS']) direction.z -= 1;
  if (keysPressed['KeyA']) direction.x -= 1;
  if (keysPressed['KeyD']) direction.x += 1;
  direction.normalize();
  velocity.copy(direction).multiplyScalar(moveSpeed * delta);
  controls.moveRight(velocity.x);
  controls.moveForward(velocity.z);

  updateRain();
  moveZombie();
  if (mixer) mixer.update(delta);
  if (gunMixer) gunMixer.update(delta);

  if (shootTimer > 0) shootTimer -= delta;
  if (reloadTimer > 0) {
    reloadTimer -= delta;
    if (reloadTimer <= 0) isReloading = false;
  }

  if (gunActions.length > 0 && shootTimer <= 0 && !isReloading) {
    if (isWalking()) playGunAction(2);
    else playGunAction(0);
  }

  composer.render();
}

animate();
