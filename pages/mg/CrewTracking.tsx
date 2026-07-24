// Max Gleam — live crew map at /tracking.
//
// The office view: every crew that has reported a position today, drawn over
// today's stops, refreshed every REFRESH_MS. Tap a crew to trace the route
// they have driven so far.
//
// Leaflet comes from the CDN <script> in index.html (window.L), so there is no
// npm dependency and no bundle cost — the same arrangement the Memory Galaxy
// uses for Three.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, Icon, Stat } from '../../components/ui';
import {
  gpsApi, agoLabel, clockTime, durationLabel, distanceLabel,
  type GpsActive, type GpsCrew, type GpsHistory,
} from '../../lib/gpsApi';

declare global {
  interface Window { L: any }
}

const REFRESH_MS = 20_000;
const ACCENT = '#19C3E6';
const CREW_COLOURS = ['#19C3E6', '#A78BFA', '#34D399', '#FBBF24', '#F472B6', '#60A5FA'];

const colourFor = (crewId: number) => CREW_COLOURS[crewId % CREW_COLOURS.length];

/** Resolve once Leaflet's CDN script has finished loading. */
function useLeaflet(): boolean {
  const [ready, setReady] = useState(() => typeof window !== 'undefined' && !!window.L);
  useEffect(() => {
    if (ready) return;
    const t = setInterval(() => { if (window.L) { setReady(true); clearInterval(t); } }, 120);
    return () => clearInterval(t);
  }, [ready]);
  return ready;
}

/** A van pin: crew initials in their colour, dimmed when the fix is stale.
 *  A live crew reporting away from its stop gets an amber ring — a glance-level
 *  flag that someone is not where the round says they should be. */
function vanIcon(crew: GpsCrew): any {
  const initials = crew.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const colour = colourFor(crew.crew_id);
  const offSite = crew.live && !!crew.geofence && !crew.geofence.on_site;
  const ring = offSite ? '#FBBF24' : colour;
  return window.L.divIcon({
    className: '',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html: `<div style="
      width:34px;height:34px;border-radius:50%;display:grid;place-items:center;
      font:700 12px/1 'Space Grotesk',system-ui,sans-serif;color:#05080C;
      background:${colour};border:2px solid ${offSite ? '#FBBF24' : 'rgba(255,255,255,0.85)'};
      box-shadow:0 0 0 4px ${ring}${offSite ? '55' : '33'}, 0 4px 12px rgba(0,0,0,0.5);
      opacity:${crew.live ? 1 : 0.45};">${initials}</div>`,
  });
}

/** The on-site / off-site line shown in a crew's map popup. */
function siteLine(crew: GpsCrew): string {
  if (!crew.geofence || !crew.live) return '';
  return crew.geofence.on_site
    ? `<br><span style="color:#34D399">On site · ${durationLabel(crew.on_site_seconds)}</span>`
    : `<br><span style="color:#FBBF24">${distanceLabel(crew.geofence.distance_m)} from stop</span>`;
}

function stopIcon(done: boolean): any {
  return window.L.divIcon({
    className: '',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    html: `<div style="width:12px;height:12px;border-radius:50%;
      background:${done ? 'rgba(52,211,153,0.9)' : 'rgba(255,255,255,0.35)'};
      border:1.5px solid rgba(5,8,12,0.8);"></div>`,
  });
}

