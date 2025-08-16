import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const CONFIG = {
  CAMERA: { FOV: 55, NEAR: 0.1, FAR: 1000, INITIAL_POSITION: { x: 0, y: 2, z: 10 } },
  RENDERER: { PIXEL_RATIO_MAX: 1.5 },
  MOVEMENT: { SPEED: 10 },
  WEAPON: { MAX_AMMO: 40, SHOOT_COOLDOWN: 0.15, RELOAD_TIME: 3.5, MUZZLE_FLASH_DURATION: 50 },
  ZOMBIE: { SPEED: 5, DAMAGE_RATE: 10, MIN_DISTANCE: 0.5, COUNT: 50 },
  RAIN: { COUNT: 500, FALL_SPEED_MIN: 0.3, FALL_SPEED_MAX: 0.8, SPAWN_RANGE: 25, HEIGHT_MIN: 60, HEIGHT_MAX: 100 },
  BULLET: { SPEED: 10, MAX_DISTANCE: 1000 },
  PLAYER: { INITIAL_HEALTH: 100 }
};

const GAME_BOUNDS = { minX: -10.46, maxX: 34.43, minZ: -422.50, maxZ: 17.26 };

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

class GameState {
  public ammo = CONFIG.WEAPON.MAX_AMMO;
  public health = CONFIG.PLAYER.INITIAL_HEALTH;
  public shootTimer = 0;
  public reloadTimer = 0;
  public isReloading = false;
  public isShooting = false;
  public flashlightOn = true;
  public currentGunAction = -1;
  public keysPressed: Record<string, boolean> = {};
}

class SceneManager {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;

  constructor() {
    const { FOV, NEAR, FAR, INITIAL_POSITION } = CONFIG.CAMERA;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, NEAR, FAR);
    this.camera.position.copy(INITIAL_POSITION);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', precision: 'highp' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.RENDERER.PIXEL_RATIO_MAX));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.8;
    document.getElementById('container')?.appendChild(this.renderer.domElement);
  }
}

class LightingManager {
  public flashlight: THREE.SpotLight;
  public muzzleFlash: THREE.PointLight;

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    this.flashlight = new THREE.SpotLight(0xffffff, 100, 50, Math.PI / 6, 0.3, 1.5);
    this.flashlight.shadow.normalBias = 1;
    this.flashlight.castShadow = true;
    this.camera.add(this.flashlight);
    this.muzzleFlash = new THREE.PointLight(0xffaa33, 7, 100);
    this.muzzleFlash.visible = false;
    this.muzzleFlash.shadow.normalBias = 1;
    this.camera.add(this.muzzleFlash);
    this.setupLights();
  }

  private setupLights(): void {
    const moonLight = new THREE.DirectionalLight(0x8888ff, 0.5);
    moonLight.position.set(20, 100, 50);
    moonLight.castShadow = true;
    this.scene.add(moonLight);
    this.flashlight.visible = true;
  }

  public updateFlashlight(): void {
    this.camera.getWorldDirection(this.flashlight.target.position);
    this.flashlight.target.position.addVectors(this.camera.position, this.flashlight.target.position);
    if (!this.scene.children.includes(this.flashlight.target)) {
      this.scene.add(this.flashlight.target);
    }
    this.flashlight.position.set(0, 0, 0);
  }

  public toggleFlashlight(): void {
    this.flashlight.visible = !this.flashlight.visible;
  }

  public showMuzzleFlash(): void {
    this.muzzleFlash.visible = true;
    setTimeout(() => { this.muzzleFlash.visible = false; }, CONFIG.WEAPON.MUZZLE_FLASH_DURATION);
  }
}

type ZombieState = { health: number; dead: boolean; dying: boolean; deathTimer: number; };

class ModelManager {
  public zombieMixers: THREE.AnimationMixer[] = [];
  public zombies: THREE.Object3D[] = [];
  public fpsGun?: THREE.Object3D;
  public gunMixer?: THREE.AnimationMixer;
  public gunActions: THREE.AnimationAction[] = [];
  public zombieStates: ZombieState[] = [];
  public zombieGLTF: any;
  private loader: GLTFLoader;

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, loadingManager: THREE.LoadingManager) {
    this.loader = new GLTFLoader(loadingManager);
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.loadModels();
  }

  private loadModels(): void {
    this.loadMap();
    this.loadZombie();
    this.loadFPSGun();
  }

  private loadMap(): void {
    this.loader.load('/map.glb', (gltf) => {
      gltf.scene.traverse((o: any) => {
        o.castShadow = o.receiveShadow = true;
        if ((o as THREE.PointLight).isLight) {
          (o as THREE.PointLight).shadow.bias = -0.0009;
          o.visible = false;
          if (o.intensity !== undefined) o.intensity = 0;
        }
      });
      gltf.scene.position.y = -0.2;
      this.scene.add(gltf.scene);
    });
  }

  private loadZombie(): void {
    this.loader.load('/zombie_hazmat.glb', (gltf) => {
      this.zombieGLTF = gltf;
      const bounds = GAME_BOUNDS;
      const camPos = CONFIG.CAMERA.INITIAL_POSITION;

      for (let i = 0; i < CONFIG.ZOMBIE.COUNT; i++) {
        const model = SkeletonUtils.clone(gltf.scene);
        model.scale.set(1.5, 1.5, 1.5);
        let x = 0, z = 0, attempts = 0;
        const minSpawnDistance = 180;

        do {
          x = THREE.MathUtils.randFloat(bounds.minX, bounds.maxX);
          z = THREE.MathUtils.randFloat(bounds.minZ, bounds.maxZ);
          const distToPlayer = Math.hypot(x - camPos.x, z - camPos.z);
          const tooCloseToOther = this.zombies.some(zb => zb.position.distanceTo(new THREE.Vector3(x, 0.05, z)) < 2);
          if (distToPlayer >= minSpawnDistance && !tooCloseToOther) break;
        } while (++attempts < 20);

        model.position.set(x, 0.05, z);
        model.traverse(child => child.castShadow = child.receiveShadow = true);
        const mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(gltf.animations[3]);
        action.play();
        action.timeScale = 2;
        action.time = Math.random() * action.getClip().duration;

        this.zombieMixers.push(mixer);
        this.zombies.push(model);
        this.zombieStates.push({ health: 3, dead: false, dying: false, deathTimer: 0 });
        this.scene.add(model);
      }
    });
  }

  private loadFPSGun(): void {
    this.loader.load('/fps_gun_person_view.glb', (gltf) => {
      this.fpsGun = gltf.scene;
      this.fpsGun.scale.set(0.8, 0.8, 0.8);
      this.fpsGun.position.set(0.2, -0.5, -0.3);
      this.fpsGun.rotation.y = THREE.MathUtils.degToRad(-180);
      this.fpsGun.traverse(child => child.castShadow = child.receiveShadow = true);
      this.gunMixer = new THREE.AnimationMixer(this.fpsGun);
      this.gunActions = gltf.animations.map(a => this.gunMixer!.clipAction(a));
      this.camera.add(this.fpsGun);
    });
  }
}

