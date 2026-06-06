import React, { useEffect } from 'react';
import { useN2KStore } from '../../store/useN2KStore';
import { usePolarStore } from '../../store/usePolarStore';
import { getIPC } from '../../ipc';
import ConnectionBar from './ConnectionBar';
import InstrumentTile from './InstrumentTile';
import GPSTile from './GPSTile';
import RecordingControls from '../Controls/RecordingControls';

export default function Dashboard() {
  const setMetric = useN2KStore((s) => s.setMetric);
  const updateLastUpdated = useN2KStore((s) => s.updateLastUpdated);
  const setPerformance = usePolarStore((s) => s.setPerformance);

  useEffect(() => {
    const ipc = getIPC();
    if (!ipc) return;

    const unsubPgn = ipc.on('pgn:data', (msg: any) => {
      const { pgn, fields } = msg;
      const now = Date.now();

      if (pgn === 128259 && fields.speedWaterReferenced != null) {
        const stw = Number(fields.speedWaterReferenced);
        setMetric('stw', stw);
        updateLastUpdated('stw');
      }
      if (pgn === 129026) {
        if (fields.sogWaterReferenced != null || fields.sog != null) {
          setMetric('sog', Number(fields.sogWaterReferenced ?? fields.sog));
          updateLastUpdated('sog');
        }
        if (fields.cogWaterReferenced != null || fields.cog != null) {
          setMetric('cog', Number(fields.cogWaterReferenced ?? fields.cog));
          updateLastUpdated('cog');
        }
      }
      if (pgn === 130306) {
        if (fields.windSpeed != null) {
          if (fields.windReference === 'True (boat referenced)' || fields.windReference === 'True (ground referenced to North)') {
            setMetric('tws', Number(fields.windSpeed));
            updateLastUpdated('tws');
          } else {
            setMetric('aws', Number(fields.windSpeed));
            updateLastUpdated('aws');
          }
        }
        if (fields.windAngle != null) {
          if (fields.windReference === 'True (boat referenced)' || fields.windReference === 'True (ground referenced to North)') {
            setMetric('twa', Number(fields.windAngle));
            updateLastUpdated('twa');
          } else {
            setMetric('awa', Number(fields.windAngle));
            updateLastUpdated('awa');
          }
        }
      }
      if (pgn === 127250) {
        const heading = fields.heading ?? fields.headingMagnetic ?? fields.headingTrue;
        if (heading != null) {
          setMetric('heading', Number(heading));
          updateLastUpdated('heading');
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
        <InstrumentTile label="TWA" metricKey="twa" unit="°" format={(v) => `${Math.round(v)}°`} large />
        <InstrumentTile label="Heading" metricKey="heading" unit="°" format={(v) => `${Math.round(v)}°`} large />
      </div>

      {/* Secondary instruments */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <InstrumentTile label="AWS" metricKey="aws" unit="kts" />
        <InstrumentTile label="AWA" metricKey="awa" unit="°" format={(v) => `${Math.round(v)}°`} />
        <InstrumentTile label="COG" metricKey="cog" unit="°" format={(v) => `${Math.round(v)}°`} />
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
        {val !== null ? `${val}%` : '—'}
      </span>
      <span className="text-xs text-gray-600 mt-1">performance</span>
    </div>
  );
}
