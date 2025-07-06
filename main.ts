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
  CAMERA: {
    FOV: 55,
    NEAR: 0.1,
    FAR: 1000,
    INITIAL_POSITION: { x: 0, y: 2, z: 10 }
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
    SPEED: 5, // increased for more visible movement
    DAMAGE_RATE: 10,
    MIN_DISTANCE: 0.5,
    COUNT: 50
  },
  RAIN: {
    COUNT: 500,
    FALL_SPEED_MIN: 0.3,
    FALL_SPEED_MAX: 0.8,
    SPAWN_RANGE: 25,
    HEIGHT_MIN: 60,
    HEIGHT_MAX: 100
  },
  BULLET: {
    SPEED: 10,
    MAX_DISTANCE: 1000
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
  public flashlightOn: boolean = true; // enabled by default
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
      precision: 'lowp'
    });
    this.setupRenderer();
  }

  private setupRenderer(): void {
    this.renderer.shadowMap.enabled = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.RENDERER.PIXEL_RATIO_MAX));
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
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
    // Enable flashlight by default
    this.flashlight.visible = true;
  }

  private setupLights(): void {
    // const ambientLight = new THREE.AmbientLight(0x222244, 0.8);
    // this.scene.add(ambientLight);
    const moonLight = new THREE.DirectionalLight(0x8888ff, 0.5);
    moonLight.position.set(20, 100, 50);
    moonLight.castShadow = true;
    this.scene.add(moonLight);

    this.flashlight = new THREE.SpotLight(0xffffff, 100, 50, Math.PI / 6, 0.3, 1.5);
    this.flashlight.shadow.normalBias = 1;
    this.flashlight.castShadow = true;
    this.flashlight.position.set(0, 0, 0);
    this.flashlight.visible = false; // will be set to true in constructor
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

type ZombieState = {
  health: number;
  dead: boolean;
  dying: boolean;
  deathTimer: number;
};

class ModelManager {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private loader: GLTFLoader;

  public zombieMixers: THREE.AnimationMixer[] = [];
  public zombies: THREE.Object3D[] = [];
  public fpsGun?: THREE.Object3D;
  public gunMixer?: THREE.AnimationMixer;
  public gunActions: THREE.AnimationAction[] = [];
  public zombieStates: ZombieState[] = [];
  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, loadingManager: THREE.LoadingManager) {
    this.scene = scene;
    this.camera = camera;
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
        if (o.animations && o.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(o);
          mixer.clipAction(o.animations[1]).play();
        }
        if ((o as THREE.PointLight).isLight) {
          (o as THREE.PointLight).shadow.bias = -0.0009;
        }
      });

      // --- Turn off all lights in map.glb initially ---
      gltf.scene.traverse((obj: any) => {
        if (obj.isLight) {
          obj.visible = false;
          if (obj.intensity !== undefined) obj.intensity = 0;
        }
      });
      // -------------------------------------------------

      gltf.scene.position.y = -0.2;
      this.scene.add(gltf.scene);
    });
  }

  private loadZombie(): void {
    this.loader.load('/zombie_hazmat.glb', (gltf) => {
      for (let i = 0; i < CONFIG.ZOMBIE.COUNT; i++) {
        const model = SkeletonUtils.clone(gltf.scene);
        model.scale.set(1.5, 1.5, 1.5);

        let x: number | undefined, z: number | undefined;
        let attempts = 0;
        const minSpawnDistance = 180;
        let distToPlayer = 0;
        let tooCloseToOther = false;
        do {
          x = THREE.MathUtils.randFloat(GAME_BOUNDS.minX, GAME_BOUNDS.maxX);
          z = THREE.MathUtils.randFloat(GAME_BOUNDS.minZ, GAME_BOUNDS.maxZ);
          distToPlayer = Math.sqrt(
            Math.pow(x - CONFIG.CAMERA.INITIAL_POSITION.x, 2) +
            Math.pow(z - CONFIG.CAMERA.INITIAL_POSITION.z, 2)
          );
          tooCloseToOther = this.zombies.some(zb => zb.position.distanceTo(new THREE.Vector3(x, 0.05, z)) < 2);
        } while (
          (distToPlayer < minSpawnDistance || tooCloseToOther) && ++attempts < 20
        );

        model.position.set(x, 0.05, z);

        model.traverse((child: any) => {
          child.castShadow = child.receiveShadow = true;
        });

        const mixer = new THREE.AnimationMixer(model);
        const walkAnim = gltf.animations.find(a => a.name.toLowerCase().includes('walk')) || gltf.animations[0];
        const action = mixer.clipAction(walkAnim);
        action.play();
        action.timeScale = 2;
        action.time = Math.random() * action.getClip().duration;

        this.zombieMixers.push(mixer);
        this.zombies.push(model);
        // Each zombie starts with 3 health (3 shots to kill)
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
  // Cover the whole map, not just a block
  private rainAreaMin = { x: GAME_BOUNDS.minX, z: GAME_BOUNDS.minZ };
  private rainAreaMax = { x: GAME_BOUNDS.maxX, z: GAME_BOUNDS.maxZ };

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

    // Initialize rain over the whole map
    this.initializeRainDrops();
    this.scene.add(this.rainGroup);
    this.scene.add(this.splashGroup);
  }

  // Spawn rain randomly over the whole map area
  private initializeRainDrops(): void {
    for (let i = 0; i < CONFIG.RAIN.COUNT; i++) {
      this.rainPositions[i * 3 + 0] = THREE.MathUtils.randFloat(this.rainAreaMin.x, this.rainAreaMax.x);
      this.rainPositions[i * 3 + 1] = THREE.MathUtils.randFloat(CONFIG.RAIN.HEIGHT_MIN, CONFIG.RAIN.HEIGHT_MAX);
      this.rainPositions[i * 3 + 2] = THREE.MathUtils.randFloat(this.rainAreaMin.z, this.rainAreaMax.z);
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

  // Remove camera-following logic, just update rain and respawn in the whole map area
  public updateRain(_cameraPosition: THREE.Vector3): void {
    const tempMatrix = new THREE.Matrix4();
    const tempSplashMatrix = new THREE.Matrix4();

    for (let i = 0; i < CONFIG.RAIN.COUNT; i++) {
      this.rainPositions[i * 3 + 1] -= this.rainVelocities[i];

      if (this.rainPositions[i * 3 + 1] < 0) {
        this.splashTimers[i] = 0.3;
        // Respawn anywhere in the map area
        this.rainPositions[i * 3 + 0] = THREE.MathUtils.randFloat(this.rainAreaMin.x, this.rainAreaMax.x);
        this.rainPositions[i * 3 + 1] = THREE.MathUtils.randFloat(CONFIG.RAIN.HEIGHT_MIN, CONFIG.RAIN.HEIGHT_MAX);
        this.rainPositions[i * 3 + 2] = THREE.MathUtils.randFloat(this.rainAreaMin.z, this.rainAreaMax.z);
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
    // Use world position!
    bullet.position.copy(this.camera.getWorldPosition(new THREE.Vector3()));
    // Use world direction!
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    bullet.userData.velocity = dir.clone().multiplyScalar(CONFIG.BULLET.SPEED);
    this.bullets.push(bullet);
    this.scene.add(bullet);

    this.lightingManager.showMuzzleFlash();
    playShotSound();
  }

  // ----- THIS FUNCTION IS FULLY REWRITTEN TO GUARANTEE 3 SHOTS = 1 DEAD ZOMBIE -----
  public updateBullets(delta: number): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      bullet.position.add(bullet.userData.velocity.clone().multiplyScalar(delta * CONFIG.BULLET.SPEED));

      // Remove bullet if out of range
      if (bullet.position.length() > CONFIG.BULLET.MAX_DISTANCE) {
        this.scene.remove(bullet);
        this.bullets.splice(i, 1);
        continue;
      }

      // Check bullet-zombie collisions
      let bulletHit = false;
      for (let j = 0; j < this.modelManager.zombies.length; j++) {
        const zombie = this.modelManager.zombies[j];
        const state = this.modelManager.zombieStates[j];
        if (state.dead || state.dying) continue;

        const box = new THREE.Box3().setFromObject(zombie);
        if (box.containsPoint(bullet.position)) {
          // Each zombie starts with 3 health, lose 1 per bullet
          state.health -= 1;
          // Clamp to minimum 0
          if (state.health < 0) state.health = 0;

          // Debug: Uncomment to see hits in console
          // console.log(`Zombie ${j} hit! Health now: ${state.health}`);

          if (state.health === 0 && !state.dead && !state.dying) {
            state.dying = true;
            state.deathTimer = 2; // die animation/fall
            this.modelManager.zombieMixers[j].stopAllAction();
          }

          // Remove bullet after hit, only one zombie per bullet
          this.scene.remove(bullet);
          this.bullets.splice(i, 1);
          bulletHit = true;
          break;
        }
      }
      if (bulletHit) continue;
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
    const avoidRadius = 1.0;

    let firstAliveZombieIdx = -1;
    for (let i = 0; i < this.modelManager.zombies.length; i++) {
      const state = this.modelManager.zombieStates[i];
      if (!state.dead && !state.dying) {
        firstAliveZombieIdx = i;
        break;
      }
    }

    // Play or stop zombie sound based on first alive zombie
    if (firstAliveZombieIdx !== -1) {
      const zombie = this.modelManager.zombies[firstAliveZombieIdx];
      if (!this.zombieSoundStarted && typeof zombieAudioBuffer !== "undefined" && zombieAudioBuffer) {
        playZombieSoundAt(zombie.position, this.camera);
        this.zombieSoundStarted = true;
      }
      if (this.zombieSoundStarted) {
        updateZombieSoundPosition(zombie, this.camera);
      }
    } else if (this.zombieSoundStarted) {
      // Stop sound if no alive zombies
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

    for (let i = 0; i < this.modelManager.zombies.length; i++) {
      const zombie = this.modelManager.zombies[i];
      const state = this.modelManager.zombieStates[i];

      // Animate a smooth fall when dying
      if (state.dying) {
        if (!state['deathAnimStarted']) {
          // Setup for smooth fall
          const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(zombie.quaternion);
          const up = new THREE.Vector3(0, 1, 0);
          const right = new THREE.Vector3().crossVectors(up, forward).normalize();
          state['fallAxis'] = right;
          state['fallRot'] = 0;
          // Always positive, always 100 degrees (no random)
          state['fallTarget'] = THREE.MathUtils.degToRad(THREE.MathUtils.randInt(70, 90));
          state['fallDirection'] = 1; // FORWARD
          state['deathAnimStarted'] = true;
        }

        // Animate the fall (smooth and always 100 deg)
        const axis = state['fallAxis'];
        const fallSpeed = THREE.MathUtils.degToRad(120) * delta; // 120 deg/sec for visible but smooth
        let rotateAmount = fallSpeed * state['fallDirection'];
        if (Math.abs(state['fallRot'] + rotateAmount) > state['fallTarget']) {
          rotateAmount = state['fallTarget'] * state['fallDirection'] - state['fallRot'];
        }
        zombie.rotateOnWorldAxis(axis, rotateAmount);
        state['fallRot'] += Math.abs(rotateAmount);

        if (state['fallRot'] >= state['fallTarget'] - 0.001) {
          state.dying = false;
          state.dead = true;
        }
        continue;
      }

      if (state.dead) continue;

      // Zombie audio logic
      if (i === 0 && !this.zombieSoundStarted && typeof zombieAudioBuffer !== "undefined" && zombieAudioBuffer) {
        playZombieSoundAt(zombie.position, this.camera);
        this.zombieSoundStarted = true;
      }
      if (i === 0 && this.zombieSoundStarted) {
        updateZombieSoundPosition(zombie, this.camera);
      }

      // Movement and AI
      const toPlayer = new THREE.Vector3().subVectors(this.camera.position, zombie.position);
      toPlayer.y = 0;
      const distance = toPlayer.length();

      // Avoid other zombies
      let avoid = new THREE.Vector3();
      for (let j = 0; j < this.modelManager.zombies.length; j++) {
        if (i === j) continue;
        const other = this.modelManager.zombies[j];
        const otherState = this.modelManager.zombieStates[j];
        if (otherState.dead || otherState.dying) continue;
        const d = zombie.position.distanceTo(other.position);
        if (d < avoidRadius && d > 0) {
          avoid.add(new THREE.Vector3().subVectors(zombie.position, other.position).normalize().multiplyScalar((avoidRadius - d) / avoidRadius));
        }
      }

      let move = toPlayer.normalize().multiplyScalar(CONFIG.ZOMBIE.SPEED * delta);
      if (avoid.lengthSq() > 0) {
        move.add(avoid.normalize().multiplyScalar(CONFIG.ZOMBIE.SPEED * delta * 0.7));
      }

      if (distance > CONFIG.ZOMBIE.MIN_DISTANCE) {
        zombie.position.add(move);
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
  private zombieProgressBar: HTMLElement;
  private zombieProgressFill: HTMLElement;
  private totalZombies: number;

  constructor(gameState: GameState) {
    this.gameState = gameState;
    this.totalZombies = CONFIG.ZOMBIE.COUNT;
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
      <div id="zombieProgressBar" style="position:fixed;top:20px;left:50%;transform:translateX(-50%);width:320px;height:22px;background:#222;border:2px solid #fff;border-radius:12px;z-index:30;box-shadow:0 2px 12px #000a;overflow:hidden;display:flex;align-items:center;">
        <div id="zombieProgressFill" style="background:#3cff3c;height:100%;width:0%;transition:width 0.2s;"></div>
        <span id="zombieProgressText" style="position:absolute;width:100%;text-align:center;color:#fff;font-weight:bold;letter-spacing:0.04em;font-size:15px;pointer-events:none;">0 / ${this.totalZombies} Zombies Killed</span>
      </div>
    `;
    document.body.appendChild(ui);

    this.ammoDisplay = document.getElementById('ammoDisplay')!;
    this.healthFill = document.getElementById('healthFill')! as HTMLDivElement;
    this.zombieProgressBar = document.getElementById('zombieProgressBar')!;
    this.zombieProgressFill = document.getElementById('zombieProgressFill')!;

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

  public updateUI(modelManager?: ModelManager): void {
    this.ammoDisplay.textContent = `Ammo: ${this.gameState.ammo} / ${this.gameState.maxAmmo}`;
    this.healthFill.style.width = `${this.gameState.health}%`;

    // Update zombie progress bar if modelManager is provided
    if (modelManager) {
      const killed = modelManager.zombieStates.filter(z => z.dead).length;
      const percent = Math.round((killed / this.totalZombies) * 100);
      this.zombieProgressFill.style.width = `${percent}%`;
      const text = document.getElementById('zombieProgressText');
      if (text) text.textContent = `${killed} / ${this.totalZombies} Zombies Killed`;

      // Hide progress bar if all zombies are dead
      if (killed >= this.totalZombies) {
        this.zombieProgressBar.style.display = 'none';
      } else {
        this.zombieProgressBar.style.display = 'flex';
      }
    }
  }

  public showZombieBar() {
    if (this.zombieProgressBar) {
      this.zombieProgressBar.style.display = 'flex';
    }
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
    this.manager.onProgress = (_url, itemsLoaded, itemsTotal) => {
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

  private checkpoint: THREE.Object3D | null = null;
  private checkpointBox: THREE.Box3 | null = null;
  private checkpointMixer: THREE.AnimationMixer | null = null;
  private checkpointTriggered = false;

  private checkpoint2Active = false;
  private checkpoint2Triggered = false;

  private checkpoint3Active = false;
  private checkpoint3Triggered = false;

  // Store original zombie count for respawn
  private originalZombieCount = CONFIG.ZOMBIE.COUNT;

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

    // Load first checkpoint at (0, 0.7, 0)
    const loader = new GLTFLoader(this.loadingManager.manager);
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load('/checkpoint.glb', (gltf) => {
      this.checkpoint = gltf.scene;
      this.checkpoint.position.set(0, 0.7, 0);
      this.checkpoint.scale.set(10, 10, 10);
      this.checkpoint.traverse((child: any) => {
        child.castShadow = true;
        child.receiveShadow = true;
      });
      this.sceneManager.scene.add(this.checkpoint);

      // Animation
      if (gltf.animations && gltf.animations.length > 0) {
        this.checkpointMixer = new THREE.AnimationMixer(this.checkpoint);
        gltf.animations.forEach((clip) => {
          this.checkpointMixer!.clipAction(clip).play();
        });
      }

      // Compute bounding box for collision
      this.checkpointBox = new THREE.Box3().setFromObject(this.checkpoint);
    });
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

  // Call this in animate() to update lights in real time
  private updateNearbyStreetLights() {
    if (!this.sceneManager.scene) return;

    // Find all PointLights in the scene that are currently off (except muzzleFlash)
    const playerPos = this.sceneManager.camera.position;
    const pointLights: any[] = [];
    this.sceneManager.scene.traverse((obj: any) => {
      if (
        obj.isPointLight &&
        obj !== this.lightingManager.muzzleFlash // never control muzzle flash
      ) {
        // Store distance for sorting
        obj._distanceToPlayer = obj.position.distanceTo(playerPos);
        pointLights.push(obj);
      }
    });

    // Sort by distance and enable the 4 closest street lights, disable the rest
    pointLights.sort((a, b) => a._distanceToPlayer - b._distanceToPlayer);
    for (let i = 0; i < pointLights.length; i++) {
      if (i < 4) {
        pointLights[i].visible = true;
        if (pointLights[i].intensity !== undefined) pointLights[i].intensity = 100;
      } else {
        pointLights[i].visible = false;
        if (pointLights[i].intensity !== undefined) pointLights[i].intensity = 0;
      }
    }
  }

  private animate(): void {
    requestAnimationFrame(() => this.animate());
    const delta = this.clock.getDelta();

    // Update checkpoint animation
    if (this.checkpointMixer) this.checkpointMixer.update(delta);

    this.updateMovement(delta);
    this.updateWeapon(delta);
    this.updateAnimations(delta);

    // Pass camera position to rain update for block-based rain movement
    this.weatherManager.updateRain(this.sceneManager.camera.position);

    this.enemyManager.updateZombie(delta);
    this.lightingManager.updateFlashlight();
    this.uiManager.updateUI(this.modelManager);

    // Mission failed check
    if (this.gameState.health <= 0) {
      showMissionFailedOverlay();
      return; // Stop further updates if mission failed
    }

    this.checkCheckpoint();
    this.checkSecondCheckpoint();
    this.checkThirdCheckpoint();

    // Real-time update of street lights after second checkpoint
    if (this.checkpoint2Triggered) {
      this.updateNearbyStreetLights();
    }

    this.composer.render();
  }

  private checkCheckpoint(): void {
    if (this.checkpointTriggered || !this.checkpoint || !this.checkpointBox) return;

    // Update bounding box in case checkpoint animates
    this.checkpointBox.setFromObject(this.checkpoint);

    // Use camera position as player position, but ignore y axis for collision
    const playerPos = this.sceneManager.camera.position;
    const min = this.checkpointBox.min;
    const max = this.checkpointBox.max;

    // Only check x and z
    if (
      playerPos.x >= min.x && playerPos.x <= max.x &&
      playerPos.z >= min.z && playerPos.z <= max.z
    ) {
      this.checkpointTriggered = true;
      playSpeechAudio1();
      // Instead of removing, just hide and prep for checkpoint 2
      if (this.checkpoint) {
        this.checkpoint.visible = false;
      }
      // Do not remove from scene, keep reference for reuse
      this.checkpointBox = null;
      this.checkpointMixer = null;
    }
  }

  private checkSecondCheckpoint(): void {
    // Only spawn after all zombies are dead and not already spawned
    if (!this.checkpoint2Active && this.modelManager && this.modelManager.zombieStates) {
      const killed = this.modelManager.zombieStates.filter(z => z.dead).length;
      if (killed >= this.modelManager.zombieStates.length) {
        // Hide start and loading screens immediately
        const startScreen = document.getElementById("start-screen");
        const loadingScreen = document.getElementById("loading-screen");
        if (startScreen) startScreen.style.display = "none";
        if (loadingScreen) loadingScreen.style.display = "none";

        // Move and show the checkpoint as checkpoint 2
        if (this.checkpoint) {
          this.checkpoint.position.set(0, 0.7, -400);
          this.checkpoint.scale.set(10, 10, 10);
          this.checkpoint.visible = true;
          // Recreate bounding box for new position
          this.checkpointBox = new THREE.Box3().setFromObject(this.checkpoint);
          this.checkpoint2Active = true;
          this.checkpoint2Triggered = false;
        }
      }
    }

    // If spawned, check collision
    if (
      this.checkpoint2Active &&
      this.checkpoint &&
      this.checkpointBox &&
      !this.checkpoint2Triggered
    ) {
      this.checkpointBox.setFromObject(this.checkpoint);
      const playerPos = this.sceneManager.camera.position;
      const min = this.checkpointBox.min;
      const max = this.checkpointBox.max;
      if (
        playerPos.x >= min.x && playerPos.x <= max.x &&
        playerPos.z >= min.z && playerPos.z <= max.z
      ) {
        this.checkpoint2Triggered = true;
        if (this.checkpoint) {
          this.checkpoint.visible = false;
        }
        // Play speech_audio_2.ogg and show subtitle, then respawn zombies, enable lights, and show zombie bar
        this.afterSecondCheckpoint();
      }
    }
  }

  // Add this method for the third checkpoint logic
  private checkThirdCheckpoint(): void {
    // Only spawn after all zombies in the third wave are dead and not already spawned
    if (
      !this.checkpoint3Active &&
      this.checkpoint2Triggered &&
      this.modelManager &&
      this.modelManager.zombieStates
    ) {
      const killed = this.modelManager.zombieStates.filter(z => z.dead).length;
      if (killed >= this.modelManager.zombieStates.length) {
        // Move and show the checkpoint as checkpoint 3 at spawn
        if (this.checkpoint) {
          this.checkpoint.position.set(
            CONFIG.CAMERA.INITIAL_POSITION.x,
            0.7,
            CONFIG.CAMERA.INITIAL_POSITION.z
          );
          this.checkpoint.scale.set(10, 10, 10);
          this.checkpoint.visible = true;
          // Recreate bounding box for new position
          this.checkpointBox = new THREE.Box3().setFromObject(this.checkpoint);
          this.checkpoint3Active = true;
          this.checkpoint3Triggered = false;
        }
      }
    }

    // If spawned, check collision
    if (
      this.checkpoint3Active &&
      this.checkpoint &&
      this.checkpointBox &&
      !this.checkpoint3Triggered
    ) {
      this.checkpointBox.setFromObject(this.checkpoint);
      const playerPos = this.sceneManager.camera.position;
      const min = this.checkpointBox.min;
      const max = this.checkpointBox.max;
      if (
        playerPos.x >= min.x && playerPos.x <= max.x &&
        playerPos.z >= min.z && playerPos.z <= max.z
      ) {
        this.checkpoint3Triggered = true;
        if (this.checkpoint) {
          this.checkpoint.visible = false;
        }
        showMissionCompleteOverlay();
      }
    }
  }

  // New method to handle post-second-checkpoint logic
  private afterSecondCheckpoint() {
    // 1. Turn off the player's flashlight
    this.gameState.flashlightOn = false;
    this.lightingManager.flashlight.visible = false;

    // 2. Turn on the 4 nearest street lights immediately
    this.updateNearbyStreetLights();

    // 3. Spawn zombies again immediately
    this.respawnZombies();

    // 4. Show zombie bar again
    this.uiManager.showZombieBar();

    // 5. Play speech_audio_2.ogg and show subtitle (after zombies and lights)
    playSpeechAudio2();
  }

  // Respawn zombies (same amount as original), reusing the already loaded zombie GLTF
  private respawnZombies() {
    // Remove old zombies from scene
    for (const zombie of this.modelManager.zombies) {
      this.sceneManager.scene.remove(zombie);
    }
    this.modelManager.zombies = [];
    this.modelManager.zombieMixers = [];
    this.modelManager.zombieStates = [];

    // Use the previously loaded zombie GLTF for respawn
    // We'll store the loaded zombie GLTF in ModelManager for reuse
    if ((this.modelManager as any)._zombieGLTF) {
      this.spawnZombiesFromGLTF((this.modelManager as any)._zombieGLTF, this.originalZombieCount);
    } else {
      // If not loaded yet, fallback to original spawnZombies
      (this.modelManager as any).spawnZombies(this.originalZombieCount);
    }
  }

  // Helper to spawn zombies from a cached GLTF
  private spawnZombiesFromGLTF(gltf: any, count: number) {
    for (let i = 0; i < count; i++) {
      const model = SkeletonUtils.clone(gltf.scene);
      model.scale.set(1.5, 1.5, 1.5);

      let x: number | undefined, z: number | undefined;
      let attempts = 0;
      const minSpawnDistance = 180;
      let distToPlayer = 0;
      let tooCloseToOther = false;
      do {
        x = THREE.MathUtils.randFloat(GAME_BOUNDS.minX, GAME_BOUNDS.maxX);
        z = THREE.MathUtils.randFloat(GAME_BOUNDS.minZ, GAME_BOUNDS.maxZ);
        distToPlayer = Math.sqrt(
          Math.pow(x - CONFIG.CAMERA.INITIAL_POSITION.x, 2) +
          Math.pow(z - CONFIG.CAMERA.INITIAL_POSITION.z, 2)
        );
        tooCloseToOther = this.modelManager.zombies.some(zb => zb.position.distanceTo(new THREE.Vector3(x, 0.05, z)) < 2);
      } while (
        (distToPlayer < minSpawnDistance || tooCloseToOther) && ++attempts < 20
      );

      model.position.set(x, 0.05, z);

      model.traverse((child: any) => {
        child.castShadow = child.receiveShadow = true;
      });

      const mixer = new THREE.AnimationMixer(model);
      const walkAnim = gltf.animations.find((a: any) => a.name.toLowerCase().includes('walk')) || gltf.animations[0];
      const action = mixer.clipAction(walkAnim);
      action.play();
      action.timeScale = 2;
      action.time = Math.random() * action.getClip().duration;

      this.modelManager.zombieMixers.push(mixer);
      this.modelManager.zombies.push(model);
      // Each zombie starts with 3 health (3 shots to kill)
      this.modelManager.zombieStates.push({ health: 3, dead: false, dying: false, deathTimer: 0 });
      this.sceneManager.scene.add(model);
    }
  }

}

// -- Audio and main code unchanged from your original (not shown for brevity) --

let rainAudio: HTMLAudioElement;
let bgAudio: HTMLAudioElement; // Add this line

function setupRainAudio() {
  rainAudio = document.createElement('audio');
  rainAudio.src = '/rain.ogg';
  rainAudio.loop = true;
  rainAudio.volume = 0.2;
  rainAudio.style.display = 'none';
  document.body.appendChild(rainAudio);
  rainAudio.addEventListener('ended', () => {
    rainAudio.currentTime = 0;
    rainAudio.play().catch(() => {});
  });
}

// Add this function
function setupBgAudio() {
  bgAudio = document.createElement('audio');
  bgAudio.src = '/bgsound.ogg';
  bgAudio.loop = true;
  bgAudio.volume = 0.8;
  bgAudio.style.display = 'none';
  document.body.appendChild(bgAudio);
  bgAudio.addEventListener('ended', () => {
    bgAudio.currentTime = 0;
    bgAudio.play().catch(() => {});
  });
}

function playShotSound() {
  const audio = document.createElement('audio');
  audio.src = '/shot.ogg';
  audio.volume = 0.2;
  audio.autoplay = true;
  audio.style.display = 'none';
  document.body.appendChild(audio);
  audio.addEventListener('ended', () => {
    audio.remove();
  });
}
function playReloadSound() {
  const audio = document.createElement('audio');
  audio.src = '/reload.ogg';
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

function main() {
  setupRainAudio();
  setupBgAudio();
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
        // Always play rain and bg music, even if previously stopped
        if (rainAudio) {
          rainAudio.loop = true;
          rainAudio.play().catch(() => {});
        }
        if (bgAudio) {
          bgAudio.loop = true;
          bgAudio.play().catch(() => {});
        }
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
  overlay.style.flexDirection = 'column';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '200';
  overlay.style.color = '#fff';
  overlay.style.cursor = 'pointer';

  const title = document.createElement('div');
  title.innerText = 'Click to Play';
  title.style.fontSize = '2rem';

  const instructions = document.createElement('div');
  instructions.style.fontSize = '1.2rem';
  instructions.style.marginTop = '1.5rem';
  instructions.style.textAlign = 'center';
  instructions.innerHTML = `
    Use <b>W A S D</b> to move<br/><br/>
    Press <b>R</b> to reload<br/><br/>
    Press <b>F</b> to toggle flashlight
  `;

  overlay.appendChild(title);
  overlay.appendChild(instructions);

  overlay.addEventListener('click', () => {
    overlay.remove();
    onClick();
  });

  document.body.appendChild(overlay);
}


}
main();

/**
 * Smoothly fades an HTMLAudioElement's volume to a target value.
 */
function fadeAudio(audio: HTMLAudioElement, targetVolume: number, duration: number = 1000) {
  if (!audio) return;
  // Ensure audio is always playing and looping
  if (audio.paused) {
    audio.loop = true;
    audio.play().catch(() => {}); // Ignore play errors (autoplay policy)
  }
  const startVolume = audio.volume;
  const startTime = performance.now();
  function step(now: number) {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    audio.volume = startVolume + (targetVolume - startVolume) * t;
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      audio.volume = targetVolume;
    }
  }
  requestAnimationFrame(step);
}

/**
 * Fades all background audio (rain, bg, zombie) in/out.
 * @param target 0 for mute, 1 for full volume
 * @param duration ms
 */
function fadeAllBackgroundAudio(target: number, duration: number = 1000) {
  // Always ensure rain and bg audio are playing and looping
  if (rainAudio && rainAudio.paused) {
    rainAudio.loop = true;
    rainAudio.play().catch(() => {});
  }
  if (bgAudio && bgAudio.paused) {
    bgAudio.loop = true;
    bgAudio.play().catch(() => {});
  }
  fadeAudio(rainAudio, 0.2 * target, duration);
  fadeAudio(bgAudio, 0.8 * target, duration);

  // Fade zombie positional audio if playing (WebAudio API)
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

function playSpeechAudio1() {
  // Lower background volumes but keep playing
  fadeAllBackgroundAudio(0.3, 800);

  showSubtitle(
    "Zeta to Echo Unit, we lost Sector 7 to the infected. Head straight through the breach, clear out hostiles, and reach the electric box. Once it's fixed, streetlights’ll light the whole damn sector. Move fast. We’re counting on you.",
    15000
  );
  const audio = document.createElement('audio');
  audio.src = '/speech_audio_1.ogg';
  audio.volume = 1.0;
  audio.autoplay = true;
  audio.style.display = 'none';
  document.body.appendChild(audio);
  audio.addEventListener('ended', () => {
    audio.remove();
    // Restore background volumes
    fadeAllBackgroundAudio(1, 1200);
  });
}

function showMissionFailedOverlay() {
  let overlay = document.getElementById("mission-failed-overlay");
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = "mission-failed-overlay";
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.background = 'rgba(0,0,0,0.85)';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '2000';
    overlay.style.color = '#ff3c3c';
    overlay.style.fontSize = '3rem';
    overlay.style.fontFamily = 'monospace';
    overlay.style.fontWeight = 'bold';

    overlay.innerHTML = `
      Mission Failed!
      <a href="https://github.com/RohanVashisht1234/threejs-zombieshooter-game" target="_blank" rel="noopener"
        style="
          margin-top: 32px;
          padding: 14px 32px;
          background: #24292f;
          color: #fff;
          border-radius: 8px;
          font-size: 1.2rem;
          font-family: monospace;
          font-weight: bold;
          text-decoration: none;
          box-shadow: 0 2px 12px #000a;
          transition: background 0.2s;
          display: inline-block;
        "
        onmouseover="this.style.background='#57606a'"
        onmouseout="this.style.background='#24292f'"
      >⭐ Star this Project on GitHub</a>
    `;
    document.body.appendChild(overlay);
  }
  // Unlock the pointer (show mouse)
  if (document.exitPointerLock) document.exitPointerLock();
}

function showMissionCompleteOverlay() {
  let overlay = document.getElementById("mission-complete-overlay");
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = "mission-complete-overlay";
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.background = 'rgba(0,0,0,0.85)';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '2000';
    overlay.style.color = '#3cff3c';
    overlay.style.fontSize = '3rem';
    overlay.style.fontFamily = 'monospace';
    overlay.style.fontWeight = 'bold';

    overlay.innerHTML = `
      Mission Complete!
      <a href="https://github.com/RohanVashisht1234/threejs-zombieshooter-game" target="_blank" rel="noopener"
        style="
          margin-top: 32px;
          padding: 14px 32px;
          background: #24292f;
          color: #fff;
          border-radius: 8px;
          font-size: 1.2rem;
          font-family: monospace;
          font-weight: bold;
          text-decoration: none;
          box-shadow: 0 2px 12px #000a;
          transition: background 0.2s;
          display: inline-block;
        "
        onmouseover="this.style.background='#57606a'"
        onmouseout="this.style.background='#24292f'"
      >⭐ Star this Project on GitHub</a>
    `;
    document.body.appendChild(overlay);
  }
  // Unlock the pointer (show mouse)
  if (document.exitPointerLock) document.exitPointerLock();
}

// Modify playSpeechAudio2 to accept a callback
function playSpeechAudio2(onEnd?: () => void) {
  // Lower background volumes but keep playing
  fadeAllBackgroundAudio(0.3, 800);

  showSubtitle(
    "Sector clear. Good work, Echo. Stand by for further orders.",
    8000
  );
  const audio = document.createElement('audio');
  audio.src = '/speech_audio_2.ogg';
  audio.volume = 1.0;
  audio.autoplay = true;
  audio.style.display = 'none';
  document.body.appendChild(audio);
  audio.addEventListener('ended', () => {
    audio.remove();
    const subtitle = document.getElementById('subtitle-box');
    if (subtitle) subtitle.style.display = 'none';
    // Restore background volumes
    fadeAllBackgroundAudio(1, 1200);
    if (onEnd) onEnd();
  });
}
function showSubtitle(text: string, duration: number) {
  let subtitleBox = document.getElementById('subtitle-box') as HTMLDivElement | null;
  if (!subtitleBox) {
    subtitleBox = document.createElement('div');
    subtitleBox.id = 'subtitle-box';
    subtitleBox.style.position = 'fixed';
    subtitleBox.style.bottom = '7%';
    subtitleBox.style.left = '50%';
    subtitleBox.style.transform = 'translateX(-50%)';
    subtitleBox.style.background = 'rgba(30, 40, 30, 0.72)';
    subtitleBox.style.color = 'rgb(60, 255, 60)';
    subtitleBox.style.padding = '18px 36px';
    subtitleBox.style.borderRadius = '12px';
    subtitleBox.style.fontSize = '1.25rem';
    subtitleBox.style.fontFamily = 'monospace, monospace, sans-serif';
    subtitleBox.style.fontWeight = 'bold';
    subtitleBox.style.letterSpacing = '0.02em';
    subtitleBox.style.boxShadow = 'rgba(0, 0, 0, 0.667) 0px 4px 24px';
    subtitleBox.style.zIndex = '1000';
    subtitleBox.style.textAlign = 'center';
    subtitleBox.style.pointerEvents = 'none';
    subtitleBox.style.maxWidth = '80vw';
    document.body.appendChild(subtitleBox);
  }
  subtitleBox.textContent = text;
  subtitleBox.style.display = 'block';

  // Remove/hide after duration
  setTimeout(() => {
    if (subtitleBox) subtitleBox.style.display = 'none';
  }, duration);
}
