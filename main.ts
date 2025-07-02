import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const CONFIG = {
  CAMERA: {
    FOV: 55,
    NEAR: 0.1,
    FAR: 1000,
    INITIAL_POSITION: { x: 0, y: 2, z: 30 }
  },
  RENDERER: {
    PIXEL_RATIO_MAX: 1.5
  },
  MOVEMENT: {
    SPEED: 10
  },
  WEAPON: {
    MAX_AMMO: 40,
    SHOOT_COOLDOWN: 0.15,
    RELOAD_TIME: 3.5,
    MUZZLE_FLASH_DURATION: 50
  },
  ZOMBIE: {
    SPEED: 0.9, // increased for more visible movement
    DAMAGE_RATE: 10,
    MIN_DISTANCE: 0.5,
    COUNT: 200
  },
  RAIN: {
    COUNT: 1000,
    FALL_SPEED_MIN: 0.3,
    FALL_SPEED_MAX: 0.8,
    SPAWN_RANGE: 25,
    HEIGHT_MIN: 60,
    HEIGHT_MAX: 100
  },
  BULLET: {
    SPEED: 20,
    MAX_DISTANCE: 200
  },
  PLAYER: {
    INITIAL_HEALTH: 100
  }
};

const GAME_BOUNDS = {
  minX: -10.46,
  maxX: 34.43,
  minZ: -422.50,
  maxZ: 17.26
};

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

class GameState {
  public ammo: number = CONFIG.WEAPON.MAX_AMMO;
  public maxAmmo: number = CONFIG.WEAPON.MAX_AMMO;
  public health: number = CONFIG.PLAYER.INITIAL_HEALTH;
  public shootTimer: number = 0;
  public reloadTimer: number = 0;
  public isReloading: boolean = false;
  public isShooting: boolean = false;
  public flashlightOn: boolean = false;
  public currentGunAction: number = -1;
  public keysPressed: Record<string, boolean> = {};
}

class SceneManager {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      CONFIG.CAMERA.FOV,
      window.innerWidth / window.innerHeight,
      CONFIG.CAMERA.NEAR,
      CONFIG.CAMERA.FAR
    );
    this.camera.position.set(
      CONFIG.CAMERA.INITIAL_POSITION.x,
      CONFIG.CAMERA.INITIAL_POSITION.y,
      CONFIG.CAMERA.INITIAL_POSITION.z
    );
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      precision: 'mediump'
    });
    this.setupRenderer();
  }

  private setupRenderer(): void {
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.RENDERER.PIXEL_RATIO_MAX));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    document.getElementById('container')?.appendChild(this.renderer.domElement);
  }
}

class LightingManager {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  public flashlight: THREE.SpotLight;
  public muzzleFlash: THREE.PointLight;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
    this.setupLights();
  }

  private setupLights(): void {
    const ambientLight = new THREE.AmbientLight(0x222244, 0.8);
    this.scene.add(ambientLight);
    const moonLight = new THREE.DirectionalLight(0x8888ff, 0.5);
    moonLight.position.set(20, 100, 50);
    moonLight.castShadow = true;
    this.scene.add(moonLight);

    this.flashlight = new THREE.SpotLight(0xffffff, 100, 50, Math.PI / 6, 0.3, 1.5);
    this.flashlight.shadow.normalBias = 1;
    this.flashlight.castShadow = true;
    this.flashlight.position.set(0, 0, 0);
    this.flashlight.visible = false;
    this.camera.add(this.flashlight);

    this.muzzleFlash = new THREE.PointLight(0xffaa33, 7, 100);
    this.muzzleFlash.visible = false;
    this.muzzleFlash.castShadow = true;
    this.muzzleFlash.shadow.normalBias = 1;
    this.muzzleFlash.position.set(0, 0, -1.5);
    this.camera.add(this.muzzleFlash);
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
    setTimeout(() => {
      this.muzzleFlash.visible = false;
    }, CONFIG.WEAPON.MUZZLE_FLASH_DURATION);
  }
}

class ModelManager {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private loader: GLTFLoader;