class WeatherManager {
  private rainGroup: THREE.InstancedMesh;
  private splashGroup: THREE.InstancedMesh;
  private rainPos: Float32Array;
  private rainVel: Float32Array;
  private splashTimers: Float32Array;
  private tempMatrix = new THREE.Matrix4();
  private tempSplashMatrix = new THREE.Matrix4();
  private bounds = GAME_BOUNDS;

  constructor(scene: THREE.Scene) {
    const rainMat = new THREE.MeshStandardMaterial({ color: 0xaaaaee, transparent: true, opacity: 0.3, metalness: 0.4, roughness: 0.85, side: THREE.DoubleSide });
    this.rainGroup = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.02, 0.4), rainMat, CONFIG.RAIN.COUNT);
    const splashMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, transparent: true, opacity: 0.5, metalness: 0.4, side: THREE.FrontSide });
    this.splashGroup = new THREE.InstancedMesh(new THREE.CircleGeometry(0.05, 20), splashMat, CONFIG.RAIN.COUNT);
    this.rainPos = new Float32Array(CONFIG.RAIN.COUNT * 3);
    this.rainVel = new Float32Array(CONFIG.RAIN.COUNT);
    this.splashTimers = new Float32Array(CONFIG.RAIN.COUNT);
    this.initializeRainDrops();
    scene.add(this.rainGroup, this.splashGroup);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshStandardMaterial({ color: 0x111122, metalness: 0.8, roughness: 0.3, opacity: 0.1, transparent: true }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }

  private initializeRainDrops(): void {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const { HEIGHT_MIN, HEIGHT_MAX, FALL_SPEED_MIN, FALL_SPEED_MAX } = CONFIG.RAIN;

    for (let i = 0, idx = 0; i < CONFIG.RAIN.COUNT; i++) {
      this.rainPos[idx] = THREE.MathUtils.randFloat(minX, maxX);
      this.rainPos[idx + 1] = THREE.MathUtils.randFloat(HEIGHT_MIN, HEIGHT_MAX);
      this.rainPos[idx + 2] = THREE.MathUtils.randFloat(minZ, maxZ);
      this.rainVel[i] = THREE.MathUtils.randFloat(FALL_SPEED_MIN, FALL_SPEED_MAX);
      this.tempMatrix.setPosition(this.rainPos[idx], this.rainPos[idx + 1], this.rainPos[idx + 2]);
      this.rainGroup.setMatrixAt(i, this.tempMatrix);
      idx += 3;
    }
  }

  public updateRain(): void {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const { HEIGHT_MIN, HEIGHT_MAX } = CONFIG.RAIN;

    for (let i = 0, idx = 0; i < CONFIG.RAIN.COUNT; i++, idx += 3) {
      this.rainPos[idx + 1] -= this.rainVel[i];
      if (this.rainPos[idx + 1] < 0) {
        this.splashTimers[i] = 0.3;
        this.rainPos[idx] = THREE.MathUtils.randFloat(minX, maxX);
        this.rainPos[idx + 1] = THREE.MathUtils.randFloat(HEIGHT_MIN, HEIGHT_MAX);
        this.rainPos[idx + 2] = THREE.MathUtils.randFloat(minZ, maxZ);
      }
      this.tempMatrix.setPosition(this.rainPos[idx], this.rainPos[idx + 1], this.rainPos[idx + 2]);
      this.rainGroup.setMatrixAt(i, this.tempMatrix);
      if (this.splashTimers[i] > 0) {
        this.splashTimers[i] -= 0.016;
        this.tempSplashMatrix.makeRotationX(-Math.PI / 2);
        this.tempSplashMatrix.setPosition(this.rainPos[idx], 0.01, this.rainPos[idx + 2]);
        this.splashGroup.setMatrixAt(i, this.tempSplashMatrix);
      } else {
        this.tempSplashMatrix.makeScale(0, 0, 0);
        this.splashGroup.setMatrixAt(i, this.tempSplashMatrix);
      }
    }
    this.rainGroup.instanceMatrix.needsUpdate = true;
    this.splashGroup.instanceMatrix.needsUpdate = true;
  }
}

