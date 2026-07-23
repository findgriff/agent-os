// Memory Network — a living brain rendered in Three.js. Every memory is a
// biological neuron: a white-hot nucleus inside a coloured soma with radiating
// dendrites, connected by organic axon pathways wrapped in myelin-sheath glow
// rings. Neurons drift like living cells, fire in chain reactions that
// propagate to their neighbours, and the whole network breathes at ~0.4Hz.
// Three.js is loaded from CDN in index.html (window.THREE) — no npm
// dependency. Self-contained: own render loop, manual orbit/zoom, raycast
// hover + click, synaptic pulses, and a targeting reticle. No stars — pure
// neural architecture on a deep dark-blue void.
import { useEffect, useRef } from 'react';
import type { GalaxyStar } from '../lib/types';

declare global { interface Window { THREE: any } }

export const CONSTELLATION_COLOUR: Record<string, string> = {
  customer: '#38BDF8', property: '#22C55E', crew: '#F59E0B',
  policy: '#A78BFA', general: '#E8EDF5',
};

// ── Canvas-painted textures ───────────────────────────────────────────────
// Soft radial glow — background fog, halos, pulses
function softGlowTexture(THREE: any) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.65)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.16)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
// Myelin sheath ring — a glowing torus cross-section threaded along axons
function myelinTexture(THREE: any) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.32, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.48, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
// Firing burst — bright core with radiating spikes
function flareTexture(THREE: any) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.1, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.32, 'rgba(255,255,255,0.1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  g.globalCompositeOperation = 'lighter';
  const spike = (rot: number, len: number) => {
    g.save(); g.translate(128, 128); g.rotate(rot); g.scale(1, 0.05);
    const sg = g.createRadialGradient(0, 0, 0, 0, 0, len);
    sg.addColorStop(0, 'rgba(255,255,255,0.9)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sg; g.beginPath(); g.arc(0, 0, len, 0, Math.PI * 2); g.fill();
    g.restore();
  };
  spike(0, 124); spike(Math.PI / 2, 124);
  spike(Math.PI / 4, 90); spike(-Math.PI / 4, 90);
  spike(Math.PI / 8, 60); spike(3 * Math.PI / 8, 60);
  return new THREE.CanvasTexture(c);
}
// Targeting reticle for the selected neuron
function reticleTexture(THREE: any) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!; g.translate(128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.2)'; g.lineWidth = 12;
  g.beginPath(); g.arc(0, 0, 96, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 3;
  g.beginPath(); g.arc(0, 0, 96, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 4;
  for (let i = 0; i < 4; i++) { g.rotate(Math.PI / 2); g.beginPath(); g.moveTo(82, 0); g.lineTo(110, 0); g.stroke(); }
  return new THREE.CanvasTexture(c);
}

export function Galaxy({ memories, interactive = true, mini = false, filter = 'all',
  bloom = false, selectedId = null, onMemoryClick, onHover, className = '' }:
  { memories: GalaxyStar[]; interactive?: boolean; mini?: boolean; filter?: string;
    bloom?: boolean; selectedId?: number | null;
    onMemoryClick?: (m: GalaxyStar) => void;
    onHover?: (m: GalaxyStar | null, x: number, y: number) => void; className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<any>({});
  const filterRef = useRef(filter);
  useEffect(() => { filterRef.current = filter; }, [filter]);
  const selectedRef = useRef<number | null>(selectedId);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  useEffect(() => {
    const THREE = window.THREE;
    const mount = mountRef.current;
    if (!THREE || !mount) return;

    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const W = mount.clientWidth || 400;
    const H = mount.clientHeight || 400;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 2000);
    const camDist = mini ? 150 : 210;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    mount.innerHTML = '';
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.opacity = '0';
    renderer.domElement.style.transition = 'opacity 1.1s ease-out';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      renderer.domElement.style.opacity = '1';
    }));

    const geos: any[] = [], mats: any[] = [], texs: any[] = [];
    const track = { geo: (g: any) => (geos.push(g), g), mat: (m: any) => (mats.push(m), m),
      tex: (t2: any) => (texs.push(t2), t2) };

    const network = new THREE.Group();
    scene.add(network);

    const softTex = track.tex(softGlowTexture(THREE));
    const myelinTex = track.tex(myelinTexture(THREE));
    const flareTex = track.tex(flareTexture(THREE));

    // ── Background — deep dark-blue neural void, no stars ────────────────
    if (!mini) {
      const deep = track.mat(new THREE.SpriteMaterial({
        map: softTex, color: '#081228', transparent: true, opacity: 0.85,
        blending: THREE.NormalBlending, depthWrite: false }));
      const deepSp = new THREE.Sprite(deep);
      deepSp.scale.set(1600, 1600, 1); deepSp.position.set(0, 0, -700);
      scene.add(deepSp);
      const ambient = track.mat(new THREE.SpriteMaterial({
        map: softTex, color: '#12295c', transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false }));
      const ambSp = new THREE.Sprite(ambient);
      ambSp.scale.set(900, 900, 1); ambSp.position.set(0, 0, -500);
      scene.add(ambSp);
    }

    // ── Layout — constellation clusters arranged as brain lobes ──────────
    const cons = Array.from(new Set(memories.map(m => m.constellation)));
    const clusterRadius = mini ? 66 : 104;
    const nodeSpread = mini ? 44 : 64;
    const centres: Record<string, any> = {};
    cons.forEach((cn, ci) => {
      const a = (ci / Math.max(1, cons.length)) * Math.PI * 2 + 0.55;
      const r = clusterRadius * (0.88 + (ci % 2) * 0.26);
      centres[cn] = new THREE.Vector3(
        Math.cos(a) * r,
        Math.sin(ci * 2.4) * (mini ? 14 : 28),
        Math.sin(a) * r);
    });

    const positions: Record<number, any> = {};
    const neuronData: any[] = [];
    const byCons: Record<string, number[]> = {};
    memories.forEach((m, i) => {
      const centre = centres[m.constellation] || new THREE.Vector3(0, 0, 0);
      const rOff = Math.pow(Math.random(), 0.6) * nodeSpread;
      const aOff = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(
        centre.x + Math.cos(aOff) * rOff,
        centre.y + (Math.random() - 0.5) * (mini ? 26 : 44) * (1 - (rOff / nodeSpread) * 0.4),
        centre.z + Math.sin(aOff) * rOff);
      positions[m.id] = v;
      const col = new THREE.Color(CONSTELLATION_COLOUR[m.constellation] || '#E8EDF5');
      const size = 9 + Math.min(8, (m.usage_count || 0)) * 2.6;
      neuronData.push({ m, v, col, size, baseSize: size,
        brightness: 0.85 + m.confidence * 0.45, phase: i,
        firing: false, fireTimer: 0, fireDuration: 0.55 + Math.random() * 0.35 });
      (byCons[m.constellation] = byCons[m.constellation] || []).push(i);
    });
    const idxById = new Map<number, number>(neuronData.map((s, i) => [s.m.id, i]));

    // ── Edges — axons from connected_to + long-range inter-lobe fibres ───
    // Each edge is a quadratic bezier a → mid → b lifted into an organic arc.
    const edges: any[] = [];
    const adj = new Map<number, { e: number; rev: boolean }[]>();
    const pushAdj = (ni: number, e: number, rev: boolean) => {
      const l = adj.get(ni) || []; l.push({ e, rev }); adj.set(ni, l);
    };
    const seenSet = new Set<string>();
    const addEdge = (ai: number, bi: number, long: boolean) => {
      const A = neuronData[ai], B = neuronData[bi];
      const key = ai < bi ? `${ai}-${bi}` : `${bi}-${ai}`;
      if (ai === bi || seenSet.has(key)) return;
      seenSet.add(key);
      const a = A.v, b = B.v;
      const dist = a.distanceTo(b);
      const lift = long ? 18 + dist * 0.28 : 6 + dist * 0.12;
      const mid = new THREE.Vector3(
        (a.x + b.x) / 2 + (Math.random() - 0.5) * 14,
        (a.y + b.y) / 2 + (Math.random() - 0.5) * 10 + lift,
        (a.z + b.z) / 2 + (Math.random() - 0.5) * 14);
      const e = edges.length;
      edges.push({ a, b, mid, colA: A.col, colB: B.col, ai, bi, long, dist });
      pushAdj(ai, e, false); pushAdj(bi, e, true);
    };
    neuronData.forEach((s, si) => {
      (s.m.connected_to || []).forEach((tid: number) => {
        const ti = idxById.get(tid);
        if (ti != null) addEdge(si, ti, false);
      });
    });
    // Long-range commissural fibres between neighbouring lobes
    cons.forEach((cn, ci) => {
      const next = cons[(ci + 1) % cons.length];
      const A = byCons[cn] || [], B = byCons[next] || [];
      if (cn === next || !A.length || !B.length) return;
      for (let k = 0; k < 2; k++) {
        addEdge(A[(Math.random() * A.length) | 0], B[(Math.random() * B.length) | 0], true);
      }
    });

    const bezierPt = (a: any, mid: any, b: any, p: number) => {
      const t1 = 1 - p, t2 = p;
      return new THREE.Vector3(
        t1 * t1 * a.x + 2 * t1 * t2 * mid.x + t2 * t2 * b.x,
        t1 * t1 * a.y + 2 * t1 * t2 * mid.y + t2 * t2 * b.y,
        t1 * t1 * a.z + 2 * t1 * t2 * mid.z + t2 * t2 * b.z);
    };

    // ── Neuron somas — white-hot nucleus, coloured cell body, dendrite
    // tendrils and membrane ring, all procedural in the point shader.
    // Each neuron drifts organically in the vertex shader (living-cell bob).
    const nGeo = track.geo(new THREE.BufferGeometry());
    const nPos = new Float32Array(neuronData.length * 3);
    const nCol = new Float32Array(neuronData.length * 3);
    const nSize = new Float32Array(neuronData.length);
    const nSeed = new Float32Array(neuronData.length);
    neuronData.forEach((s, i) => {
      nPos.set([s.v.x, s.v.y, s.v.z], i * 3);
      nCol.set([s.col.r * s.brightness, s.col.g * s.brightness, s.col.b * s.brightness], i * 3);
      nSize[i] = s.size;
      nSeed[i] = Math.random() * 100;
    });
    const posAttr = new THREE.BufferAttribute(nPos, 3);
    const colAttr = new THREE.BufferAttribute(nCol, 3);
    const sizeAttr = new THREE.BufferAttribute(nSize, 1);
    const seedAttr = new THREE.BufferAttribute(nSeed, 1);
    nGeo.setAttribute('position', posAttr);
    nGeo.setAttribute('color', colAttr);
    nGeo.setAttribute('aSize', sizeAttr);
    nGeo.setAttribute('aSeed', seedAttr);

    const wobbleChunk = `
      vec3 wobble(vec3 p, float seed, float time){
        p.x += sin(time * 0.9 + seed * 17.0) * 1.5 + sin(time * 0.23 + seed * 3.1) * 1.1;
        p.y += cos(time * 0.7 + seed * 23.0) * 1.8 + sin(time * 0.31 + seed * 7.3) * 1.2;
        p.z += sin(time * 0.8 + seed * 29.0) * 1.5;
        return p;
      }`;
    const nMat = track.mat(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: H / 2 }, uBloom: { value: bloom ? 1.0 : 0.0 },
        uTime: { value: 0 }, uWave: { value: 1 } },
      vertexShader: `
        attribute float aSize; attribute float aSeed;
        varying vec3 vCol; varying float vSeed;
        uniform float uScale; uniform float uBloom; uniform float uTime; uniform float uWave;
        ${wobbleChunk}
        void main(){ vCol = color; vSeed = aSeed;
          vec3 p = wobble(position, aSeed, uTime);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = aSize * uWave * (uScale / -mv.z) * (1.0 + uBloom * 0.8);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        varying vec3 vCol; varying float vSeed;
        uniform float uBloom; uniform float uTime;
        void main(){ vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d); if(r > 0.5) discard;
          float ang = atan(d.y, d.x);
          // white-hot nucleus
          float nucleus = smoothstep(0.16, 0.0, r);
          // coloured soma body
          float soma = smoothstep(0.34, 0.08, r);
          // cell membrane ring
          float mem = smoothstep(0.035, 0.0, abs(r - 0.30));
          // dendrite tendrils radiating from the soma, slowly writhing
          float wr = sin(uTime * 0.6 + vSeed * 9.0) * 0.45;
          float branches = pow(abs(sin(ang * 3.0 + vSeed * 6.2831 + wr)), 18.0);
          float dend = branches * smoothstep(0.5, 0.22, r) * smoothstep(0.14, 0.28, r);
          // outer bio-glow halo
          float halo = smoothstep(0.5, 0.08, r) * 0.35;
          vec3 c = vCol * (soma * 1.5 + halo) + vec3(1.0) * nucleus * 1.7
            + vCol * mem * 0.9 + mix(vCol, vec3(1.0), 0.4) * dend;
          float a = max(max(nucleus, soma * 0.9), max(halo, max(mem * 0.6, dend * 0.85)));
          if(uBloom > 0.5){
            float ax = abs(d.x), ay = abs(d.y);
            float flare = max(
              (1.0 - smoothstep(0.0, 0.03, ay)) * (1.0 - smoothstep(0.02, 0.5, ax)),
              (1.0 - smoothstep(0.0, 0.03, ax)) * (1.0 - smoothstep(0.02, 0.5, ay)));
            a = max(a, flare * 0.45); c += vec3(1.0) * flare * 0.4;
          }
          gl_FragColor = vec4(c, a); }`,
      vertexColors: true,
    }));
    const neuronPoints = new THREE.Points(nGeo, nMat);
    network.add(neuronPoints);

    // Halo layer — shares position/colour/seed attributes so it wobbles in
    // lockstep with the somas; a big soft additive bloom behind every neuron.
    const hGeo = track.geo(new THREE.BufferGeometry());
    hGeo.setAttribute('position', posAttr);
    hGeo.setAttribute('color', colAttr);
    hGeo.setAttribute('aSize', sizeAttr);
    hGeo.setAttribute('aSeed', seedAttr);
    const hMat = track.mat(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: H / 2 }, uTime: { value: 0 }, uWave: { value: 1 } },
      vertexShader: `
        attribute float aSize; attribute float aSeed;
        varying vec3 vCol;
        uniform float uScale; uniform float uTime; uniform float uWave;
        ${wobbleChunk}
        void main(){ vCol = color;
          vec3 p = wobble(position, aSeed, uTime);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = aSize * 3.4 * uWave * (uScale / -mv.z);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        varying vec3 vCol;
        void main(){ vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d); if(r > 0.5) discard;
          float glow = smoothstep(0.5, 0.0, r);
          gl_FragColor = vec4(vCol * glow, glow * 0.22); }`,
      vertexColors: true,
    }));
    network.add(new THREE.Points(hGeo, hMat));

    // ── Dendrites — short branching filaments sprouting from every soma ───
    {
      const dPos: number[] = [], dCol: number[] = [];
      const branchesPer = mini ? 3 : 5;
      neuronData.forEach(s => {
        for (let bIdx = 0; bIdx < branchesPer; bIdx++) {
          let p = s.v.clone();
          const dir = new THREE.Vector3(
            Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
          const steps = 3;
          for (let st2 = 0; st2 < steps; st2++) {
            const q = p.clone().addScaledVector(dir, 2.6 + Math.random() * 2.6);
            q.x += (Math.random() - 0.5) * 2.4;
            q.y += (Math.random() - 0.5) * 2.4;
            q.z += (Math.random() - 0.5) * 2.4;
            const b0 = 0.5 * (1 - st2 / steps), b1 = 0.5 * (1 - (st2 + 1) / steps);
            dPos.push(p.x, p.y, p.z, q.x, q.y, q.z);
            dCol.push(s.col.r * b0, s.col.g * b0, s.col.b * b0,
              s.col.r * b1, s.col.g * b1, s.col.b * b1);
            p = q;
            dir.x += (Math.random() - 0.5) * 0.7;
            dir.y += (Math.random() - 0.5) * 0.7;
            dir.z += (Math.random() - 0.5) * 0.7;
            dir.normalize();
          }
        }
      });
      if (dPos.length) {
        const dGeo = track.geo(new THREE.BufferGeometry());
        dGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dPos), 3));
        dGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(dCol), 3));
        const dMat = track.mat(new THREE.LineBasicMaterial({
          vertexColors: true, transparent: true, opacity: 0.55,
          blending: THREE.AdditiveBlending, depthWrite: false }));
        network.add(new THREE.LineSegments(dGeo, dMat));
      }
    }

    // ── Axon pathways — bright curved fibres with colour gradients ───────
    let axonMat: any = null;
    {
      const axonPos: number[] = [], axonCol: number[] = [];
      const SEGMENTS = 24;
      edges.forEach(e => {
        for (let s2 = 0; s2 < SEGMENTS; s2++) {
          const p = s2 / (SEGMENTS - 1);
          const pt = bezierPt(e.a, e.mid, e.b, p);
          axonPos.push(pt.x, pt.y, pt.z);
          // colour flows source → target, brightest near the cell bodies
          const cr = e.colA.r + (e.colB.r - e.colA.r) * p;
          const cg = e.colA.g + (e.colB.g - e.colA.g) * p;
          const cb = e.colA.b + (e.colB.b - e.colA.b) * p;
          let br = 0.85 - Math.sin(p * Math.PI) * 0.35;
          if (e.long) br *= 0.5;
          axonCol.push(cr * br, cg * br, cb * br);
        }
      });
      if (axonPos.length) {
        const ag = track.geo(new THREE.BufferGeometry());
        ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(axonPos), 3));
        ag.setAttribute('color', new THREE.BufferAttribute(new Float32Array(axonCol), 3));
        axonMat = track.mat(new THREE.LineBasicMaterial({
          vertexColors: true, transparent: true, opacity: 0.4,
          blending: THREE.AdditiveBlending, depthWrite: false }));
        // Draw as a strip per edge: consecutive pairs form the polyline
        const idx: number[] = [];
        for (let e2 = 0; e2 < edges.length; e2++) {
          const base = e2 * SEGMENTS;
          for (let s2 = 0; s2 < SEGMENTS - 1; s2++) idx.push(base + s2, base + s2 + 1);
        }
        ag.setIndex(idx);
        network.add(new THREE.LineSegments(ag, axonMat));
      }
    }

    // ── Myelin sheath rings — glow rings threaded along each axon ────────
    let myelinMat: any = null;
    if (!mini && edges.length) {
      const mPos: number[] = [], mCol: number[] = [];
      edges.forEach(e => {
        if (e.long) return;
        const n = Math.max(2, Math.min(7, Math.round(e.dist / 12)));
        for (let k = 1; k <= n; k++) {
          const p = k / (n + 1);
          const pt = bezierPt(e.a, e.mid, e.b, p);
          mPos.push(pt.x, pt.y, pt.z);
          const cr = e.colA.r + (e.colB.r - e.colA.r) * p;
          const cg = e.colA.g + (e.colB.g - e.colA.g) * p;
          const cb = e.colA.b + (e.colB.b - e.colA.b) * p;
          mCol.push(cr * 0.7 + 0.3, cg * 0.7 + 0.3, cb * 0.7 + 0.3);
        }
      });
      if (mPos.length) {
        const mGeo = track.geo(new THREE.BufferGeometry());
        mGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mPos), 3));
        mGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(mCol), 3));
        myelinMat = track.mat(new THREE.PointsMaterial({
          map: myelinTex, size: 5.5, vertexColors: true, transparent: true,
          opacity: 0.4, sizeAttenuation: true, depthWrite: false,
          blending: THREE.AdditiveBlending }));
        network.add(new THREE.Points(mGeo, myelinMat));
      }
    }

    // ── Synaptic pulses — bright signals racing along the pathways ───────
    const MAX_PULSES = 120;
    const pulseGeo = track.geo(new THREE.BufferGeometry());
    const pulsePos = new Float32Array(MAX_PULSES * 3).fill(99999);
    const pulseCol = new Float32Array(MAX_PULSES * 3);
    const pulseSize = new Float32Array(MAX_PULSES);
    pulseGeo.setAttribute('position', new THREE.BufferAttribute(pulsePos, 3));
    pulseGeo.setAttribute('color', new THREE.BufferAttribute(pulseCol, 3));
    pulseGeo.setAttribute('aSize', new THREE.BufferAttribute(pulseSize, 1));
    pulseGeo.setDrawRange(0, 0);
    const pulseMat = track.mat(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: H / 2 }, uOpacity: { value: 1 } },
      vertexShader: `
        attribute float aSize; varying vec3 vCol;
        uniform float uScale;
        void main(){ vCol = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (uScale / -mv.z);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        varying vec3 vCol; uniform float uOpacity;
        void main(){ vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d); if(r > 0.5) discard;
          float core = smoothstep(0.18, 0.0, r);
          float halo = smoothstep(0.5, 0.04, r);
          vec3 c = mix(vCol, vec3(1.0), core) * (1.0 + core * 0.8);
          gl_FragColor = vec4(c, max(core, halo * 0.55) * uOpacity); }`,
      vertexColors: true,
    }));
    network.add(new THREE.Points(pulseGeo, pulseMat));

    const activePulses: { e: number; t: number; speed: number; rev: boolean; hot: boolean }[] = [];
    const spawnPulse = (e: number, rev: boolean, hot: boolean) => {
      const speed = hot ? 1.3 + Math.random() * 0.6 : 0.45 + Math.random() * 0.5;
      const free = activePulses.find(p => p.t >= 1);
      if (free) { free.e = e; free.t = 0; free.speed = speed; free.rev = rev; free.hot = hot; }
      else if (activePulses.length < MAX_PULSES) activePulses.push({ e, t: 0, speed, rev, hot });
    };
    let pulseTimer = 0;

    // ── Neuron firing — flash bursts that chain to connected neurons ─────
    const flares: any[] = [];
    if (!mini) {
      for (let k = 0; k < 8; k++) {
        const fm = track.mat(new THREE.SpriteMaterial({
          map: flareTex, color: '#FFFFFF', transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false }));
        const fs = new THREE.Sprite(fm);
        fs.scale.set(40, 40, 1);
        network.add(fs);
        flares.push({ sp: fs, mat: fm });
      }
    }
    let flareIdx = 0;
    const pendingFires: { i: number; at: number; depth: number }[] = [];
    let t = 0;
    const doFire = (i: number, depth: number) => {
      const s = neuronData[i];
      if (!s || s.firing) return;
      s.firing = true; s.fireTimer = 0;
      if (flares.length) {
        const g = flares[flareIdx++ % flares.length];
        g.mat.opacity = 0.85;
        g.mat.color.copy(s.col).lerp(new THREE.Color('#FFFFFF'), 0.55);
        g.sp.position.copy(s.v);
        const base = 22 + s.baseSize * 1.6;
        g.sp.scale.set(base, base, 1);
      }
      const links = adj.get(i) || [];
      links.forEach(({ e, rev }) => spawnPulse(e, rev, true));
      if (depth < 2) {
        links.forEach(({ e, rev }) => {
          const edge = edges[e];
          const j = rev ? edge.ai : edge.bi;
          if (Math.random() < 0.55) {
            pendingFires.push({ i: j, at: t + 0.18 + Math.random() * 0.22, depth: depth + 1 });
          }
        });
      }
    };

    // ── Selection: targeting reticle + highlighted pathways ──────────────
    const MAX_SEL_EDGES = 32;
    const selGeo = track.geo(new THREE.BufferGeometry());
    const selPos = new Float32Array(MAX_SEL_EDGES * 6);
    selGeo.setAttribute('position', new THREE.BufferAttribute(selPos, 3));
    selGeo.setDrawRange(0, 0);
    const selLineMat = track.mat(new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending }));
    network.add(new THREE.LineSegments(selGeo, selLineMat));
    const selRingMat = track.mat(new THREE.SpriteMaterial({
      map: track.tex(reticleTexture(THREE)), color: '#FFFFFF',
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false }));
    const selRing = new THREE.Sprite(selRingMat);
    selRing.renderOrder = 10;
    network.add(selRing);
    let lastSelId: number | null = null;
    let selRingBase = 10, selVisible = false;

    stateRef.current = { THREE, scene, camera, renderer, network, neuronData, nGeo,
      neuronPoints, mount, cons, camDistRef: { v: camDist }, rot: { x: 0.2, y: 0 } };

    // ── Interaction ──────────────────────────────────────────────────────
    const st = stateRef.current;
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 7;
    const mouse = new THREE.Vector2();
    const par = { x: 0, y: 0, tx: 0, ty: 0 };
    let dragging = false, lastX = 0, lastY = 0, hoverIdx = -1;

    const intro = { on: !reduceMotion, t: 0, from: camDist * 2.2 };
    if (intro.on) { network.rotation.y = -0.6; network.rotation.x = 0.35; }
    let smoothDist = intro.on ? intro.from : camDist;

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
      par.tx = mouse.x; par.ty = mouse.y;
      if (onHover) {
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObject(neuronPoints);
        const idx = hits.length ? hits[0].index : -1;
        if (idx !== hoverIdx) {
          hoverIdx = idx;
          onHover(idx >= 0 ? neuronData[idx].m : null, e.clientX, e.clientY);
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
      const hits = raycaster.intersectObject(neuronPoints);
      if (hits.length) onMemoryClick(neuronData[hits[0].index].m);
    };
    const onWheel = (e: WheelEvent) => {
      if (!interactive) return; e.preventDefault();
      intro.on = false;
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
    let raf = 0;
    const dt = 0.016;
    const WAVE_HZ = 0.4 * Math.PI * 2; // breathing brain, ~0.4Hz

    const render = () => {
      t += dt;
      if (!reduceMotion) st.rot.y += 0.0009;
      network.rotation.y += (st.rot.y - network.rotation.y) * 0.08;
      network.rotation.x += (st.rot.x - network.rotation.x) * 0.08;

      const selId = selectedRef.current;
      const waveS = reduceMotion ? 0 : Math.sin(t * WAVE_HZ);
      const wave = 1 + waveS * 0.05;
      network.scale.setScalar(1 + waveS * 0.012);

      const shaderT = reduceMotion ? 0 : t;
      nMat.uniforms.uTime.value = shaderT; nMat.uniforms.uWave.value = wave;
      hMat.uniforms.uTime.value = shaderT; hMat.uniforms.uWave.value = wave;

      // ── Scheduled chain-reaction fires + spontaneous firing ───────────
      if (!reduceMotion) {
        for (let k = pendingFires.length - 1; k >= 0; k--) {
          if (pendingFires[k].at <= t) {
            const f = pendingFires[k];
            pendingFires.splice(k, 1);
            doFire(f.i, f.depth);
          }
        }
        if (neuronData.length && Math.random() < (mini ? 0.004 : 0.012)) {
          doFire((Math.random() * neuronData.length) | 0, 0);
        }
      }

      // ── Neuron animation — breathing glow, firing flash, filter dim ───
      neuronData.forEach((s, i) => {
        const active = filterRef.current === 'all' || s.m.constellation === filterRef.current;
        if (s.firing) {
          s.fireTimer += dt;
          if (s.fireTimer > s.fireDuration) { s.firing = false; s.fireTimer = 0; }
        }
        const fireEnv = s.firing
          ? Math.sin(Math.min(1, s.fireTimer / s.fireDuration) * Math.PI) : 0;
        const tw = 0.92 + Math.sin(t * 1.3 + i) * 0.08;
        let boost = 1;
        if (s.m.id === selId) boost = 1.5;
        else if (i === hoverIdx) boost = 1.25;
        const b = s.brightness * tw * (active ? 1 : 0.08) * wave * boost;
        const white = fireEnv * 1.1 * (active ? 1 : 0.15);
        colAttr.array[i * 3] = s.col.r * b + white;
        colAttr.array[i * 3 + 1] = s.col.g * b + white;
        colAttr.array[i * 3 + 2] = s.col.b * b + white;
        let sz = s.baseSize * (active ? (0.95 + Math.sin(t * 1.5 + i) * 0.08) : 0.4);
        sz *= 1 + fireEnv * 0.9;
        if (s.m.id === selId) sz = s.baseSize * (1.45 + Math.sin(t * 2) * 0.1);
        else if (i === hoverIdx) sz = s.baseSize * 1.3;
        sizeAttr.array[i] = sz;
      });
      colAttr.needsUpdate = true; sizeAttr.needsUpdate = true;

      // ── Pathway + myelin breathing (in phase with the brain wave) ─────
      if (axonMat) axonMat.opacity = reduceMotion ? 0.3 : 0.32 + waveS * 0.12;
      if (myelinMat) myelinMat.opacity = reduceMotion ? 0.3 : 0.38 + Math.sin(t * WAVE_HZ + 1.2) * 0.16;

      // ── Firing flare sprites — expanding, fading bursts ───────────────
      flares.forEach(g => {
        if (g.mat.opacity > 0.01) {
          g.mat.opacity *= 0.93;
          const sc = g.sp.scale.x * 1.018;
          g.sp.scale.set(sc, sc, 1);
        } else { g.mat.opacity = 0; }
      });

      // ── Synaptic pulses along pathways ────────────────────────────────
      if (edges.length && !reduceMotion) {
        pulseTimer -= dt;
        if (pulseTimer <= 0) {
          spawnPulse((Math.random() * edges.length) | 0, Math.random() < 0.5, false);
          pulseTimer = (mini ? 0.35 : 0.12) + Math.random() * 0.3;
        }
        let np = 0;
        activePulses.forEach(p => {
          if (p.t >= 1) return;
          p.t += dt * p.speed;
          if (p.t > 1) { p.t = 1; return; }
          const e = edges[p.e];
          const prog = p.rev ? 1 - p.t : p.t;
          const pt = bezierPt(e.a, e.mid, e.b, prog);
          pulsePos[np * 3] = pt.x; pulsePos[np * 3 + 1] = pt.y; pulsePos[np * 3 + 2] = pt.z;
          const cr = e.colA.r + (e.colB.r - e.colA.r) * prog;
          const cg = e.colA.g + (e.colB.g - e.colA.g) * prog;
          const cb = e.colA.b + (e.colB.b - e.colA.b) * prog;
          const wMix = p.hot ? 0.85 : 0.5;
          pulseCol[np * 3] = cr + (1 - cr) * wMix;
          pulseCol[np * 3 + 1] = cg + (1 - cg) * wMix;
          pulseCol[np * 3 + 2] = cb + (1 - cb) * wMix;
          pulseSize[np] = p.hot ? 11 : 7;
          np++;
        });
        pulseGeo.attributes.position.needsUpdate = true;
        pulseGeo.attributes.color.needsUpdate = true;
        pulseGeo.attributes.aSize.needsUpdate = true;
        pulseGeo.setDrawRange(0, np);
        pulseMat.uniforms.uOpacity.value = 0.85 + waveS * 0.15;
      } else {
        pulseGeo.setDrawRange(0, 0);
      }

      // ── Selection reticle ─────────────────────────────────────────────
      if (selId !== lastSelId) {
        lastSelId = selId;
        const idx = selId != null ? idxById.get(selId) : undefined;
        if (idx != null) {
          const s = neuronData[idx];
          selRing.position.copy(s.v);
          selRingMat.color.set(s.col);
          selLineMat.color.set(s.col);
          selRingBase = 8 + s.baseSize * 1.2;
          let n = 0;
          (s.m.connected_to || []).forEach((tid: number) => {
            const p = positions[tid];
            if (!p || n >= MAX_SEL_EDGES) return;
            selPos.set([s.v.x, s.v.y, s.v.z, p.x, p.y, p.z], n * 6);
            n++;
          });
          selGeo.setDrawRange(0, n * 2);
          selGeo.attributes.position.needsUpdate = true;
          selVisible = true;
        } else { selVisible = false; }
      }
      selLineMat.opacity += ((selVisible ? 0.7 : 0) - selLineMat.opacity) * 0.12;
      selRingMat.opacity += ((selVisible ? 0.9 : 0) - selRingMat.opacity) * 0.12;
      if (selVisible || selRingMat.opacity > 0.01) {
        const rs = selRingBase * (1 + Math.sin(t * 2) * 0.08);
        selRing.scale.set(rs, rs, 1);
        selRingMat.rotation += 0.01;
      }

      // ── Camera ────────────────────────────────────────────────────────
      let d: number;
      if (intro.on) {
        intro.t += dt; const p = Math.min(1, intro.t / 2.6);
        d = intro.from + (st.camDistRef.v - intro.from) * (1 - Math.pow(1 - p, 3));
        smoothDist = d; if (p >= 1) intro.on = false;
      } else { smoothDist += (st.camDistRef.v - smoothDist) * 0.07; d = smoothDist; }
      if (interactive && !reduceMotion) { par.x += (par.tx - par.x) * 0.03; par.y += (par.ty - par.y) * 0.03; }
      const bob = reduceMotion ? 0 : Math.sin(t * 0.25) * 0.8;
      camera.position.set(par.x * 7, d * 0.25 + par.y * 4 + bob, d);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };
    render();

    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      nMat.uniforms.uScale.value = h / 2;
      hMat.uniforms.uScale.value = h / 2;
      pulseMat.uniforms.uScale.value = h / 2;
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
      geos.forEach(g => g.dispose());
      mats.forEach(m => m.dispose());
      texs.forEach(tx => tx.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, [memories, mini, interactive, bloom]);

  return <div ref={mountRef} className={`w-full h-full ${className}`} />;
}
