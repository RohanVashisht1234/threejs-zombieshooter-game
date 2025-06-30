import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';

// === Responsive helpers ===
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent)
    || window.innerWidth < 850;
}

function setRendererFullScreen() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.width = '100vw';
  renderer.domElement.style.height = '100vh';
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.zIndex = '1';
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 2, 30);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
setRendererFullScreen();
document.body.appendChild(renderer.domElement);

// =========== Start Screen ===========
const startScreen = document.createElement('div');
startScreen.innerHTML = `
  <div id="start-screen" style="
    position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:100;
    background:linear-gradient(135deg,#0a1931 60%,#185adb 100%);
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-family:sans-serif;">
    <h1 style="color:#fff;font-size:2.5rem;text-shadow:0 2px 16px #222;">Ultimate FPS Survival</h1>
    <p style="color:#dbeafe;font-size:1.2rem;margin-bottom:24px;text-align:center;max-width:90vw;">
      Battle zombies with realistic controls. <br>
      <span style="color:#ff0;">TIP:</span> Use the toggle to switch between <b>Desktop</b> and <b>Mobile</b> controls.<br>
      <span style="color:#0ff;">On mobile, swipe to look and use the joystick to move!</span>
    </p>
    <button id="start-btn" style="
      background:#00c9a7;color:#fff;
      font-size:1.3rem;padding:16px 40px;border:0;border-radius:32px;box-shadow:0 4px 16px #185adb99;
      cursor:pointer;transition:.2s;">Start Game</button>
    <div style="margin-top:48px;">
      <label style="font-size:1.1rem;color:#fff;user-select:none;cursor:pointer;">
        <input type="checkbox" id="toggleMode" style="width:24px;height:24px;vertical-align:middle;margin-right:8px;">
        <span id="toggleModeLabel">Mobile Mode</span>
      </label>
    </div>
  </div>
`;
document.body.appendChild(startScreen);

let mobileMode = isMobileDevice();
const toggleModeInput = startScreen.querySelector('#toggleMode') as HTMLInputElement;
const toggleModeLabel = startScreen.querySelector('#toggleModeLabel') as HTMLSpanElement;
toggleModeInput.checked = mobileMode;
toggleModeLabel.textContent = mobileMode ? 'Mobile Mode' : 'Desktop Mode';

toggleModeInput.onchange = () => {
  mobileMode = toggleModeInput.checked;
  toggleModeLabel.textContent = mobileMode ? 'Mobile Mode' : 'Desktop Mode';
};

function showStartScreen() { startScreen.style.display = 'flex'; }
function hideStartScreen() { startScreen.style.display = 'none'; }
showStartScreen();

// =========== Pointer Lock Controls ===========
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject());

function lockPointer() {
  if (!mobileMode) controls.lock();
}
renderer.domElement.addEventListener('click', lockPointer);

// =========== Keyboard & Touch Controls ===========
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

// =========== UI =============
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
function updateUI() {
  ammoDisplay.textContent = `Ammo: ${ammo} / ${maxAmmo}`;
  healthFill.style.width = `${health}%`;
}

// =========== Mobile Controls =============
const mobileUI = document.createElement('div');
mobileUI.style.display = 'none';
mobileUI.innerHTML = `
  <div style="position:fixed;bottom:10vh;left:5vw;z-index:30;">
    <div id="joystick" style="width:110px;height:110px;border-radius:50%;background:rgba(255,255,255,0.13);position:relative;box-shadow:0 2px 16px #0007;">
      <div id="stick" style="width:60px;height:60px;border-radius:50%;background:#fff;position:absolute;top:25px;left:25px;box-shadow:0 2px 8px #0005;"></div>
    </div>
  </div>
  <div style="position:fixed;bottom:10vh;right:5vw;z-index:30;display:flex;flex-direction:column;align-items:flex-end;gap:18px;">
    <button id="btnShoot" style="width:68px;height:68px;border-radius:50%;background:linear-gradient(145deg,#ff4c4c,#ad1d1d);opacity:0.88;box-shadow:0 2px 12px #300;">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="#fff"><path d="M21 11h-8V3h-2v8H3v2h8v8h2v-8h8z"/></svg>
    </button>
    <button id="btnReload" style="width:68px;height:68px;border-radius:50%;background:linear-gradient(145deg,#4caaff,#1841ad);opacity:0.88;box-shadow:0 2px 12px #003;">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="#fff"><path d="M12 6V3l-4 4 4 4V7c3.31 0 6 2.69 6 6 0 1.76-.77 3.34-2 4.42l1.45 1.45C19.1 17.07 20 15.14 20 13c0-4.42-3.58-8-8-8zm-6 7c0-1.76.77-3.34 2-4.42L6.55 7.13C4.9 8.93 4 10.86 4 13c0 4.42 3.58 8 8 8v3l4-4-4-4v3c-3.31 0-6-2.69-6-6z"/></svg>
    </button>
    <button id="btnFlash" style="width:68px;height:68px;border-radius:50%;background:linear-gradient(145deg,#ffe066,#d9a900);opacity:0.88;box-shadow:0 2px 12px #664d00;">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="#fff"><path d="M7 2v11h3v9l7-12h-4l3-8z"/></svg>
    </button>
  </div>
`;
document.body.appendChild(mobileUI);

let touchDirection = { x: 0, y: 0 };
const joystick = mobileUI.querySelector('#joystick') as HTMLDivElement;
const stick = mobileUI.querySelector('#stick') as HTMLDivElement;

let dragging = false;
let center = { x: 0, y: 0 };