class WeaponManager {
  private bullets: THREE.Mesh[] = [];
  private bulletGeometry: THREE.SphereGeometry;
  private bulletMaterial: THREE.MeshBasicMaterial;
  private tempVector = new THREE.Vector3();
  private shakeOffset = new THREE.Vector3();
  private shakeIntensity = 100;
  private shakeStartTime = 0;
  private shakeDuration = 200;

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private gameState: GameState, private modelManager: ModelManager, private lightingManager: LightingManager) {
    this.bulletGeometry = new THREE.SphereGeometry(0.05, 4, 4);
    this.bulletMaterial = new THREE.MeshBasicMaterial({ color: 0xfff000 });
  }

  public playGunAction(idx: number): void {
    if (!this.modelManager.gunActions.length || idx === this.gameState.currentGunAction) return;
    this.modelManager.gunActions.forEach(a => a.stop());
    this.modelManager.gunActions[idx].reset().play();
    this.gameState.currentGunAction = idx;
    if (idx === 4) {
      this.gameState.shootTimer = 0.1;
    } else if (idx === 7) {
      this.gameState.reloadTimer = CONFIG.WEAPON.RELOAD_TIME;
      this.gameState.isReloading = true;
      playReloadSound();
      setTimeout(() => {
        this.gameState.ammo = CONFIG.WEAPON.MAX_AMMO;
        this.gameState.isReloading = false;
      }, CONFIG.WEAPON.RELOAD_TIME * 1000);
    }
  }

  private startCameraShake(): void {
    this.shakeIntensity = 0.1;
    this.shakeStartTime = Date.now();
  }

  private updateCameraShake(): void {
    if (this.shakeIntensity > 0.001) {
      const elapsed = Date.now() - this.shakeStartTime;
      const progress = Math.min(elapsed / this.shakeDuration, 1);

      const intensity = this.shakeIntensity * (1 - progress * progress);

      const previousShake = this.shakeOffset.clone();
      this.shakeOffset.set(
        (Math.random() - 0.5) * intensity,
        0,
        (Math.random() - 0.5) * intensity
      );

      this.camera.position.sub(previousShake).add(this.shakeOffset);

      if (progress >= 1) {
        this.shakeIntensity = 0;
        this.camera.position.sub(this.shakeOffset);
        this.shakeOffset.set(0, 0, 0);
      }
    }
  }

  public shoot(): void {
    this.playGunAction(4);
    this.startCameraShake();
    this.gameState.ammo--;
    const bullet = new THREE.Mesh(this.bulletGeometry, this.bulletMaterial);
    bullet.position.copy(this.camera.getWorldPosition(this.tempVector));
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    bullet.userData.velocity = dir.multiplyScalar(CONFIG.BULLET.SPEED);
    this.bullets.push(bullet);
    this.scene.add(bullet);
    this.lightingManager.showMuzzleFlash();
    playShotSound();
  }

  public updateBullets(delta: number): void {
    this.updateCameraShake();

    const speedDelta = delta * CONFIG.BULLET.SPEED;
    const box = new THREE.Box3();
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      bullet.position.addScaledVector(bullet.userData.velocity, speedDelta);
      if (bullet.position.length() > CONFIG.BULLET.MAX_DISTANCE) {
        this.scene.remove(bullet);
        this.bullets.splice(i, 1);
        continue;
      }
      for (let j = 0; j < this.modelManager.zombies.length; j++) {
        const zombie = this.modelManager.zombies[j];
        const state = this.modelManager.zombieStates[j];
        if (state.dead || state.dying) continue;
        box.setFromObject(zombie);
        if (box.containsPoint(bullet.position)) {
          if (--state.health <= 0) {
            state.health = 0;
            state.dying = true;
            state.deathTimer = 2;
            this.modelManager.zombieMixers[j].stopAllAction();
          }
          this.scene.remove(bullet);
          this.bullets.splice(i, 1);
          break;
        }
      }
    }
  }

  public canShoot(): boolean {
    return this.gameState.shootTimer <= 0 && !this.gameState.isReloading && this.gameState.ammo > 0;
  }

  public canReload(): boolean {
    return this.gameState.shootTimer <= 0 && !this.gameState.isReloading && this.gameState.ammo < CONFIG.WEAPON.MAX_AMMO;
  }
}

class EnemyManager {
  private zombieSoundStarted = false;
  private tempVec = new THREE.Vector3();
  private avoidVec = new THREE.Vector3();
  private moveVec = new THREE.Vector3();

  constructor(private gameState: GameState, private modelManager: ModelManager, private camera: THREE.PerspectiveCamera) { }

  public updateZombie(delta: number): void {
    const zombies = this.modelManager.zombies;
    if (!zombies.length) return;

    const avoidRadius = 1.0;
    const states = this.modelManager.zombieStates;
    let firstAliveZombieIdx = zombies.findIndex((_, i) => !states[i].dead && !states[i].dying);
    this.manageSounds(firstAliveZombieIdx !== -1 ? zombies[firstAliveZombieIdx] : null);

    for (let i = 0; i < zombies.length; i++) {
      const zombie = zombies[i];
      const state = states[i];
      if (state.dying) {
        this.processDyingZombie(zombie, state, delta);
        continue;
      }
      if (state.dead) continue;

      this.tempVec.subVectors(this.camera.position, zombie.position);
      this.tempVec.y = 0;
      const distance = this.tempVec.length();
      this.avoidVec.set(0, 0, 0);

      for (let j = 0; j < zombies.length; j++) {
        if (i === j || states[j].dead || states[j].dying) continue;
        const d = zombie.position.distanceTo(zombies[j].position);
        if (d < avoidRadius && d > 0) {
          this.tempVec.subVectors(zombie.position, zombies[j].position)
            .normalize()
            .multiplyScalar((avoidRadius - d) / avoidRadius);
          this.avoidVec.add(this.tempVec);
        }
      }

      this.moveVec.copy(this.tempVec.normalize()).multiplyScalar(CONFIG.ZOMBIE.SPEED * delta);
      if (this.avoidVec.lengthSq() > 0) {
        this.avoidVec.normalize().multiplyScalar(CONFIG.ZOMBIE.SPEED * delta * 0.7);
        this.moveVec.add(this.avoidVec);
      }

      if (distance > CONFIG.ZOMBIE.MIN_DISTANCE) {
        zombie.position.add(this.moveVec);
        zombie.lookAt(this.camera.position.x, zombie.position.y, this.camera.position.z);
      } else if (this.gameState.health > 0) {
        this.gameState.health -= CONFIG.ZOMBIE.DAMAGE_RATE * delta;
      }

      zombie.position.x = clamp(zombie.position.x, GAME_BOUNDS.minX, GAME_BOUNDS.maxX);
      zombie.position.z = clamp(zombie.position.z, GAME_BOUNDS.minZ, GAME_BOUNDS.maxZ);
    }
  }