  public zombieMixers: THREE.AnimationMixer[] = [];
  public zombies: THREE.Object3D[] = [];
  public fpsGun?: THREE.Object3D;
  public gunMixer?: THREE.AnimationMixer;
  public gunActions: THREE.AnimationAction[] = [];
  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, loadingManager: THREE.LoadingManager) {
    this.scene = scene;
    this.camera = camera;
    this.loader = new GLTFLoader(loadingManager);
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
        if (o.animations && o.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(o);
          mixer.clipAction(o.animations[1]).play();
        }
        if ((o as THREE.PointLight).isLight) {
          (o as THREE.PointLight).shadow.bias = -0.0009;
        }
      });
      gltf.scene.position.y = -0.2;
      this.scene.add(gltf.scene);
    });
  }

  private loadZombie(): void {
    this.loader.load('/zombie_hazmat.glb', (gltf) => {
      for (let i = 0; i < CONFIG.ZOMBIE.COUNT; i++) {
        const model = SkeletonUtils.clone(gltf.scene);
        model.scale.set(1.5, 1.5, 1.5);

        let x, z;
        do {
          x = THREE.MathUtils.randFloat(GAME_BOUNDS.minX, GAME_BOUNDS.maxX);
          z = THREE.MathUtils.randFloat(GAME_BOUNDS.minZ, GAME_BOUNDS.maxZ);
        } while (Math.abs(x) < 5 && Math.abs(z - CONFIG.CAMERA.INITIAL_POSITION.z) < 10);

        model.position.set(x, 0.05, z);

        model.traverse((child: any) => {
          child.castShadow = child.receiveShadow = true;
        });

        const mixer = new THREE.AnimationMixer(model);
        const walkAnim = gltf.animations.find(a => a.name.toLowerCase().includes('walk')) || gltf.animations[0];
        const action = mixer.clipAction(walkAnim);
        action.play();
        action.timeScale = 2;

        this.zombieMixers.push(mixer);
        this.zombies.push(model);
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
      this.fpsGun.traverse((child: any) => {
        child.castShadow = child.receiveShadow = true;
      });
      this.gunMixer = new THREE.AnimationMixer(this.fpsGun);
      this.gunActions = gltf.animations.map((a) => this.gunMixer!.clipAction(a));
      this.camera.add(this.fpsGun);
    });
  }
}