if (joystick && stick) {
  joystick.addEventListener('touchstart', e => {
    dragging = true;
    const rect = joystick.getBoundingClientRect();
    center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  joystick.addEventListener('touchmove', e => {
    if (!dragging) return;
    const touch = e.touches[0];
    let dx = touch.clientX - center.x;
    let dy = touch.clientY - center.y;
    const dist = Math.min(Math.sqrt(dx * dx + dy * dy), 45);
    const angle = Math.atan2(dy, dx);
    dx = Math.cos(angle) * dist;
    dy = Math.sin(angle) * dist;
    stick.style.transform = `translate(${dx}px, ${dy}px)`;
    touchDirection = { x: dx / 45, y: dy / 45 };
  });
  joystick.addEventListener('touchend', () => {
    dragging = false;
    stick.style.transform = `translate(0,0)`;
    touchDirection = { x: 0, y: 0 };
  });
}

// Mobile Buttons
const btnShoot = mobileUI.querySelector('#btnShoot') as HTMLButtonElement;
const btnReload = mobileUI.querySelector('#btnReload') as HTMLButtonElement;
const btnFlash = mobileUI.querySelector('#btnFlash') as HTMLButtonElement;

btnShoot.ontouchstart = () => { isShooting = true; };
btnShoot.ontouchend = () => { isShooting = false; };
btnReload.ontouchstart = () => {
  if (shootTimer <= 0 && !isReloading && ammo < maxAmmo) playGunAction(7);
};
btnFlash.ontouchstart = () => {
  flashlightOn = !flashlightOn;
  flashlight.visible = flashlightOn;
};

// =========== Aim Dot =============
const aimDot = document.createElement('div');
aimDot.style.cssText = `
  position:fixed;top:50%;left:50%;width:10px;height:10px;background:#f43;border-radius:50%;
  box-shadow:0 0 8px 2px #fff5;transform:translate(-50%,-50%);pointer-events:none;z-index:10
`;
document.body.appendChild(aimDot);

// =========== Rain & Effects =============
const rainCount = 900;
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
  setRendererFullScreen();
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
  camera.getWorldDirection(flashlight.target.position);
  flashlight.target.position.addVectors(camera.position, flashlight.target.position);
  if (!scene.children.includes(flashlight.target)) scene.add(flashlight.target);
  flashlight.position.set(0, 0, 0);
}

// =========== Mobile FPS Look Controls ===========
let isSwiping = false;
let lastTouchX = 0, lastTouchY = 0;

// Only for mobile mode!
function setupMobileLookControls() {
  document.addEventListener('touchstart', onTouchStart, { passive: false });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd, { passive: false });
}

function removeMobileLookControls() {
  document.removeEventListener('touchstart', onTouchStart);
  document.removeEventListener('touchmove', onTouchMove);
  document.removeEventListener('touchend', onTouchEnd);
}

function onTouchStart(e: TouchEvent) {
  if (!mobileMode) return;
  // Don't hijack joystick area
  if ((e.target as HTMLElement).closest('#joystick')) return;
  if (e.touches.length === 1) {
    isSwiping = true;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
  }
}
function onTouchMove(e: TouchEvent) {
  if (!mobileMode || !isSwiping || e.touches.length !== 1) return;
  // Don't hijack joystick area
  if ((e.target as HTMLElement).closest('#joystick')) return;
  const touch = e.touches[0];
  const dx = touch.clientX - lastTouchX;
  const dy = touch.clientY - lastTouchY;
  // COD-like FPS: horizontal = yaw, vertical = pitch
  const sensitivity = 0.0032;
  controls.getObject().rotation.y -= dx * sensitivity;
  camera.rotation.x -= dy * sensitivity;
  // Clamp
  camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));
  lastTouchX = touch.clientX;
  lastTouchY = touch.clientY;
}
function onTouchEnd(e: TouchEvent) {
  isSwiping = false;
}

// =========== Game Loop ===========
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  direction.set(
    keysPressed['KeyD'] ? 1 : keysPressed['KeyA'] ? -1 : 0,
    0,
    keysPressed['KeyW'] ? 1 : keysPressed['KeyS'] ? -1 : 0
  );
  direction.x += touchDirection.x;
  direction.z += touchDirection.y;
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

  updateFlashlight();
  composer.render();
}

// =========== Mode Switch & Start =============
function setModeUI() {
  if (mobileMode) {
    mobileUI.style.display = '';
    setupMobileLookControls();
  } else {
    mobileUI.style.display = 'none';
    removeMobileLookControls();
  }
}

// Start button: hide splash, set control mode, lock pointer if desktop, start animation
const startBtn = startScreen.querySelector('#start-btn') as HTMLButtonElement;
startBtn.onclick = () => {
  hideStartScreen();
  setModeUI();
  setRendererFullScreen();
  // Desktop: lock pointer
  if (!mobileMode) setTimeout(lockPointer, 100);
  updateUI();
  animate();
};

// Also allow Enter to start for desktop
document.addEventListener('keydown', e => {
  if (startScreen.style.display !== 'none' && (e.code === 'Enter' || e.code === 'Space')) {
    startBtn.click();
  }
});

// Allow switching mode while in-game (for demo/dev)
toggleModeInput.onchange = () => {
  mobileMode = toggleModeInput.checked;
  toggleModeLabel.textContent = mobileMode ? 'Mobile Mode' : 'Desktop Mode';
  setModeUI();
  setRendererFullScreen();
  if (!mobileMode) setTimeout(lockPointer, 100);
};

showStartScreen();