  private manageSounds(aliveZombie: THREE.Object3D | null): void {
    if (aliveZombie) {
      if (!this.zombieSoundStarted && typeof zombieAudioBuffer !== "undefined" && zombieAudioBuffer) {
        playZombieSoundAt(aliveZombie.position, this.camera);
        this.zombieSoundStarted = true;
      }
      if (this.zombieSoundStarted) {
        updateZombieSoundPosition(aliveZombie, this.camera);
      }
    } else if (this.zombieSoundStarted) {
      if (zombieSource) {
        zombieSource.stop();
        zombieSource.disconnect();
        zombieSource = null;
      }
      if (zombiePanner) {
        zombiePanner.disconnect();
        zombiePanner = null;
      }
      this.zombieSoundStarted = false;
    }
  }

  private processDyingZombie(zombie: THREE.Object3D, state: any, delta: number): void {
    if (!state['deathAnimStarted']) {
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(zombie.quaternion);
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
      state['fallAxis'] = right;
      state['fallRot'] = 0;
      state['fallTarget'] = THREE.MathUtils.degToRad(THREE.MathUtils.randInt(70, 90));
      state['fallDirection'] = 1;
      state['deathAnimStarted'] = true;
    }

    const fallSpeed = THREE.MathUtils.degToRad(120) * delta;
    let rotateAmount = fallSpeed * state['fallDirection'];
    if (Math.abs(state['fallRot'] + rotateAmount) > state['fallTarget']) {
      rotateAmount = state['fallTarget'] * state['fallDirection'] - state['fallRot'];
    }
    zombie.rotateOnWorldAxis(state['fallAxis'], rotateAmount);
    state['fallRot'] += Math.abs(rotateAmount);

    if (state['fallRot'] >= state['fallTarget'] - 0.001) {
      state.dying = false;
      state.dead = true;
    }
  }
}

class UIManager {
  private ammoDisplay: HTMLElement;
  private healthFill: HTMLElement;
  private zombieProgressBar: HTMLElement;
  private zombieProgressFill: HTMLElement;
  private zombieProgressText: HTMLElement;
  private totalZombies: number;
  private maxAmmo: number;

  constructor(private gameState: GameState) {
    this.totalZombies = CONFIG.ZOMBIE.COUNT;
    this.createUI();
    this.maxAmmo = CONFIG.WEAPON.MAX_AMMO;
  }

  private createUI(): void {
    document.body.insertAdjacentHTML('beforeend', `
      <div style="position:fixed;top:20px;right:20px;color:#fff;font-family:sans-serif;font-size:16px;text-align:right;z-index:20">
        <div id="ammoDisplay">Ammo: ${this.maxAmmo} / ${this.maxAmmo}</div>
        <div id="healthBar" style="margin-top:8px;width:120px;height:16px;border:1px solid #fff">
          <div id="healthFill" style="background:#f00;width:100%;height:100%"></div>
        </div>
      </div>
      <div id="zombieProgressBar" style="position:fixed;top:20px;left:50%;transform:translateX(-50%);width:320px;height:22px;background:#222;border:2px solid #fff;border-radius:12px;z-index:30;box-shadow:0 2px 12px #000a;overflow:hidden;display:flex;align-items:center;">
        <div id="zombieProgressFill" style="background:#3cff3c;height:100%;width:0%;transition:width 0.2s;"></div>
        <span id="zombieProgressText" style="position:absolute;width:100%;text-align:center;color:#fff;font-weight:bold;letter-spacing:0.04em;font-size:15px;pointer-events:none;">0 / ${this.totalZombies} Zombies Killed</span>
      </div>
      <div style="position:fixed;top:50%;left:50%;width:8px;height:8px;background:#f00;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:10"></div>
    `);
    this.ammoDisplay = document.getElementById('ammoDisplay')!;
    this.healthFill = document.getElementById('healthFill')!;
    this.zombieProgressBar = document.getElementById('zombieProgressBar')!;
    this.zombieProgressFill = document.getElementById('zombieProgressFill')!;
    this.zombieProgressText = document.getElementById('zombieProgressText')!;
  }

  public updateUI(modelManager?: ModelManager): void {
    this.ammoDisplay.textContent = `Ammo: ${this.gameState.ammo} / ${this.maxAmmo}`;
    this.healthFill.style.width = `${this.gameState.health}%`;
    if (modelManager) {
      const killed = modelManager.zombieStates.filter(z => z.dead).length;
      const percent = Math.round((killed / this.totalZombies) * 100);
      this.zombieProgressFill.style.width = `${percent}%`;
      this.zombieProgressText.textContent = `${killed} / ${this.totalZombies} Zombies Killed`;
      this.zombieProgressBar.style.display = killed >= this.totalZombies ? 'none' : 'flex';
    }
  }

  public showZombieBar(): void {
    this.zombieProgressBar.style.display = 'flex';
  }
}