export default function CrewTracking() {
  const leafletReady = useLeaflet();
  const [data, setData] = useState<GpsActive | null>(null);
  const [history, setHistory] = useState<GpsHistory | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const fittedRef = useRef(false);

  // ── Data ──────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      setData(await gpsApi.active());
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Could not load crew positions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  // The selected crew's route, refreshed on the same beat as the pins.
  useEffect(() => {
    if (selected === null) { setHistory(null); return; }
    let live = true;
    const pull = () => gpsApi.history(selected)
      .then(h => { if (live) setHistory(h); })
      .catch(() => { /* the pin still shows where they are */ });
    pull();
    const t = setInterval(pull, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [selected, data?.now]);

  // ── Map ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!leafletReady || !mapEl.current || mapRef.current) return;
    const L = window.L;
    const map = L.map(mapEl.current, { zoomControl: true, attributionControl: true })
      .setView([53.19, -2.89], 11);          // Chester, until the first fix lands
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // The container is sized by flexbox; Leaflet needs telling once it settles.
    setTimeout(() => map.invalidateSize(), 100);
    return () => { map.remove(); mapRef.current = null; };
  }, [leafletReady]);

  // Redraw pins whenever the data or the selection changes.
  useEffect(() => {
    if (!mapRef.current || !layerRef.current || !data) return;
    const L = window.L;
    const layer = layerRef.current;
    layer.clearLayers();

    for (const stop of data.jobs) {
      L.marker([stop.latitude, stop.longitude], { icon: stopIcon(!!stop.completed_at) })
        .bindPopup(
          `<b>${stop.address}</b><br>${stop.crew_name || 'Unassigned'}<br>` +
          `<span style="opacity:0.7">${stop.completed_at ? 'Done' : stop.started_at ? 'In progress' : 'Not started'}</span>`)
        .addTo(layer);
    }

    if (history && history.points.length > 1 && selected !== null) {
      L.polyline(history.points.map(p => [p.lat, p.lng]), {
        color: colourFor(selected), weight: 3, opacity: 0.75, dashArray: '6 6',
      }).addTo(layer);
    }

    const pins: any[] = [];
    for (const crew of data.crews) {
      const marker = L.marker([crew.position.lat, crew.position.lng], { icon: vanIcon(crew) })
        .bindPopup(
          `<b>${crew.name}</b><br>${crew.job?.address || 'Between jobs'}` +
          siteLine(crew) +
          `<br><span style="opacity:0.7">Last seen ${agoLabel(crew.age_seconds)}</span>`)
        .on('click', () => setSelected(crew.crew_id))
        .addTo(layer);
      pins.push(marker);
    }

    // Fit once, on the first data that has anything to fit to. After that the
    // dispatcher owns the viewport — refitting every 20s would fight them.
    if (!fittedRef.current && (pins.length || data.jobs.length)) {
      const pts = [
        ...data.crews.map(c => [c.position.lat, c.position.lng]),
        ...data.jobs.map(j => [j.latitude, j.longitude]),
      ];
      if (pts.length) {
        mapRef.current.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 14 });
        fittedRef.current = true;
      }
    }
  }, [data, history, selected]);

  // Centre on a crew when their card is tapped.
  const focus = useCallback((crew: GpsCrew) => {
    setSelected(crew.crew_id);
    mapRef.current?.setView([crew.position.lat, crew.position.lng], 15, { animate: true });
  }, []);

  const crews = data?.crews ?? [];
  const liveCrews = useMemo(() => crews.filter(c => c.live), [crews]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Crew tracking</h1>
          <p className="text-sm text-muted">
            Live positions while a job is open · refreshes every {REFRESH_MS / 1000}s
          </p>
        </div>
        <Button icon="refresh" onClick={load}>Refresh</Button>
      </div>

      {error && (
        <Card className="border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">{error}</Card>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Tracking now" value={data?.summary.tracking ?? 0} icon="my_location" accent={ACCENT} />
        <Stat label="On site" value={data?.summary.on_site ?? 0} icon="where_to_vote" accent="#34D399" />
        <Stat label="Seen today" value={data?.summary.seen_today ?? 0} icon="groups" accent="#A78BFA" />
        <Stat label="Stops today" value={data?.summary.jobs_today ?? 0} icon="pin_drop" accent="#FBBF24" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* Crew list */}
        <div className="space-y-2.5">
          {loading && !data ? (
            <Card className="p-6 text-center text-sm text-muted">Loading crews…</Card>
          ) : crews.length === 0 ? (
            <EmptyState icon="location_off" title="Nobody tracking yet"
              hint="A crew appears here the moment they start a job in the crew app with location switched on." />
          ) : crews.map(crew => (
            <button key={crew.crew_id} onClick={() => focus(crew)}
              className={`w-full rounded-2xl border p-3.5 text-left transition-all
                ${selected === crew.crew_id
                  ? 'border-accent/50 bg-accent/8'
                  : 'border-white/8 bg-white/[0.03] hover:border-white/15'}`}>
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-extrabold text-bg"
                  style={{ background: colourFor(crew.crew_id), opacity: crew.live ? 1 : 0.45 }}>
                  {crew.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-ink">{crew.name}</div>
                  <div className="truncate text-[11px] text-muted">
                    {crew.job?.address || 'Between jobs'}
                  </div>
                </div>
                <Badge tone={crew.live ? 'ok' : 'neutral'} dot>
                  {crew.live ? 'Live' : 'Stale'}
                </Badge>
              </div>
              <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px] text-muted">
                <span>Last seen {agoLabel(crew.age_seconds)}</span>
                {crew.geofence && crew.live ? (
                  crew.geofence.on_site ? (
                    <span className="flex items-center gap-1 text-emerald-300">
                      <Icon name="where_to_vote" size={12} />On site {durationLabel(crew.on_site_seconds)}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-amber-300">
                      <Icon name="wrong_location" size={12} />{distanceLabel(crew.geofence.distance_m)} from stop
                    </span>
                  )
                ) : crew.job?.started_at ? (
                  <span>Started {clockTime(crew.job.started_at)}</span>
                ) : null}
              </div>
              {selected === crew.crew_id && history && (
                <div className="mt-2.5 flex items-center gap-3 border-t border-white/8 pt-2.5 text-[11px] text-muted">
                  <span className="flex items-center gap-1">
                    <Icon name="route" size={13} />{history.summary.distance_miles} mi
                  </span>
                  <span>{history.summary.count} points</span>
                  <span>{history.summary.jobs.length} jobs</span>
                </div>
              )}
            </button>
          ))}

          {selected !== null && (
            <Button className="w-full" icon="close" onClick={() => setSelected(null)}>
              Clear route
            </Button>
          )}
        </div>

        {/* Map */}
        <Card className="overflow-hidden p-0">
          {!leafletReady ? (
            <div className="grid h-[60vh] min-h-[360px] place-items-center text-sm text-muted lg:h-[540px]">
              <div className="text-center">
                <Icon name="map" size={30} className="mb-2 animate-pulse text-accent" />
                <p>Loading map…</p>
              </div>
            </div>
          ) : (
            <div ref={mapEl} className="h-[60vh] min-h-[360px] w-full lg:h-[540px]" />
          )}
          <div className="flex flex-wrap items-center gap-4 border-t border-white/8 px-4 py-2.5 text-[11px] text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: ACCENT }} />Crew
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full ring-2 ring-amber-400" style={{ background: ACCENT }} />Off site
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400/90" />Done
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-white/35" />Stop
            </span>
            {liveCrews.length > 0 && (
              <span className="ml-auto">
                {liveCrews.length} crew{liveCrews.length === 1 ? '' : 's'} reporting
              </span>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
