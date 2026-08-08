import React, { useEffect } from 'react';
import { useN2KStore } from '../../store/useN2KStore';
import { usePolarStore } from '../../store/usePolarStore';
import { getIPC } from '../../ipc';
import ConnectionBar from './ConnectionBar';
import InstrumentTile from './InstrumentTile';
import GPSTile from './GPSTile';
import RecordingControls from '../Controls/RecordingControls';
import { formatWindAngle } from '../../utils/angles';
import { EMPTY_POLAR_PERFORMANCE, requestLivePolarPerformance } from '../../utils/livePolarPerformance';
import type { AppSettings } from '../../types/ipc';
import type { BoatProfile } from '../../types/polar';

// Unit conversion constants
const MS_TO_KTS = 1.94384;
const RAD_TO_DEG = 180 / Math.PI;

/** Compute true wind from apparent wind and boat speed (all in knots/degrees). */
function computeTrueWind(awsKts: number, awaDeg: number, stwKts: number): { tws: number; twa: number } {
  const awaRad = awaDeg / RAD_TO_DEG;
  const u = awsKts * Math.sin(awaRad);
  const v = awsKts * Math.cos(awaRad) - stwKts;
  const tws = Math.sqrt(u * u + v * v);
  const twaRad = Math.atan2(u, v);
  const twaDeg = ((twaRad * RAD_TO_DEG) % 360 + 360) % 360;
  return { tws, twa: twaDeg };
}