class WeatherManager {
  private scene: THREE.Scene;
  private rainGroup: THREE.InstancedMesh;
  private splashGroup: THREE.InstancedMesh;
  private rainPositions: Float32Array;
  private rainVelocities: Float32Array;
  private splashTimers: Float32Array;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.setupRain();
    this.setupGround();
  }

  private setupRain(): void {
    const rainGeometry = new THREE.PlaneGeometry(0.02, 0.4);
    const rainMaterial = new THREE.MeshStandardMaterial({
      color: 0xaaaaee,
      transparent: true,
      opacity: 0.3,
      metalness: 0.4,
      roughness: 0.85,
      side: THREE.DoubleSide
    });
    this.rainGroup = new THREE.InstancedMesh(rainGeometry, rainMaterial, CONFIG.RAIN.COUNT);
    this.rainPositions = new Float32Array(CONFIG.RAIN.COUNT * 3);
    this.rainVelocities = new Float32Array(CONFIG.RAIN.COUNT);

    const splashGeometry = new THREE.CircleGeometry(0.05, 20);
    const splashMaterial = new THREE.MeshStandardMaterial({
      color: 0xdddddd,
      emissive: 0,
      transparent: true,
      opacity: 0.5,
      metalness: 0.4,
      side: THREE.FrontSide
    });
    this.splashGroup = new THREE.InstancedMesh(splashGeometry, splashMaterial, CONFIG.RAIN.COUNT);
    this.splashTimers = new Float32Array(CONFIG.RAIN.COUNT);

    this.initializeRainDrops();
    this.scene.add(this.rainGroup);
    this.scene.add(this.splashGroup);
  }

  private initializeRainDrops(): void {
    for (let i = 0; i < CONFIG.RAIN.COUNT; i++) {
      this.rainPositions[i * 3 + 0] = THREE.MathUtils.randFloat(-CONFIG.RAIN.SPAWN_RANGE, CONFIG.RAIN.SPAWN_RANGE);
      this.rainPositions[i * 3 + 1] = THREE.MathUtils.randFloat(0, 100);
      this.rainPositions[i * 3 + 2] = THREE.MathUtils.randFloat(-CONFIG.RAIN.SPAWN_RANGE, CONFIG.RAIN.SPAWN_RANGE);
      this.rainVelocities[i] = THREE.MathUtils.randFloat(CONFIG.RAIN.FALL_SPEED_MIN, CONFIG.RAIN.FALL_SPEED_MAX);
      this.rainGroup.setMatrixAt(i, new THREE.Matrix4().setPosition(
        this.rainPositions[i * 3 + 0],
        this.rainPositions[i * 3 + 1],
        this.rainPositions[i * 3 + 2]
      ));
    }
  }

  private setupGround(): void {
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
    this.scene.add(ground);
  }

  public updateRain(): void {
    const tempMatrix = new THREE.Matrix4();
    const tempSplashMatrix = new THREE.Matrix4();

    for (let i = 0; i < CONFIG.RAIN.COUNT; i++) {
      this.rainPositions[i * 3 + 1] -= this.rainVelocities[i];

      if (this.rainPositions[i * 3 + 1] < 0) {
        this.splashTimers[i] = 0.3;
        this.rainPositions[i * 3 + 0] = THREE.MathUtils.randFloat(-CONFIG.RAIN.SPAWN_RANGE, CONFIG.RAIN.SPAWN_RANGE);
        this.rainPositions[i * 3 + 1] = THREE.MathUtils.randFloat(CONFIG.RAIN.HEIGHT_MIN, CONFIG.RAIN.HEIGHT_MAX);
        this.rainPositions[i * 3 + 2] = THREE.MathUtils.randFloat(-CONFIG.RAIN.SPAWN_RANGE, CONFIG.RAIN.SPAWN_RANGE);
      }

      tempMatrix.setPosition(
        this.rainPositions[i * 3 + 0],
        this.rainPositions[i * 3 + 1],
        this.rainPositions[i * 3 + 2]
      );
      this.rainGroup.setMatrixAt(i, tempMatrix);

      if (this.splashTimers[i] > 0) {
        this.splashTimers[i] -= 0.016;
        tempSplashMatrix.makeRotationX(-Math.PI / 2);
        tempSplashMatrix.setPosition(
          this.rainPositions[i * 3 + 0],
          0.01,
          this.rainPositions[i * 3 + 2]
        );
        this.splashGroup.setMatrixAt(i, tempSplashMatrix);
      } else {
        this.splashGroup.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
      }
    }

    this.rainGroup.instanceMatrix.needsUpdate = true;
    this.splashGroup.instanceMatrix.needsUpdate = true;
  }
}

class WeaponManager {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private gameState: GameState;
  private modelManager: ModelManager;
  private lightingManager: LightingManager;
  private bullets: THREE.Mesh[] = [];
  private bulletGeometry: THREE.SphereGeometry;
  private bulletMaterial: THREE.MeshBasicMaterial;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    gameState: GameState,
    modelManager: ModelManager,
    lightingManager: LightingManager
  ) {
    this.scene = scene;
    this.camera = camera;
    this.gameState = gameState;
    this.modelManager = modelManager;
    this.lightingManager = lightingManager;
    this.setupBullets();
  }

  private setupBullets(): void {
    this.bulletGeometry = new THREE.SphereGeometry(0.05, 4, 4);
    this.bulletMaterial = new THREE.MeshBasicMaterial({ color: 0xfff000 });
  }

  public playGunAction(idx: number): void {
    if (!this.modelManager.gunActions.length || idx === this.gameState.currentGunAction) return;

    this.modelManager.gunActions.forEach((a) => a.stop());
    this.modelManager.gunActions[idx].reset().play();
    this.gameState.currentGunAction = idx;

    if (idx === 4) this.gameState.shootTimer = 0.1;
    if (idx === 7) {
      this.gameState.reloadTimer = CONFIG.WEAPON.RELOAD_TIME;
      this.gameState.isReloading = true;
      playReloadSound();
      setTimeout(() => {
        this.gameState.ammo = this.gameState.maxAmmo;
        this.gameState.isReloading = false;
      }, CONFIG.WEAPON.RELOAD_TIME * 1000);
    }
  }

  public shoot(): void {
    this.playGunAction(4);
    this.gameState.ammo--;

    const bullet = new THREE.Mesh(this.bulletGeometry, this.bulletMaterial);
    bullet.position.copy(this.camera.position);
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    bullet.userData.velocity = dir.clone().multiplyScalar(CONFIG.BULLET.SPEED);
    this.bullets.push(bullet);
    this.scene.add(bullet);

    this.lightingManager.showMuzzleFlash();

    playShotSound();
  }

  public updateBullets(delta: number): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      bullet.position.add(bullet.userData.velocity.clone().multiplyScalar(delta * CONFIG.BULLET.SPEED));
      if (bullet.position.length() > CONFIG.BULLET.MAX_DISTANCE) {
        this.scene.remove(bullet);
        this.bullets.splice(i, 1);
      }
    }
  }

  public canShoot(): boolean {
    return this.gameState.shootTimer <= 0 && !this.gameState.isReloading && this.gameState.ammo > 0;
  }

  public canReload(): boolean {
    return this.gameState.shootTimer <= 0 && !this.gameState.isReloading && this.gameState.ammo < this.gameState.maxAmmo;
  }
}

