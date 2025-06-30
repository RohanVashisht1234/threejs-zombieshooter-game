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

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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


loader.load('/fighter_jet.glb', gltf => {
  gltf.scene.traverse(o => {
    o.castShadow = o.receiveShadow = true;
    if ((o as THREE.PointLight).isLight) (o as THREE.PointLight).shadow.bias = -0.0009;
  });
  gltf.scene.scale.set(0.17, 0.17, 0.17);
  gltf.scene.position.y = 3.1;
  scene.add(gltf.scene);
});


loader.load('/map.glb', gltf => {
  gltf.scene.traverse(o => {
    o.castShadow = o.receiveShadow = true;
    if ((o as THREE.PointLight).isLight) (o as THREE.PointLight).shadow.bias = -0.0009;
  });
  gltf.scene.position.y = -0.2;
  scene.add(gltf.scene);
});

let mixer: THREE.AnimationMixer, zombie: THREE.Object3D;
loader.load('/zombie_hazmat.glb', gltf => {
  const model = gltf.scene;
  model.scale.set(1.5, 1.5, 1.5);
  model.position.y = 0.05;
  model.traverse(child => child.castShadow = child.receiveShadow = true);
  mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(gltf.animations[3]).play().timeScale = 2;
  scene.add(zombie = model);
});

let fpsGun: THREE.Object3D, gunMixer: THREE.AnimationMixer, gunActions: THREE.AnimationAction[] = [];
let currentGunAction = -1, shootTimer = 0, reloadTimer = 0, isReloading = false, ammo = 40, maxAmmo = 40, health = 100;

const bullets: THREE.Mesh[] = [];
const bulletGeometry = new THREE.SphereGeometry(0.05, 4, 4);
const bulletMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });

loader.load('/fps_gun_person_view.glb', gltf => {
  fpsGun = gltf.scene;
  fpsGun.scale.set(0.8, 0.8, 0.8);
  fpsGun.position.set(0.2, -0.5, -0.3);
  fpsGun.rotation.y = THREE.MathUtils.degToRad(-180);
  fpsGun.traverse(child => child.castShadow = child.receiveShadow = true);
  gunMixer = new THREE.AnimationMixer(fpsGun);
  gunActions = gltf.animations.map(a => gunMixer.clipAction(a));
  playGunAction(0);
  camera.add(fpsGun);
});

const ui = document.createElement('div');
ui.innerHTML = `
  <div style="position:fixed;top:20px;right:20px;color:#fff;font-family:sans-serif;font-size:16px;text-align:right;z-index:20">
    <div id="ammoDisplay">Ammo: 40 / 40</div>
    <div id="healthBar" style="margin-top:8px;width:120px;height:16px;border:1px solid #fff">
      <div id="healthFill" style="background:#f00;width:100%;height:100%"></div>
    </div>
  </div>
`;
document.body.appendChild(ui);
const ammoDisplay = document.getElementById('ammoDisplay')!;
const healthFill = document.getElementById('healthFill')! as HTMLDivElement;
const updateUI = () => {
  ammoDisplay.textContent = `Ammo: ${ammo} / ${maxAmmo}`;
  healthFill.style.width = `${health}%`;
};

const aimDot = document.createElement('div');
aimDot.style.cssText = `position:fixed;top:50%;left:50%;width:8px;height:8px;background:#f00;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:10`;
document.body.appendChild(aimDot);

const rainCount = 1000;
const rainGeometry = new THREE.PlaneGeometry(0.02, 0.4);
const rainMaterial = new THREE.MeshStandardMaterial({
  color: 0xaaaaee, transparent: true, opacity: 0.3, metalness: 0.4, roughness: 0.85, side: THREE.DoubleSide,
});
const rainGroup = new THREE.InstancedMesh(rainGeometry, rainMaterial, rainCount);
const rainPositions = new Float32Array(rainCount * 3);
const rainVelocities = new Float32Array(rainCount);

const splashGeometry = new THREE.CircleGeometry(0.05, 20);
const splashMaterial = new THREE.MeshStandardMaterial({
  color: 0xdddddd, emissive: 0, transparent: true, opacity: 0.5, metalness: 0.4, side: THREE.FrontSide,
});
const splashGroup = new THREE.InstancedMesh(splashGeometry, splashMaterial, rainCount);
const splashTimers = new Float32Array(rainCount);
scene.add(splashGroup);

for (let i = 0; i < rainCount; i++) {
  rainPositions[i * 3 + 0] = THREE.MathUtils.randFloat(-25, 25);
  rainPositions[i * 3 + 1] = THREE.MathUtils.randFloat(0, 100);
  rainPositions[i * 3 + 2] = THREE.MathUtils.randFloat(-25, 25);
  rainVelocities[i] = THREE.MathUtils.randFloat(0.3, 0.8);
  rainGroup.setMatrixAt(i, new THREE.Matrix4().setPosition(
    rainPositions[i * 3 + 0], rainPositions[i * 3 + 1], rainPositions[i * 3 + 2]
  ));
}
scene.add(rainGroup);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(500, 500),
  new THREE.MeshStandardMaterial({
    color: 0x111122,
    metalness: 0.8,
    roughness: 0.3,
    opacity: 0.1,
    transparent: true
  })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.3, 0.4, 0.6));