export default function Dashboard() {
  const setMetric = useN2KStore((s) => s.setMetric);
  const updateLastUpdated = useN2KStore((s) => s.updateLastUpdated);
  const setPerformance = usePolarStore((s) => s.setPerformance);
  const activeProfileId = usePolarStore((s) => s.activeProfileId);
  const setProfiles = usePolarStore((s) => s.setProfiles);
  const setActiveProfile = usePolarStore((s) => s.setActiveProfile);
  const setPolarData = usePolarStore((s) => s.setPolarData);

  useEffect(() => {
    const ipc = getIPC();
    if (!ipc) return;
    const bridge = ipc;

    let cancelled = false;
    async function loadActivePolarProfile() {
      const [settings, profiles] = await Promise.all([
        bridge.getSettings() as Promise<AppSettings>,
        bridge.listPolars() as Promise<BoatProfile[]>,
      ]);
      if (cancelled || !Array.isArray(profiles)) return;

      setProfiles(profiles);
      const settingsProfileId = settings?.activePolarProfile ?? null;
      const requestedProfileId = activeProfileId ?? settingsProfileId;
      const activeProfile = profiles.find((profile) => profile.id === requestedProfileId) ?? profiles[0] ?? null;

      if (!activeProfile) {
        setActiveProfile(null);
        setPerformance(EMPTY_POLAR_PERFORMANCE);
        return;
      }

      setActiveProfile(activeProfile.id);
      const result = await bridge.getPolar({ id: activeProfile.id });
      if (!cancelled && result?.success && result.polarData) {
        setPolarData(result.polarData);
      }
    }

    loadActivePolarProfile().catch(() => {
      if (!cancelled) setPerformance(EMPTY_POLAR_PERFORMANCE);
    });

    return () => {
      cancelled = true;
    };
  }, [activeProfileId, setActiveProfile, setPerformance, setPolarData, setProfiles]);

  useEffect(() => {
    const ipc = getIPC();
    if (!ipc) return;

    let requestId = 0;
    const recompute = () => {
      const n2kState = useN2KStore.getState();
      const profileId = usePolarStore.getState().activeProfileId;
      const currentRequestId = ++requestId;
      void requestLivePolarPerformance(
        ipc,
        { stw: n2kState.stw, tws: n2kState.tws, twa: n2kState.twa },
        profileId,
        (performance) => {
          if (currentRequestId === requestId) setPerformance(performance);
        },
      );
    };

    recompute();
    const unsubN2K = useN2KStore.subscribe((state, previousState) => {
      if (
        state.stw !== previousState.stw ||
        state.tws !== previousState.tws ||
        state.twa !== previousState.twa
      ) {
        recompute();
      }
    });
    const unsubPolar = usePolarStore.subscribe((state, previousState) => {
      if (state.activeProfileId !== previousState.activeProfileId) {
        recompute();
      }
    });

    return () => {
      requestId++;
      unsubN2K();
      unsubPolar();
    };
  }, [setPerformance]);

  useEffect(() => {
    const ipc = getIPC();
    if (!ipc) return;

    const unsubPgn = ipc.on('pgn:data', (msg: any) => {
      const { pgn, fields } = msg;

      if (pgn === 128259 && fields.speedWaterReferenced != null) {
        setMetric('stw', Number(fields.speedWaterReferenced) * MS_TO_KTS);
        updateLastUpdated('stw');
      }
      if (pgn === 129026) {
        if (fields.sogWaterReferenced != null || fields.sog != null) {
          setMetric('sog', Number(fields.sogWaterReferenced ?? fields.sog) * MS_TO_KTS);
          updateLastUpdated('sog');
        }
        if (fields.cogWaterReferenced != null || fields.cog != null) {
          setMetric('cog', Number(fields.cogWaterReferenced ?? fields.cog) * RAD_TO_DEG);
          updateLastUpdated('cog');
        }
      }
      if (pgn === 130306) {
        const speedKts = fields.windSpeed != null ? Number(fields.windSpeed) * MS_TO_KTS : null;
        const angleDeg = fields.windAngle != null ? Number(fields.windAngle) * RAD_TO_DEG : null;
        const ref = fields.reference ?? fields.windReference;

        if (ref === 'Apparent') {
          // Apparent wind — relative to boat bow
          if (speedKts != null) { setMetric('aws', speedKts); updateLastUpdated('aws'); }
          if (angleDeg != null) { setMetric('awa', angleDeg); updateLastUpdated('awa'); }

          // Compute true wind from apparent wind + boat speed
          const state = useN2KStore.getState();
          const aws = speedKts ?? state.aws;
          const awa = angleDeg ?? state.awa;
          const stw = state.stw ?? state.sog ?? 0;
          if (aws != null && awa != null) {
            const tw = computeTrueWind(aws, awa, stw);
            setMetric('tws', tw.tws); updateLastUpdated('tws');
            setMetric('twa', tw.twa); updateLastUpdated('twa');
            const heading = state.heading;
            if (heading != null) {
              setMetric('twd', (heading + tw.twa) % 360);
              updateLastUpdated('twd');
            }
          }
        } else if (ref === 'True (boat referenced)' || ref === 'True (water referenced)') {
          // True wind angle relative to boat bow
          if (speedKts != null) { setMetric('tws', speedKts); updateLastUpdated('tws'); }
          if (angleDeg != null) { setMetric('twa', angleDeg); updateLastUpdated('twa'); }
        } else if (ref === 'True (ground referenced to North)' || ref === 'Magnetic (ground referenced to Magnetic North)') {
          // Wind direction (absolute) — store as TWD directly
          if (speedKts != null) { setMetric('tws', speedKts); updateLastUpdated('tws'); }
          if (angleDeg != null) { setMetric('twd', angleDeg); updateLastUpdated('twd'); }
        }
        // Ignore unknown/error wind reference types
      }
      if (pgn === 127250) {
        const heading = fields.heading ?? fields.headingMagnetic ?? fields.headingTrue;
        if (heading != null) {
          const headingDeg = Number(heading) * RAD_TO_DEG;
          setMetric('heading', headingDeg);
          updateLastUpdated('heading');
          // Recompute TWD when heading updates
          const twa = useN2KStore.getState().twa;
          if (twa != null) {
            setMetric('twd', (headingDeg + twa) % 360);
            updateLastUpdated('twd');
          }
        }
      }
      if (pgn === 129025) {
        if (fields.latitude != null) {
          setMetric('lat', Number(fields.latitude));
          updateLastUpdated('lat');
        }
        if (fields.longitude != null) {
          setMetric('lon', Number(fields.longitude));
          updateLastUpdated('lon');
        }
      }
    });

    const unsubPerf = ipc.on('polar:performance', (perf: any) => {
      setPerformance(perf);
    });

    return () => {
      unsubPgn();
      unsubPerf();
    };
  }, [setMetric, updateLastUpdated, setPerformance]);

  return (
    <div className="flex flex-col gap-4 h-full">
      <ConnectionBar />

      {/* Primary instruments */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <InstrumentTile label="STW" metricKey="stw" unit="kts" large />
        <InstrumentTile label="SOG" metricKey="sog" unit="kts" large />
        <InstrumentTile label="TWS" metricKey="tws" unit="kts" large />
        <InstrumentTile label="TWA" metricKey="twa" unit="°" format={(v) => formatWindAngle(v)} large />
        <InstrumentTile label="Heading" metricKey="heading" unit="°M" format={(v) => `${Math.round(v)}°M`} large />
      </div>

      {/* Secondary instruments */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <InstrumentTile label="AWS" metricKey="aws" unit="kts" />
        <InstrumentTile label="AWA" metricKey="awa" unit="°" format={(v) => formatWindAngle(v)} />
        <InstrumentTile label="COG" metricKey="cog" unit="°M" format={(v) => `${Math.round(v)}°M`} />
        <InstrumentTile label="TWD" metricKey="twd" unit="°M" format={(v) => `${Math.round(v)}°M`} />
        <VmgTile />
        <PolarTile />
      </div>

      {/* GPS */}
      <GPSTile />

      {/* Recording */}
      <div className="mt-auto">
        <RecordingControls />
      </div>
    </div>
  );
}

function VmgTile() {
  const stw = useN2KStore((s) => s.stw);
  const twa = useN2KStore((s) => s.twa);
  const isStale = useN2KStore((s) => s.isStale('stw') || s.isStale('twa'));
  const vmg = stw != null && twa != null
    ? stw * Math.cos(twa * Math.PI / 180)
    : null;

  return (
    <div
      className={`bg-n2k-surface rounded-lg p-4 flex flex-col items-center justify-center transition-opacity ${
        isStale ? 'opacity-40' : 'opacity-100'
      }`}
    >
      <span className="text-xs text-gray-500 uppercase tracking-wider mb-1">VMG</span>
      <span className="text-2xl font-mono font-bold text-white">
        {vmg !== null ? vmg.toFixed(2) : '—'}
      </span>
      <span className="text-xs text-gray-600 mt-1">kts</span>
    </div>
  );
}

function PolarTile() {
  const perf = usePolarStore((s) => s.performance);
  const val = perf.percentPolar;

  let colorClass = 'text-white';
  if (val !== null) {
    if (val >= 100) colorClass = 'text-n2k-success';
    else if (val >= 90) colorClass = 'text-n2k-warning';
    else colorClass = 'text-n2k-danger';
  }

  return (
    <div className="bg-n2k-surface rounded-lg p-4 flex flex-col items-center justify-center">
      <span className="text-xs text-gray-500 uppercase tracking-wider mb-1">% Polar</span>
      <span className={`text-2xl font-mono font-bold ${colorClass}`}>
        {val !== null ? `${val}%` : '--'}
      </span>
      <span className="text-xs text-gray-600 mt-1">performance</span>
    </div>
  );
}