class EnemyManager {
  private gameState: GameState;
  private modelManager: ModelManager;
  private camera: THREE.PerspectiveCamera;
  private zombieSoundStarted = false;

  constructor(gameState: GameState, modelManager: ModelManager, camera: THREE.PerspectiveCamera) {
    this.gameState = gameState;
    this.modelManager = modelManager;
    this.camera = camera;
  }

  public updateZombie(delta: number): void {
    if (!this.modelManager.zombies.length) return;

    for (let i = 0; i < this.modelManager.zombies.length; i++) {
      const zombie = this.modelManager.zombies[i];

      if (i === 0 && !this.zombieSoundStarted && zombieAudioBuffer) {
        playZombieSoundAt(zombie.position, this.camera);
        this.zombieSoundStarted = true;
      }
      if (i === 0 && this.zombieSoundStarted) {
        updateZombieSoundPosition(zombie, this.camera);
      }

      const direction = new THREE.Vector3().subVectors(this.camera.position, zombie.position);
      direction.y = 0;
      const distance = direction.length();

      if (distance > CONFIG.ZOMBIE.MIN_DISTANCE) {
        zombie.position.add(direction.normalize().multiplyScalar(CONFIG.ZOMBIE.SPEED * delta));
        zombie.lookAt(this.camera.position.x, zombie.position.y, this.camera.position.z);
      } else if (this.gameState.health > 0) {
        this.gameState.health -= CONFIG.ZOMBIE.DAMAGE_RATE * delta;
      }

      zombie.position.x = clamp(zombie.position.x, GAME_BOUNDS.minX, GAME_BOUNDS.maxX);
      zombie.position.z = clamp(zombie.position.z, GAME_BOUNDS.minZ, GAME_BOUNDS.maxZ);
    }
  }
}

class UIManager {
  private gameState: GameState;
  private ammoDisplay: HTMLElement;
  private healthFill: HTMLElement;

  constructor(gameState: GameState) {
    this.gameState = gameState;
    this.setupUI();
  }

  private setupUI(): void {
    const ui = document.createElement('div');
    ui.innerHTML = `
      <div style="position:fixed;top:20px;right:20px;color:#fff;font-family:sans-serif;font-size:16px;text-align:right;z-index:20">
        <div id="ammoDisplay">Ammo: ${CONFIG.WEAPON.MAX_AMMO} / ${CONFIG.WEAPON.MAX_AMMO}</div>
        <div id="healthBar" style="margin-top:8px;width:120px;height:16px;border:1px solid #fff">
          <div id="healthFill" style="background:#f00;width:100%;height:100%"></div>
        </div>
      </div>
    `;
    document.body.appendChild(ui);

    this.ammoDisplay = document.getElementById('ammoDisplay')!;
    this.healthFill = document.getElementById('healthFill')! as HTMLDivElement;

    this.setupAimDot();
  }

  private setupAimDot(): void {
    const aimDot = document.createElement('div');
    aimDot.style.cssText = `
      position:fixed;
      top:50%;
      left:50%;
      width:8px;
      height:8px;
      background:#f00;
      border-radius:50%;
      transform:translate(-50%,-50%);
      pointer-events:none;
      z-index:10
    `;
    document.body.appendChild(aimDot);
  }

  public updateUI(): void {
    this.ammoDisplay.textContent = `Ammo: ${this.gameState.ammo} / ${this.gameState.maxAmmo}`;
    this.healthFill.style.width = `${this.gameState.health}%`;
  }
}

