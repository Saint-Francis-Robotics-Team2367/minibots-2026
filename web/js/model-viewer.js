/**
 * 3D model viewer for the documentation pages. Any element with a data-model
 * attribute becomes an orbitable view of that glTF file.
 *
 * three.js is vendored under /vendor/three rather than pulled from a CDN, for
 * the reason core.css gives for having no webfont: a competition venue is where
 * a CDN fetch fails. The page's import map resolves "three" to that copy.
 *
 * Nothing is fetched until a viewer is about to scroll into view — the library
 * and the two models together are ~2.6 MB, and most readers of a page never
 * reach its figures. Frames are drawn on demand rather than in a loop, so an
 * idle viewer costs nothing; the slow turntable spin is the only thing that
 * keeps it drawing, and it stops for good on the first drag.
 *
 * Wheel zoom needs Ctrl or ⌘. A bare wheel over the canvas scrolls the page,
 * because a figure that swallows the scroll gesture traps a reader halfway down
 * a guide.
 */

const viewers = document.querySelectorAll("[data-model]");

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function supportsWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function setStatus(el, text, kind) {
  const status = el.querySelector(".viewer__status");
  if (!status) return;
  status.textContent = text;
  status.hidden = !text;
  if (kind) status.dataset.kind = kind;
  else delete status.dataset.kind;
}

// CAD exports carry colour and a material name but no PBR values, so every
// part arrives as matte plastic. The few named finishes get the metal they are.
function finish(material) {
  const name = (material.name || "").toLowerCase();
  if (/alumin|steel|copper|metal/.test(name)) {
    material.metalness = 0.85;
    material.roughness = 0.38;
  } else if (/powder|rough/.test(name)) {
    material.metalness = 0;
    material.roughness = 0.9;
  } else {
    material.metalness = 0;
    material.roughness = 0.55;
  }
}

let threeReady;
function loadThree() {
  threeReady ??= Promise.all([
    import("three"),
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/controls/OrbitControls.js"),
    import("three/addons/environments/RoomEnvironment.js"),
    import("three/addons/libs/meshopt_decoder.module.js"),
  ]);
  return threeReady;
}

async function mount(el) {
  if (!supportsWebGL()) {
    setStatus(el, "This browser can't draw 3D graphics (WebGL is off or unavailable).", "error");
    return;
  }

  setStatus(el, "Loading 3D model…");

  let THREE, GLTFLoader, OrbitControls, RoomEnvironment, MeshoptDecoder;
  try {
    [
      THREE,
      { GLTFLoader },
      { OrbitControls },
      { RoomEnvironment },
      { MeshoptDecoder },
    ] = await loadThree();
  } catch {
    setStatus(el, "The 3D viewer didn't load. Reload the page to try again.", "error");
    return;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = "viewer__canvas";
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", el.dataset.label || "3D model");

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  // The room alone lights white CAD plastic to near-clipping; most parts on the
  // chassis are white, so the fill is pulled down and the key does the shaping.
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  // A key light from above-front for form, on top of the soft room fill.
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  let gltf;
  try {
    gltf = await loader.loadAsync(el.dataset.model, (e) => {
      if (e.lengthComputable) {
        setStatus(el, `Loading 3D model… ${Math.round((e.loaded / e.total) * 100)}%`);
      }
    });
  } catch {
    renderer.dispose();
    setStatus(el, "The model file didn't load. Reload the page to try again.", "error");
    return;
  }

  const model = gltf.scene;
  model.traverse((o) => {
    if (o.isMesh) finish(o.material);
  });

  // Optional per-model correction, as "x y z" in degrees, for exports whose up
  // axis isn't three's +Y.
  if (el.dataset.rotate) {
    const [x, y, z] = el.dataset.rotate.split(/\s+/).map((d) => (Number(d) * Math.PI) / 180);
    model.rotation.set(x || 0, y || 0, z || 0);
  }

  // Centre on the origin so the orbit pivots on the part, not on wherever the
  // CAD origin happened to sit.
  const box = new THREE.Box3().setFromObject(model);
  const centre = box.getCenter(new THREE.Vector3());
  model.position.sub(centre);
  scene.add(model);

  const size = box.getSize(new THREE.Vector3());
  const radius = size.length() / 2;
  const fit = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));

  // Three-quarter view from above: the angle a part is photographed at, and the
  // one that shows the most faces at once.
  const home = new THREE.Vector3(1, 0.72, 1.15).normalize().multiplyScalar(fit * 0.92);
  camera.near = fit / 100;
  camera.far = fit * 10;
  camera.position.copy(home);
  camera.updateProjectionMatrix();
  key.position.set(radius * 1.5, radius * 3, radius * 2);

  el.append(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = fit * 0.3;
  controls.maxDistance = fit * 2.5;
  controls.autoRotate = !reduceMotion;
  controls.autoRotateSpeed = 0.9;

  // Capture phase on the wrapper runs before OrbitControls' own listener on the
  // canvas, so stopping here leaves the wheel event to scroll the page.
  el.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    },
    { capture: true },
  );

  // At most one frame is ever queued. update() inside draw() fires "change"
  // whenever the camera moves, so a change listener that queued a frame of its
  // own on top of draw()'s re-queue scheduled two frames per frame: the queue
  // doubled every tick until the browser was rendering thousands of frames a
  // second and the whole machine lagged. Changes raised by draw() itself are
  // ignored here; only the user's own input (start of a drag, a wheel) queues.
  let visible = true;
  let frame = 0;
  let drawing = false;
  const request = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  const draw = () => {
    frame = 0;
    drawing = true;
    // update() returns true while damping or the turntable is still moving.
    const moving = controls.update();
    drawing = false;
    renderer.render(scene, camera);
    if ((moving || controls.autoRotate) && visible) request();
  };

  controls.addEventListener("change", () => {
    if (!drawing) request();
  });
  controls.addEventListener("start", () => {
    controls.autoRotate = false;
    el.dataset.touched = "true";
  });

  const resize = () => {
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    request();
  };
  new ResizeObserver(resize).observe(el);

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) request();
  }).observe(el);

  const reset = el.parentElement?.querySelector("[data-model-reset]");
  if (reset) {
    reset.hidden = false;
    reset.addEventListener("click", () => {
      camera.position.copy(home);
      controls.target.set(0, 0, 0);
      controls.update();
      request();
    });
  }

  // Ctrl/⌘ means nothing on a phone, where pinch already zooms.
  const hint = el.querySelector(".viewer__hint");
  if (hint && matchMedia("(pointer: coarse)").matches) hint.textContent = "Drag to turn · pinch to zoom";

  setStatus(el, "");
  el.dataset.ready = "true";
  resize();
}

if (viewers.length) {
  // 400px of lead so the model is usually ready by the time it is on screen.
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        mount(entry.target);
      }
    },
    { rootMargin: "400px 0px" },
  );
  viewers.forEach((v) => io.observe(v));
}
