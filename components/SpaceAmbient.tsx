// SpaceAmbient — Web Audio API ambient space drone for the Memory Galaxy.
// No external files needed. Creates a layered, evolving deep-space soundscape.
// Auto-starts on mount, pauses on unmount. Cleanup friendly.

import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui';

let _ctx: AudioContext | null = null;
let _nodes: { stop: () => void }[] = [];
let _started = false;

function getCtx(): AudioContext {
  if (!_ctx) _ctx = new AudioContext();
  if (_ctx.state === 'suspended') _ctx.resume();
  return _ctx;
}

function startDrone() {
  if (_started) return;
  _started = true;
  const ctx = getCtx();
  _nodes = [];

  // Master gain — overall volume
  const master = ctx.createGain();
  master.gain.value = 0.0875; // Even lower — barely-there background texture
  master.connect(ctx.destination);

  // ── Layer 1: Deep bass drone (80Hz, more audible on phone speakers) ──
  const osc1 = ctx.createOscillator();
  osc1.type = 'sine';
  osc1.frequency.value = 80;
  const g1 = ctx.createGain();
  g1.gain.value = 0.2;
  const lfo1 = ctx.createOscillator();
  lfo1.type = 'sine';
  lfo1.frequency.value = 0.12;
  const lfo1g = ctx.createGain();
  lfo1g.gain.value = 6;
  lfo1.connect(lfo1g);
  lfo1g.connect(osc1.frequency);
  osc1.connect(g1);
  g1.connect(master);
  lfo1.start(); osc1.start();
  _nodes.push({ stop: () => { osc1.stop(); lfo1.stop(); } });

  // ── Layer 2: Warm pad drone (140Hz) ──
  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = 140;
  const g2 = ctx.createGain();
  g2.gain.value = 0.15;
  const lfo2 = ctx.createOscillator();
  lfo2.type = 'sine';
  lfo2.frequency.value = 0.08;
  const lfo2g = ctx.createGain();
  lfo2g.gain.value = 8;
  lfo2.connect(lfo2g);
  lfo2g.connect(osc2.frequency);
  osc2.connect(g2);
  g2.connect(master);
  lfo2.start(); osc2.start();
  _nodes.push({ stop: () => { osc2.stop(); lfo2.stop(); } });

  // ── Layer 3: Ethereal pad (filtered noise) ──
  const bufferSize = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(Math.random(), 3);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 800;
  bp.Q.value = 1.5;
  const lfo3 = ctx.createOscillator();
  lfo3.type = 'sine';
  lfo3.frequency.value = 0.04;
  const lfo3g = ctx.createGain();
  lfo3g.gain.value = 200;
  lfo3.connect(lfo3g);
  lfo3g.connect(bp.frequency);
  const g3 = ctx.createGain();
  g3.gain.value = 0.1;
  noise.connect(bp);
  bp.connect(g3);
  g3.connect(master);
  lfo3.start(); noise.start();
  _nodes.push({ stop: () => { noise.stop(); lfo3.stop(); } });

  // ── Layer 4: Slow swell sine (adds movement) ──
  const osc3 = ctx.createOscillator();
  osc3.type = 'sine';
  osc3.frequency.value = 300;
  const g4 = ctx.createGain();
  g4.gain.value = 0;
  const swell = ctx.createGain();
  swell.gain.value = 0.06;
  // Slow envelope
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, ctx.currentTime);
  env.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 4);
  env.gain.linearRampToValueAtTime(0, ctx.currentTime + 8);
  env.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 14);
  env.gain.linearRampToValueAtTime(0, ctx.currentTime + 20);
  // Loop the swell via a repeating scheduler
  function scheduleSwell() {
    const now = ctx.currentTime;
    const env2 = ctx.createGain();
    env2.gain.setValueAtTime(0, now);
    env2.gain.linearRampToValueAtTime(0.1, now + 3);
    env2.gain.linearRampToValueAtTime(0, now + 7);
    osc3.connect(env2);
    env2.connect(master);
    _nodes.push({ stop: () => env2.disconnect() });
    setTimeout(scheduleSwell, 9000 + Math.random() * 6000);
  }
  scheduleSwell();
  osc3.start();
  _nodes.push({ stop: () => osc3.stop() });
}

function stopDrone() {
  _nodes.forEach(n => n.stop());
  _nodes = [];
  _started = false;
}

export function useSpaceAmbient() {
  const [playing, setPlaying] = useState(true); // Default ON
  const started = useRef(false);

  const toggle = () => {
    if (playing) {
      stopDrone();
      setPlaying(false);
    } else {
      startDrone();
      setPlaying(true);
    }
  };

  // Auto-start on mount (browser may suspend AudioContext until user gesture)
  useEffect(() => {
    // Attempt immediate start — browser may suspend but getCtx handles resume
    try { startDrone(); started.current = true; } catch {}
    
    // Fallback: start on first user interaction if AudioContext was blocked
    const handler = () => {
      if (!started.current) {
        started.current = true;
        startDrone();
      }
      document.removeEventListener('click', handler);
      document.removeEventListener('touchstart', handler);
    };
    document.addEventListener('click', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      stopDrone();
      document.removeEventListener('click', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, []);

  return { playing, toggle };
}

export function AmbientToggle({ playing, onToggle }: { playing: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-all active:scale-95
        ${playing
          ? 'glass-raised border-violet/40 text-violet shadow-[0_0_16px_rgba(167,139,250,0.3)]'
          : 'glass border-white/10 text-muted hover:text-ink'}`}
      title={playing ? 'Mute space ambient' : 'Play space ambient'}
    >
      <Icon name={playing ? 'music_note' : 'music_off'} size={14} />
      {playing ? 'Ambient On' : 'Space Sounds'}
    </button>
  );
}