class InputManager {
  private gameState: GameState;
  private weaponManager: WeaponManager;
  private lightingManager: LightingManager;
  private controls: PointerLockControls;

  constructor(
    gameState: GameState,
    weaponManager: WeaponManager,
    lightingManager: LightingManager,
    controls: PointerLockControls
  ) {
    this.gameState = gameState;
    this.weaponManager = weaponManager;
    this.lightingManager = lightingManager;
    this.controls = controls;
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    document.addEventListener('keydown', (e) => {
      this.gameState.keysPressed[e.code] = true;
      this.handleKeyDown(e.code);
    });

    document.addEventListener('keyup', (e) => {
      this.gameState.keysPressed[e.code] = false;
    });

    document.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.gameState.isShooting = true;
    });

    document.addEventListener('mouseup', () => {
      this.gameState.isShooting = false;
    });

    document.body.addEventListener('click', () => {
      this.controls.lock();
    });
  }

  private handleKeyDown(code: string): void {
    switch (code) {
      case 'KeyR':
        if (this.weaponManager.canReload()) {
          this.weaponManager.playGunAction(7);
        }
        break;
      case 'KeyF':
        this.gameState.flashlightOn = !this.gameState.flashlightOn;
        this.lightingManager.toggleFlashlight();
        break;
    }
  }

  public isWalking(): boolean {
    return this.gameState.keysPressed['KeyW'] ||
      this.gameState.keysPressed['KeyA'] ||
      this.gameState.keysPressed['KeyS'] ||
      this.gameState.keysPressed['KeyD'];
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

    this.manager.onStart = () => {
      this.show();
      this.setProgress(0);
    };
    this.manager.onProgress = (url, itemsLoaded, itemsTotal) => {
      this.setProgress((itemsLoaded / itemsTotal) * 100);
    };
    this.manager.onLoad = () => {
      this.setProgress(100);
      setTimeout(() => {
        this.hide();
        onLoad();
      }, 400);
    };
    this.manager.onError = () => {
      this.hide();
      onLoad();
    };
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
  private clock: THREE.Clock;
  private loadingManager: GameLoadingManager;

  constructor(loadingManager: GameLoadingManager) {
    this.loadingManager = loadingManager;
    this.initialize();
  }

  private initialize(): void {
    this.sceneManager = new SceneManager();
    this.gameState = new GameState();
    this.lightingManager = new LightingManager(this.sceneManager.scene, this.sceneManager.camera);
    this.modelManager = new ModelManager(this.sceneManager.scene, this.sceneManager.camera, this.loadingManager.manager);
    this.weatherManager = new WeatherManager(this.sceneManager.scene);
    this.weaponManager = new WeaponManager(
      this.sceneManager.scene,
      this.sceneManager.camera,
      this.gameState,
      this.modelManager,
      this.lightingManager
    );
    this.enemyManager = new EnemyManager(this.gameState, this.modelManager, this.sceneManager.camera);
    this.uiManager = new UIManager(this.gameState);
    this.setupPostProcessing();
    this.clock = new THREE.Clock();
    this.setupWindowEvents();
  }

  public startAfterLoading() {
    this.setupControls();
    this.inputManager = new InputManager(
      this.gameState,
      this.weaponManager,
      this.lightingManager,
      this.controls
    );
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
      this.sceneManager.camera.aspect = window.innerWidth / window.innerHeight;
      this.sceneManager.camera.updateProjectionMatrix();
      this.sceneManager.renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  private updateMovement(delta: number): void {
    const direction = new THREE.Vector3();
    const velocity = new THREE.Vector3();

    if (this.gameState.keysPressed['KeyW']) direction.z += 1;
    if (this.gameState.keysPressed['KeyS']) direction.z -= 1;
    if (this.gameState.keysPressed['KeyA']) direction.x -= 1;
    if (this.gameState.keysPressed['KeyD']) direction.x += 1;

    direction.normalize();
    velocity.copy(direction).multiplyScalar(CONFIG.MOVEMENT.SPEED * delta);
    this.controls.moveRight(velocity.x);
    this.controls.moveForward(velocity.z);

    const pos = this.sceneManager.camera.position;
    pos.x = clamp(pos.x, GAME_BOUNDS.minX, GAME_BOUNDS.maxX);
    pos.z = clamp(pos.z, GAME_BOUNDS.minZ, GAME_BOUNDS.maxZ);
  }

  private updateWeapon(delta: number): void {
    if (this.gameState.isShooting && this.weaponManager.canShoot()) {
      this.weaponManager.shoot();
      this.gameState.shootTimer = CONFIG.WEAPON.SHOOT_COOLDOWN;
      this.uiManager.updateUI();
    }

    this.weaponManager.updateBullets(delta);
    this.gameState.shootTimer -= delta;
    this.gameState.reloadTimer -= delta;

    if (this.modelManager.gunActions.length > 0 &&
      this.gameState.shootTimer <= 0 &&
      !this.gameState.isReloading) {
      this.weaponManager.playGunAction(this.inputManager.isWalking() ? 2 : 0);
    }
  }

  private updateAnimations(delta: number): void {
    this.modelManager.gunMixer?.update(delta);
    if (this.modelManager.zombieMixers) {
      for (const mixer of this.modelManager.zombieMixers) {
        mixer.update(delta);
      }
    }
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
    this.uiManager.updateUI();

    this.composer.render();
  }
}

// -- Audio and main code unchanged from your original (not shown for brevity) --

let rainAudio: HTMLAudioElement;
function setupRainAudio() {
  rainAudio = document.createElement('audio');
  rainAudio.src = '/rain.mpeg';
  rainAudio.loop = true;
  rainAudio.volume = 0.5;
  rainAudio.style.display = 'none';
  document.body.appendChild(rainAudio);
}

let shotAudio: HTMLAudioElement;
function setupShotAudio() {
  shotAudio = document.createElement('audio');
  shotAudio.src = '/shot.mp3';
  shotAudio.volume = 0.5;
  shotAudio.preload = 'auto';
  document.body.appendChild(shotAudio);
}
function playShotSound() {
  const audio = document.createElement('audio');
  audio.src = '/shot.mp3';
  audio.volume = 0.7;
  audio.autoplay = true;
  audio.style.display = 'none';
  document.body.appendChild(audio);
  audio.addEventListener('ended', () => {
    audio.remove();
  });
}
function playReloadSound() {
  const audio = document.createElement('audio');
  audio.src = '/reload.mp3';
  audio.volume = 0.7;
  audio.autoplay = true;
  audio.style.display = 'none';
  document.body.appendChild(audio);
  audio.addEventListener('ended', () => {
    audio.remove();
  });
}

// Positional zombie sound
let zombieAudioContext: AudioContext | null = null;
let zombieAudioBuffer: AudioBuffer | null = null;
let zombieSource: AudioBufferSourceNode | null = null;
let zombiePanner: PannerNode | null = null;

async function loadZombieAudioBuffer() {
  if (!zombieAudioContext) zombieAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  const response = await fetch('/zombie.mp3');
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

function main() {
  setupRainAudio();
  setupShotAudio();
  const startButton = document.getElementById("start-button") as HTMLElement;
  const startScreen = document.getElementById("start-screen") as HTMLElement;
  const loadingScreen = document.getElementById("loading-screen") as HTMLElement;
  const container = document.getElementById("container") as HTMLElement;

  startScreen.style.display = "flex";
  loadingScreen.style.display = "none";
  container.style.display = "none";
  let game: Game | null = null;

  startButton.addEventListener("click", () => {
    startScreen.style.display = "none";
    loadingScreen.style.display = "flex";
    container.style.display = "block";

    const loadingManager = new GameLoadingManager(() => {
      loadingScreen.style.display = "none";
      showClickToPlay(async () => {
        if (!game) {
          game = new Game(loadingManager);
          (window as any).game = game;
        }
        if (rainAudio) rainAudio.play();
        await loadZombieAudioBuffer();
        game.startAfterLoading();
      });
    });
    game = new Game(loadingManager);
    (window as any).game = game;
  });

  function showClickToPlay(onClick: () => void) {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.background = 'rgba(0,0,0,0.7)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '200';
    overlay.style.color = '#fff';
    overlay.style.fontSize = '2.5rem';
    overlay.style.cursor = 'pointer';
    overlay.innerText = 'Click to Play';

    overlay.addEventListener('click', () => {
      overlay.remove();
      onClick();
    });

    document.body.appendChild(overlay);
  }
}
main();