composer.addPass(new ShaderPass(GammaCorrectionShader));
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
const direction = new THREE.Vector3(), velocity = new THREE.Vector3();
const moveSpeed = 10;

function playGunAction(idx: number) {
  if (!gunActions.length || idx === currentGunAction) return;
  gunActions.forEach(a => a.stop());
  gunActions[idx].reset().play();
  currentGunAction = idx;
  if (idx === 4) shootTimer = 0.1;
  if (idx === 7) {
    reloadTimer = 3.5; isReloading = true;
    setTimeout(() => { ammo = maxAmmo; isReloading = false; updateUI(); }, 3500);
  }
}

let isShooting = false, flashlightOn = false;
const flashlight = new THREE.SpotLight(0xffffff, 100, 50, Math.PI / 6, 0.3, 1.5);
flashlight.shadow.normalBias = 1;
flashlight.castShadow = true;
flashlight.position.set(0, 0, 0);
camera.add(flashlight);

const muzzleFlash = new THREE.PointLight(0xffaa33, 7, 100);
muzzleFlash.visible = false;
muzzleFlash.castShadow = true;
camera.add(muzzleFlash);
muzzleFlash.position.set(0, 0, -1.5);

document.addEventListener('keydown', e => {
  if (e.code === 'KeyR' && shootTimer <= 0 && !isReloading && ammo < maxAmmo) playGunAction(7);
  if (e.code === 'KeyF') {
    flashlightOn = !flashlightOn;
    flashlight.visible = flashlightOn;
  }
});
document.addEventListener('mousedown', e => { if (e.button === 0) isShooting = true; });
document.addEventListener('mouseup', () => isShooting = false);

const isWalking = () =>
  keysPressed['KeyW'] || keysPressed['KeyA'] || keysPressed['KeyS'] || keysPressed['KeyD'];

function updateRain() {
  const tempMatrix = new THREE.Matrix4(), tempSplashMatrix = new THREE.Matrix4();
  for (let i = 0; i < rainCount; i++) {
    rainPositions[i * 3 + 1] -= rainVelocities[i];
    if (rainPositions[i * 3 + 1] < 0) {
      splashTimers[i] = 0.3;
      rainPositions[i * 3 + 0] = THREE.MathUtils.randFloat(-25, 25);
      rainPositions[i * 3 + 1] = THREE.MathUtils.randFloat(60, 100);
      rainPositions[i * 3 + 2] = THREE.MathUtils.randFloat(-25, 25);
    }
    tempMatrix.setPosition(rainPositions[i * 3 + 0], rainPositions[i * 3 + 1], rainPositions[i * 3 + 2]);
    rainGroup.setMatrixAt(i, tempMatrix);

    if (splashTimers[i] > 0) {
      splashTimers[i] -= 0.016;
      tempSplashMatrix.makeRotationX(-Math.PI / 2);
      tempSplashMatrix.setPosition(rainPositions[i * 3 + 0], 0.01, rainPositions[i * 3 + 2]);
      splashGroup.setMatrixAt(i, tempSplashMatrix);
    } else splashGroup.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
  }
  rainGroup.instanceMatrix.needsUpdate = true;
  splashGroup.instanceMatrix.needsUpdate = true;
}

function moveZombie() {
  if (!zombie) return;
  const dir = new THREE.Vector3().subVectors(camera.position, zombie.position);
  dir.y = 0;
  const dist = dir.length();
  if (dist > 0.5) {
    zombie.position.add(dir.normalize().multiplyScalar(0.05));
    zombie.lookAt(camera.position.x, zombie.position.y, camera.position.z);
  } else if (health > 0) {
    health -= 0.2; updateUI();
  }
}

function updateBullets(delta: number) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.position.add(b.userData.velocity.clone().multiplyScalar(delta * 20));
    if (b.position.length() > 200) {
      scene.remove(b); bullets.splice(i, 1);
    }
  }
}

function shoot() {
  playGunAction(4);
  ammo--; updateUI();
  const bullet = new THREE.Mesh(bulletGeometry, bulletMaterial);
  bullet.position.copy(camera.position);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  bullet.userData.velocity = dir.clone().multiplyScalar(20);
  bullets.push(bullet); scene.add(bullet);

  // Muzzle flash
  muzzleFlash.visible = true;
  setTimeout(() => { muzzleFlash.visible = false; }, 50);
}

function updateFlashlight() {
  // Always point the flashlight in the direction the camera is facing (fix)
  camera.getWorldDirection(flashlight.target.position);
  flashlight.target.position.addVectors(camera.position, flashlight.target.position);
  if (!scene.children.includes(flashlight.target)) scene.add(flashlight.target);
  flashlight.position.set(0, 0, 0); // Keep the light at the camera
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
  controls.moveRight(velocity.x); controls.moveForward(velocity.z);

  if (isShooting && shootTimer <= 0 && !isReloading && ammo > 0) {
    shoot(); shootTimer = 0.15;
  }
  updateRain(); moveZombie(); updateBullets(delta);
  gunMixer?.update(delta); mixer?.update(delta);
  shootTimer -= delta; reloadTimer -= delta;
  if (gunActions.length > 0 && shootTimer <= 0 && !isReloading)
    playGunAction(isWalking() ? 2 : 0);

  updateFlashlight(); // <-- key for flashlight direction
  composer.render();
}

updateUI();
animate();
