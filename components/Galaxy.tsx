// Memory Galaxy — a Three.js starfield where every memory is a star.
// Three.js is loaded from CDN in index.html (window.THREE), so there's no
// npm dependency. Self-contained: own render loop, manual orbit/zoom,
// raycast hover + click, constellation lines, twinkle, filter dimming.
import { useEffect, useRef } from 'react';
import type { GalaxyStar } from '../lib/types';

declare global { interface Window { THREE: any } }

export const CONSTELLATION_COLOUR: Record<string, string> = {
  customer: '#38BDF8', property: '#22C55E', crew: '#F59E0B',
  policy: '#A78BFA', general: '#E8EDF5',
};

export function Galaxy({ memories, interactive = true, mini = false, filter = 'all',
  bloom = false, onMemoryClick, onHover, className = '' }:
  { memories: GalaxyStar[]; interactive?: boolean; mini?: boolean; filter?: string;
    bloom?: boolean;
    onMemoryClick?: (m: GalaxyStar) => void;
    onHover?: (m: GalaxyStar | null, x: number, y: number) => void; className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<any>({});
  // Latest filter, read live by the render loop so changing the filter dims
  // stars in place instead of tearing down + rebuilding (and re-randomising)
  // the whole scene — and leaking a WebGL context — on every chip click.
  const filterRef = useRef(filter);
  useEffect(() => { filterRef.current = filter; }, [filter]);

  // Build/refresh the scene when the memory set changes.
  useEffect(() => {
    const THREE = window.THREE;
    const mount = mountRef.current;
    if (!THREE || !mount) return;

    const W = mount.clientWidth || 400;
    const H = mount.clientHeight || 400;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 2000);
    let camDist = mini ? 150 : 230;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    mount.innerHTML = '';
    mount.appendChild(renderer.domElement);

    const galaxy = new THREE.Group();
    scene.add(galaxy);

    // Distant, non-interactive background starfield.
    const bgGeo = new THREE.BufferGeometry();
    const bgN = mini ? 300 : 1400;
    const bgPos = new Float32Array(bgN * 3);
    for (let i = 0; i < bgN; i++) {
      const r = 600 + Math.random() * 700;
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      bgPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      bgPos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      bgPos[i * 3 + 2] = r * Math.cos(ph);
    }
    bgGeo.setAttribute('position', new THREE.BufferAttribute(bgPos, 3));
    scene.add(new THREE.Points(bgGeo, new THREE.PointsMaterial({
      color: 0x6688aa, size: 1.1, transparent: true, opacity: 0.5, sizeAttenuation: true })));

    // Position each memory-star on a rough disc, grouped by constellation.
    const cons = Array.from(new Set(memories.map(m => m.constellation)));
    const positions: Record<number, any> = {};
    const starData: any[] = [];
    memories.forEach((m, i) => {
      const ci = cons.indexOf(m.constellation);
      const armAngle = (ci / Math.max(1, cons.length)) * Math.PI * 2;
      const spread = 26 + (i % 7) * 4;
      const radius = 30 + Math.random() * (mini ? 55 : 95);
      const jitter = () => (Math.random() - 0.5) * spread;
      const x = Math.cos(armAngle) * radius + jitter();
      const y = (Math.random() - 0.5) * (mini ? 26 : 46);
      const z = Math.sin(armAngle) * radius + jitter();
      const v = new THREE.Vector3(x, y, z);
      positions[m.id] = v;
      const col = new THREE.Color(CONSTELLATION_COLOUR[m.constellation] || '#E8EDF5');
      // 2× bigger base star; brighter floor so even low-confidence stars read.
      const size = 4 + Math.min(6, (m.usage_count || 0)) * 1.8;
      starData.push({ m, v, col, size, baseSize: size,
        brightness: 0.6 + m.confidence * 0.5 });
    });

    // Star sprites as a single Points cloud with per-vertex colour/size.
    const starGeo = new THREE.BufferGeometry();
    const sPos = new Float32Array(starData.length * 3);
    const sCol = new Float32Array(starData.length * 3);
    const sSize = new Float32Array(starData.length);
    starData.forEach((s, i) => {
      sPos.set([s.v.x, s.v.y, s.v.z], i * 3);
      sCol.set([s.col.r * s.brightness, s.col.g * s.brightness, s.col.b * s.brightness], i * 3);
      sSize[i] = s.size;
    });
    starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(sCol, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));

    // Round, glowing sprite via a shader that reads aSize + vertex colour.
    const starMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: H / 2 }, uBloom: { value: bloom ? 1.0 : 0.0 } },
      vertexShader: `
        attribute float aSize; varying vec3 vCol;
        uniform float uScale; uniform float uBloom;
        void main(){ vCol = color;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          // Bloom enlarges the sprite quad to give the glow halo room to spread.
          gl_PointSize = aSize * (uScale / -mv.z) * (1.0 + uBloom * 0.9);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        varying vec3 vCol; uniform float uBloom;
        void main(){ vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d); if(r>0.5) discard;
          if(uBloom > 0.5){
            // bright core + soft outer halo = point-light bloom
            float core = smoothstep(0.26, 0.0, r);
            float halo = smoothstep(0.5, 0.08, r);
            float a = max(core, halo * 0.5);
            gl_FragColor = vec4(vCol * (1.0 + core * 0.6), a);
          } else {
            gl_FragColor = vec4(vCol, smoothstep(0.5, 0.0, r));
          }
        }`,
      vertexColors: true,
    });
    const starPoints = new THREE.Points(starGeo, starMat);
    galaxy.add(starPoints);

    // Constellation lines from connected_to (dedup undirected pairs).
    const seen = new Set<string>();
    const linePos: number[] = [];
    const lineCol: number[] = [];
    starData.forEach(s => {
      (s.m.connected_to || []).forEach((tid: number) => {
        const key = s.m.id < tid ? `${s.m.id}-${tid}` : `${tid}-${s.m.id}`;
        if (seen.has(key) || !positions[tid]) return;
        seen.add(key);
        const a = s.v, b = positions[tid];
        linePos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        const c = s.col;
        lineCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
      });
    });
    if (linePos.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePos), 3));
      lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lineCol), 3));
      galaxy.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending })));
    }

    stateRef.current = { THREE, scene, camera, renderer, galaxy, starData, starGeo,
      starPoints, mount, cons, camDistRef: { v: camDist }, rot: { x: 0.2, y: 0 } };

    // ── Interaction ──────────────────────────────────────────────────────
    const st = stateRef.current;
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 5;
    const mouse = new THREE.Vector2();
    let dragging = false, lastX = 0, lastY = 0, hoverIdx = -1;

    const onDown = (e: MouseEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
    const onUp = () => { dragging = false; };
    const onMove = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (dragging && interactive) {
        st.rot.y += (e.clientX - lastX) * 0.005;
        st.rot.x += (e.clientY - lastY) * 0.005;
        st.rot.x = Math.max(-1.2, Math.min(1.2, st.rot.x));
        lastX = e.clientX; lastY = e.clientY;
      }
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      if (onHover) {
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObject(starPoints);
        const idx = hits.length ? hits[0].index : -1;
        if (idx !== hoverIdx) {
          hoverIdx = idx;
          onHover(idx >= 0 ? starData[idx].m : null, e.clientX, e.clientY);
          renderer.domElement.style.cursor = idx >= 0 ? 'pointer' : (interactive ? 'grab' : 'default');
        }
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!onMemoryClick) return;
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObject(starPoints);
      if (hits.length) onMemoryClick(starData[hits[0].index].m);
    };
    const onWheel = (e: WheelEvent) => {
      if (!interactive) return;
      e.preventDefault();
      st.camDistRef.v = Math.max(70, Math.min(500, st.camDistRef.v + e.deltaY * 0.15));
    };

    if (interactive) {
      renderer.domElement.addEventListener('mousedown', onDown);
      window.addEventListener('mouseup', onUp);
      renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    }
    renderer.domElement.addEventListener('mousemove', onMove);
    renderer.domElement.addEventListener('click', onClick);

    // ── Render loop ──────────────────────────────────────────────────────
    let raf = 0; let t = 0;
    const colAttr = starGeo.getAttribute('color');
    const sizeAttr = starGeo.getAttribute('aSize');
    const render = () => {
      t += 0.016;
      st.rot.y += 0.0009;                          // slow drift folds into the manual target
      const targetY = st.rot.y, targetX = st.rot.x;
      galaxy.rotation.y += (targetY - galaxy.rotation.y) * 0.08;   // manual horizontal orbit + drift
      galaxy.rotation.x += (targetX - galaxy.rotation.x) * 0.08;
      // twinkle + filter dimming
      starData.forEach((s, i) => {
        const active = filterRef.current === 'all' || s.m.constellation === filterRef.current;
        const tw = 0.85 + Math.sin(t * 1.7 + i) * 0.15;
        const dim = active ? 1 : 0.12;
        const b = s.brightness * tw * dim;
        colAttr.array[i * 3] = s.col.r * b;
        colAttr.array[i * 3 + 1] = s.col.g * b;
        colAttr.array[i * 3 + 2] = s.col.b * b;
        sizeAttr.array[i] = s.baseSize * (active ? (0.9 + Math.sin(t * 2 + i) * 0.12) : 0.6);
      });
      colAttr.needsUpdate = true; sizeAttr.needsUpdate = true;
      const d = st.camDistRef.v;
      camera.position.set(0, d * 0.28, d);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };
    render();

    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      starMat.uniforms.uScale.value = h / 2;
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mouseup', onUp);
      renderer.domElement.removeEventListener('mousedown', onDown);
      renderer.domElement.removeEventListener('mousemove', onMove);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.domElement.removeEventListener('wheel', onWheel as any);
      renderer.dispose();
      renderer.forceContextLoss();               // release the WebGL context (dispose alone leaks it)
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, [memories, mini, interactive, bloom]);

  return <div ref={mountRef} className={`w-full h-full ${className}`} />;
}