class InputManager {
  constructor(private gameState: GameState, private weaponManager: WeaponManager, private lightingManager: LightingManager, private controls: PointerLockControls) {
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.body.addEventListener('click', this.onClick);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.gameState.keysPressed[e.code] = true;
    if (e.code === 'KeyR' && this.weaponManager.canReload()) {
      this.weaponManager.playGunAction(7);
    } else if (e.code === 'KeyF') {
      this.gameState.flashlightOn = !this.gameState.flashlightOn;
      this.lightingManager.toggleFlashlight();
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.gameState.keysPressed[e.code] = false;
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.gameState.isShooting = true;
  }

  private onMouseUp = (): void => {
    this.gameState.isShooting = false;
  }

  private onClick = (): void => {
    this.controls.lock();
  }

  public isWalking(): boolean {
    const { keysPressed } = this.gameState;
    return keysPressed['KeyW'] || keysPressed['KeyA'] || keysPressed['KeyS'] || keysPressed['KeyD'];
  }
}

class GameLoadingManager {
  public manager: THREE.LoadingManager;
  private loadingScreen: HTMLElement;
  private loadingBar: HTMLElement;

  constructor(onLoad: () => void) {
    this.loadingScreen = document.getElementById('loading-screen')!;
    this.loadingBar = document.getElementById('loading-bar')!;
    this.manager = new THREE.LoadingManager();
    this.manager.onStart = () => { this.show(); this.setProgress(0); };
    this.manager.onProgress = (_url, itemsLoaded, itemsTotal) => { this.setProgress((itemsLoaded / itemsTotal) * 100); };
    this.manager.onLoad = () => {
      this.setProgress(100);
      setTimeout(() => { this.hide(); onLoad(); }, 400);
    };
    this.manager.onError = () => { this.hide(); onLoad(); };
  }

  public show() {
    if (this.loadingScreen) this.loadingScreen.style.display = 'flex';
  }

  public hide() {
    if (this.loadingScreen) this.loadingScreen.style.display = 'none';
  }

  private setProgress(percent: number) {
    if (this.loadingBar) this.loadingBar.style.width = `${percent}%`;
  }
}

class Game {
  private checkpoint: THREE.Object3D | null = null;
  private checkpointBox: THREE.Box3 | null = null;
  private checkpointMixer: THREE.AnimationMixer | null = null;
  private checkpointTriggered = false;
  private checkpoint2Active = false;
  private checkpoint2Triggered = false;
  private checkpoint3Active = false;
  private checkpoint3Triggered = false;
  private originalZombieCount = CONFIG.ZOMBIE.COUNT;
  private clock = new THREE.Clock();

  private breathingAmplitude = 0.02;
  private breathingSpeed = 3;
  private breathingOffset = 0;

  private bobbingAmplitude = 0.08;
  private bobbingSpeed = 12;
  private bobbingOffset = 0;

  private sceneManager: SceneManager;
  private gameState: GameState;
  private lightingManager: LightingManager;
  private modelManager: ModelManager;
  private weatherManager: WeatherManager;
  private weaponManager: WeaponManager;
  private enemyManager: EnemyManager;
  private uiManager: UIManager;
  private inputManager: InputManager;
  private controls: PointerLockControls;
  private composer: EffectComposer;

  private direction = new THREE.Vector3();
  private velocity = new THREE.Vector3();

  constructor(private loadingManager: GameLoadingManager) {
    this.initialize();
  }

  private initialize(): void {
    this.sceneManager = new SceneManager();
    this.gameState = new GameState();
    this.lightingManager = new LightingManager(this.sceneManager.scene, this.sceneManager.camera);
    this.modelManager = new ModelManager(this.sceneManager.scene, this.sceneManager.camera, this.loadingManager.manager);
    this.weatherManager = new WeatherManager(this.sceneManager.scene);
    this.weaponManager = new WeaponManager(this.sceneManager.scene, this.sceneManager.camera, this.gameState, this.modelManager, this.lightingManager);
    this.enemyManager = new EnemyManager(this.gameState, this.modelManager, this.sceneManager.camera);
    this.uiManager = new UIManager(this.gameState);
    this.setupPostProcessing();
    this.setupWindowEvents();
    this.loadCheckpoint();
  }

  private loadCheckpoint(): void {
    const loader = new GLTFLoader(this.loadingManager.manager);
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load('/checkpoint.glb', (gltf) => {
      this.checkpoint = gltf.scene;
      this.checkpoint.position.set(0, 0.7, 0);
      this.checkpoint.scale.set(10, 10, 10);
      this.sceneManager.scene.add(this.checkpoint);
      this.checkpointMixer = new THREE.AnimationMixer(this.checkpoint);
      this.checkpointMixer.clipAction(gltf.animations[0]).play();
      this.checkpointBox = new THREE.Box3().setFromObject(this.checkpoint);
    });
  }

  public startAfterLoading(): void {
    this.setupControls();
    this.inputManager = new InputManager(this.gameState, this.weaponManager, this.lightingManager, this.controls);
    this.uiManager.updateUI();
    this.animate();
  }

  private setupControls(): void {
    this.controls = new PointerLockControls(this.sceneManager.camera, this.sceneManager.renderer.domElement);
    this.sceneManager.scene.add(this.controls.object);
  }

  private setupPostProcessing(): void {
    this.composer = new EffectComposer(this.sceneManager.renderer);
    this.composer.addPass(new RenderPass(this.sceneManager.scene, this.sceneManager.camera));
    this.composer.addPass(new ShaderPass(GammaCorrectionShader));
  }

  private setupWindowEvents(): void {
    window.addEventListener('resize', () => {
      const { camera, renderer } = this.sceneManager;
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  private updateMovement(delta: number): void {
    const { keysPressed } = this.gameState;
    this.direction.set(0, 0, 0);
    if (keysPressed['KeyW']) this.direction.z += 1;
    if (keysPressed['KeyS']) this.direction.z -= 1;
    if (keysPressed['KeyA']) this.direction.x -= 1;
    if (keysPressed['KeyD']) this.direction.x += 1;
    if (this.direction.lengthSq() > 0) {
      this.direction.normalize();
      this.velocity.copy(this.direction).multiplyScalar(CONFIG.MOVEMENT.SPEED * delta);
      this.controls.moveRight(this.velocity.x);
      this.controls.moveForward(this.velocity.z);
      // Update bobbing offset based on movement
      this.bobbingOffset += this.bobbingSpeed * delta;
      this.sceneManager.camera.position.y = CONFIG.CAMERA.INITIAL_POSITION.y + Math.sin(this.bobbingOffset) * this.bobbingAmplitude;

      // Reset breathing offset when moving
      this.breathingOffset = 0;
    } else {
      // Breathing effect when standing still
      this.breathingOffset += this.breathingSpeed * delta;
      this.sceneManager.camera.position.y = CONFIG.CAMERA.INITIAL_POSITION.y + Math.sin(this.breathingOffset) * this.breathingAmplitude;
      // Reset bobbing when not moving
      this.bobbingOffset = 0;
    }
    const pos = this.sceneManager.camera.position;
    pos.x = clamp(pos.x, GAME_BOUNDS.minX, GAME_BOUNDS.maxX);
    pos.z = clamp(pos.z, GAME_BOUNDS.minZ, GAME_BOUNDS.maxZ);
  }

  private updateWeapon(delta: number): void {
    const { gameState, weaponManager, inputManager } = this;
    if (gameState.isShooting && weaponManager.canShoot()) {
      weaponManager.shoot();
      gameState.shootTimer = CONFIG.WEAPON.SHOOT_COOLDOWN;
      this.uiManager.updateUI();
    }
    weaponManager.updateBullets(delta);
    gameState.shootTimer -= delta;
    gameState.reloadTimer -= delta;

    if (this.modelManager.gunActions.length > 0 && gameState.shootTimer <= 0 && !gameState.isReloading) {
      weaponManager.playGunAction(inputManager.isWalking() ? 2 : 0);
    }
  }

  private updateAnimations(delta: number): void {
    this.modelManager.gunMixer?.update(delta);
    this.modelManager.zombieMixers.forEach(mixer => mixer.update(delta));
    this.checkpointMixer?.update(delta);
  }

  private updateNearbyStreetLights(): void {
    const scene = this.sceneManager.scene;
    if (!scene) return;

    const playerPos = this.sceneManager.camera.position;
    const pointLights: any[] = [];

    scene.traverse((obj: any) => {
      if (obj.isPointLight && obj !== this.lightingManager.muzzleFlash) {
        obj._distanceToPlayer = obj.position.distanceTo(playerPos);
        pointLights.push(obj);
      }
    });

    pointLights.sort((a, b) => a._distanceToPlayer - b._distanceToPlayer);

    pointLights.forEach((light, i) => {
      const isActive = i < 4;
      light.visible = isActive;
      if (light.intensity !== undefined) {
        light.intensity = isActive ? 100 : 0;
      }
    });
  }

  private animate(): void {
    requestAnimationFrame(() => this.animate());
    const delta = this.clock.getDelta();
    this.updateMovement(delta);
    this.updateWeapon(delta);
    this.updateAnimations(delta);
    this.weatherManager.updateRain();
    this.enemyManager.updateZombie(delta);
    this.lightingManager.updateFlashlight();
    this.uiManager.updateUI(this.modelManager);

    if (this.gameState.health <= 0) {
      showMissionFailedOverlay();
      return;
    }

    this.checkCheckpoint();
    this.checkSecondCheckpoint();
    this.checkThirdCheckpoint();

    if (this.checkpoint2Triggered) {
      this.updateNearbyStreetLights();
    }

    this.composer.render();
  }

  private checkCheckpoint(): void {
    if (this.checkpointTriggered || !this.checkpoint || !this.checkpointBox) return;

    this.checkpointBox.setFromObject(this.checkpoint);
    const playerPos = this.sceneManager.camera.position;
    const { min, max } = this.checkpointBox;

    if (playerPos.x >= min.x && playerPos.x <= max.x && playerPos.z >= min.z && playerPos.z <= max.z) {
      this.checkpointTriggered = true;
      playSpeechAudio1();
      if (this.checkpoint) this.checkpoint.visible = false;
      this.checkpointBox = null;
      this.checkpointMixer = null;
    }
  }

  private checkSecondCheckpoint(): void {
    const { modelManager } = this;
    if (!this.checkpoint2Active && modelManager && modelManager.zombieStates) {
      const killed = modelManager.zombieStates.filter(z => z.dead).length;
      if (killed >= modelManager.zombieStates.length) {
        document.getElementById("start-screen")?.style.setProperty("display", "none");
        document.getElementById("loading-screen")?.style.setProperty("display", "none");
        if (this.checkpoint) {
          this.checkpoint.position.set(0, 0.7, -400);
          this.checkpoint.scale.set(10, 10, 10);
          this.checkpoint.visible = true;
          this.checkpointBox = new THREE.Box3().setFromObject(this.checkpoint);
          this.checkpoint2Active = true;
          this.checkpoint2Triggered = false;
        }
      }
    }

    if (this.checkpoint2Active && this.checkpoint && this.checkpointBox && !this.checkpoint2Triggered) {
      this.checkpointBox.setFromObject(this.checkpoint);
      const playerPos = this.sceneManager.camera.position;
      const { min, max } = this.checkpointBox;

      if (playerPos.x >= min.x && playerPos.x <= max.x && playerPos.z >= min.z && playerPos.z <= max.z) {
        this.checkpoint2Triggered = true;
        if (this.checkpoint) this.checkpoint.visible = false;
        this.afterSecondCheckpoint();
      }
    }
  }

  private checkThirdCheckpoint(): void {
    const { modelManager } = this;
    if (!this.checkpoint3Active && this.checkpoint2Triggered && modelManager && modelManager.zombieStates) {
      const killed = modelManager.zombieStates.filter(z => z.dead).length;
      if (killed >= modelManager.zombieStates.length) {
        const pos = CONFIG.CAMERA.INITIAL_POSITION;
        if (this.checkpoint) {
          this.checkpoint.position.set(pos.x, 0.7, pos.z);
          this.checkpoint.scale.set(10, 10, 10);
          this.checkpoint.visible = true;
          this.checkpointBox = new THREE.Box3().setFromObject(this.checkpoint);
          this.checkpoint3Active = true;
          this.checkpoint3Triggered = false;
        }
      }
    }

    if (this.checkpoint3Active && this.checkpoint && this.checkpointBox && !this.checkpoint3Triggered) {
      this.checkpointBox.setFromObject(this.checkpoint);
      const playerPos = this.sceneManager.camera.position;
      const { min, max } = this.checkpointBox;

      if (playerPos.x >= min.x && playerPos.x <= max.x && playerPos.z >= min.z && playerPos.z <= max.z) {
        this.checkpoint3Triggered = true;
        if (this.checkpoint) this.checkpoint.visible = false;
        showMissionCompleteOverlay();
      }
    }
  }

  private afterSecondCheckpoint(): void {
    this.gameState.flashlightOn = false;
    this.lightingManager.flashlight.visible = false;
    this.updateNearbyStreetLights();
    this.respawnZombies();
    this.uiManager.showZombieBar();
    playSpeechAudio2();
  }

  private respawnZombies(): void {
    const { modelManager, sceneManager } = this;
    modelManager.zombies.forEach(zombie => sceneManager.scene.remove(zombie));
    modelManager.zombies = [];
    modelManager.zombieMixers = [];
    modelManager.zombieStates = [];

    if (modelManager.zombieGLTF) {
      this.spawnZombiesFromGLTF(modelManager.zombieGLTF, this.originalZombieCount);
    } else {
      console.error('Zombie GLTF not loaded! Cannot respawn zombies.');
    }
  }

  private spawnZombiesFromGLTF(gltf: any, count: number): void {
    const { modelManager, sceneManager } = this;
    const { minX, maxX, minZ, maxZ } = GAME_BOUNDS;
    const initialPos = CONFIG.CAMERA.INITIAL_POSITION;

    for (let i = 0; i < count; i++) {
      const model = SkeletonUtils.clone(gltf.scene);
      model.scale.set(1.5, 1.5, 1.5);
      let x = 0, z = 0, attempts = 0;
      const minSpawnDistance = 180;

      do {
        x = THREE.MathUtils.randFloat(minX, maxX);
        z = THREE.MathUtils.randFloat(minZ, maxZ);
        const distToPlayer = Math.hypot(x - initialPos.x, z - initialPos.z);
        const tooCloseToOther = modelManager.zombies.some(zb => zb.position.distanceTo(new THREE.Vector3(x, 0.05, z)) < 2);
        if (distToPlayer >= minSpawnDistance && !tooCloseToOther) break;
      } while (++attempts < 20);

      model.position.set(x, 0.05, z);
      model.traverse(child => child.castShadow = child.receiveShadow = true);
      const mixer = new THREE.AnimationMixer(model);
      const action = mixer.clipAction(gltf.animations[3]);
      action.play();
      action.timeScale = 2;
      action.time = Math.random() * action.getClip().duration;

      modelManager.zombieMixers.push(mixer);
      modelManager.zombies.push(model);
      modelManager.zombieStates.push({ health: 3, dead: false, dying: false, deathTimer: 0 });
      sceneManager.scene.add(model);
    }
  }
}

// -- Audio and main code unchanged from your original (not shown for brevity) --

// Audio elements and contexts
let rainAudio: HTMLAudioElement;
let bgAudio: HTMLAudioElement;
let zombieAudioContext: AudioContext | null = null;
let zombieAudioBuffer: AudioBuffer | null = null;
let zombieSource: AudioBufferSourceNode | null = null;
let zombiePanner: PannerNode | null = null;

// Setup audio elements with shared configuration
function setupAudio(src: string, volume: number, loop = true): HTMLAudioElement {
  const audio = document.createElement('audio');
  audio.src = src;
  audio.loop = loop;
  audio.volume = volume;
  audio.style.display = 'none';
  document.body.appendChild(audio);

  if (loop) {
    audio.addEventListener('ended', () => {
      audio.currentTime = 0;
      audio.play().catch(() => { });
    });
  }

  return audio;
}

function setupRainAudio() {
  rainAudio = setupAudio('/rain.ogg', 0.2);
}

function setupBgAudio() {
  bgAudio = setupAudio('/bgsound.ogg', 0.8);
}

// Play temporary sound effects
function playSound(src: string, volume: number): void {
  const audio = setupAudio(src, volume, false);
  audio.autoplay = true;
  audio.addEventListener('ended', () => audio.remove());
}

function playShotSound() {
  playSound('/shot.ogg', 0.2);
}

function playReloadSound() {
  playSound('/reload.ogg', 0.7);
}

// Positional zombie audio functions
async function loadZombieAudioBuffer() {
  if (!zombieAudioContext) {
    zombieAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }

  const response = await fetch('/zombie.ogg');
  const arrayBuffer = await response.arrayBuffer();
  zombieAudioBuffer = await zombieAudioContext.decodeAudioData(arrayBuffer);
}

function playZombieSoundAt(position: THREE.Vector3, camera: THREE.PerspectiveCamera) {
  if (!zombieAudioContext || !zombieAudioBuffer) return;

  if (zombieSource) {
    zombieSource.stop();
    zombieSource.disconnect();
    zombieSource = null;
  }

  if (zombiePanner) {
    zombiePanner.disconnect();
    zombiePanner = null;
  }

  zombieSource = zombieAudioContext.createBufferSource();
  zombieSource.buffer = zombieAudioBuffer;
  zombieSource.loop = true;

  zombiePanner = zombieAudioContext.createPanner();
  zombiePanner.panningModel = 'HRTF';
  zombiePanner.distanceModel = 'linear';
  zombiePanner.refDistance = 1;
  zombiePanner.maxDistance = 100;
  zombiePanner.rolloffFactor = 1;
  zombiePanner.setPosition(position.x, position.y, position.z);

  zombieSource.connect(zombiePanner).connect(zombieAudioContext.destination);
  zombieSource.start(0);
  updateZombieAudioListener(camera);
}

function updateZombieAudioListener(camera: THREE.PerspectiveCamera) {
  if (!zombieAudioContext) return;

  const listener = zombieAudioContext.listener;
  const pos = camera.position;
  listener.setPosition(pos.x, pos.y, pos.z);

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  listener.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
}

function updateZombieSoundPosition(zombie: THREE.Object3D, camera: THREE.PerspectiveCamera) {
  if (zombiePanner) {
    zombiePanner.setPosition(zombie.position.x, zombie.position.y, zombie.position.z);
    updateZombieAudioListener(camera);
  }
}

// Audio volume management
function fadeAudio(audio: HTMLAudioElement, targetVolume: number, duration: number = 1000) {
  if (!audio) return;

  if (audio.paused) {
    audio.loop = true;
    audio.play().catch(() => { });
  }

  const startVolume = audio.volume;
  const startTime = performance.now();

  function step(now: number) {
    const t = Math.min((now - startTime) / duration, 1);
    audio.volume = startVolume + (targetVolume - startVolume) * t;

    if (t < 1) {
      requestAnimationFrame(step);
    }
  }

  requestAnimationFrame(step);
}

function fadeAllBackgroundAudio(target: number, duration: number = 1000) {
  [rainAudio, bgAudio].forEach(audio => {
    if (audio && audio.paused) {
      audio.loop = true;
      audio.play().catch(() => { });
    }
  });

  fadeAudio(rainAudio, 0.2 * target, duration);
  fadeAudio(bgAudio, 0.8 * target, duration);

  if (zombieAudioContext && zombieSource) {
    if (!(zombieSource as any)._gainNode) {
      const gainNode = zombieAudioContext.createGain();
      gainNode.gain.value = target;

      if (zombiePanner) {
        zombiePanner.disconnect();
        zombiePanner.connect(gainNode).connect(zombieAudioContext.destination);
      }

      (zombieSource as any)._gainNode = gainNode;
    }

    const gainNode = (zombieSource as any)._gainNode as GainNode;
    gainNode.gain.cancelScheduledValues(zombieAudioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(target, zombieAudioContext.currentTime + duration / 1000);
  }
}

// Speech and subtitles
function playSpeech(src: string, subtitle: string, duration: number, onEnd?: () => void) {
  fadeAllBackgroundAudio(0.3, 800);
  showSubtitle(subtitle, duration);

  const audio = setupAudio(src, 1.0, false);
  audio.autoplay = true;

  audio.addEventListener('ended', () => {
    audio.remove();
    const subtitleBox = document.getElementById('subtitle-box');
    if (subtitleBox) subtitleBox.style.display = 'none';
    fadeAllBackgroundAudio(1, 1200);
    if (onEnd) onEnd();
  });
}

function playSpeechAudio1() {
  playSpeech(
    '/speech_audio_1.ogg',
    "Zeta to Echo Unit, we lost Sector 7 to the infected. Head straight through the breach, clear out hostiles, and reach the electric box. Once it's fixed, streetlights'll light the whole damn sector. Move fast. We're counting on you.",
    15000
  );
}

function playSpeechAudio2(onEnd?: () => void) {
  playSpeech(
    '/speech_audio_2.ogg',
    "Sector clear. Good work, Echo. Stand by for further orders.",
    8000,
    onEnd
  );
}

function showSubtitle(text: string, duration: number) {
  const subtitleBox = document.getElementById('subtitle-box') as HTMLDivElement;
  subtitleBox.textContent = text;
  subtitleBox.style.display = 'block';

  setTimeout(() => subtitleBox.style.display = 'none', duration);
}

// Game overlays
function showMissionFailedOverlay() {
  document.getElementById("mission-failed-overlay")!.style.display = "block";
  document.exitPointerLock?.();
}

function showMissionCompleteOverlay() {
  document.getElementById("mission-complete-overlay")!.style.display = "block";
  document.exitPointerLock?.();
}

// Main function
function main() {
  setupRainAudio();
  setupBgAudio();

  const elements = {
    startButton: document.getElementById("start-button") as HTMLElement,
    startScreen: document.getElementById("start-screen") as HTMLElement,
    loadingScreen: document.getElementById("loading-screen") as HTMLElement,
    container: document.getElementById("container") as HTMLElement
  };

  elements.startScreen.style.display = "flex";
  elements.loadingScreen.style.display = "none";
  elements.container.style.display = "none";

  let game: Game | null = null;

  elements.startButton.addEventListener("click", () => {
    elements.startScreen.style.display = "none";
    elements.loadingScreen.style.display = "flex";
    elements.container.style.display = "block";

    const loadingManager = new GameLoadingManager(() => {
      elements.loadingScreen.style.display = "none";
      showClickToPlay(async () => {
        if (!game) {
          game = new Game(loadingManager);
          (window as any).game = game;
        }

        [rainAudio, bgAudio].forEach(audio => {
          if (audio) {
            audio.loop = true;
            audio.play().catch(() => { });
          }
        });

        await loadZombieAudioBuffer();
        game.startAfterLoading();
      });
    });

    game = new Game(loadingManager);
    (window as any).game = game;
  });
}

function showClickToPlay(onClick: () => void) {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'z-index:200;color:#fff;cursor:pointer;';

  overlay.innerHTML = `
    <div style="font-size:2rem">Click to Play</div>
    <div style="font-size:1.2rem;margin-top:1.5rem;text-align:center">
      Use <b>W A S D</b> to move<br/><br/>
      Press <b>R</b> to reload<br/><br/>
      Press <b>F</b> to toggle flashlight
    </div>
  `;

  overlay.addEventListener('click', () => {
    overlay.remove();
    onClick();
  });

  document.body.appendChild(overlay);
}

main();
