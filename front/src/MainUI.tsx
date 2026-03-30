import { useState, useCallback, useEffect } from 'react';
import Globe, { type GlobeMarker, GLOBE_TEXTURES } from './components/Globe';
import LinkBuilderPanel from './components/LinkBuilderPanel';

interface IpInfo {
  query: string;
  country: string;
  countryCode: string;
  regionName: string;
  city: string;
  zip: string;
  lat: number;
  lon: number;
  timezone: string;
  isp: string;
  org: string;
  as: string;
  proxy: boolean;
  hosting: boolean;
  mobile: boolean;
}

interface DBMarker {
  id: number;
  name: string;
  ip: string;
  lat: number;
  lon: number;
  country: string;
  city: string;
}

const IP_FIELDS: [keyof IpInfo, string][] = [
  ['query',      'IP'],
  ['country',    'Country'],
  ['regionName', 'Region'],
  ['city',       'City'],
  ['zip',        'ZIP'],
  ['timezone',   'Timezone'],
  ['isp',        'ISP'],
  ['org',        'Org'],
  ['as',         'AS'],
  ['proxy',      'Proxy'],
  ['hosting',    'Hosting'],
  ['mobile',     'Mobile'],
];

export default function MainUI() {
  const [input,        setInput]        = useState('');
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [markers,      setMarkers]      = useState<GlobeMarker[]>([]);
  const [selected,     setSelected]     = useState<GlobeMarker | null>(null);
  const [ipCache,      setIpCache]      = useState(new Map<string, IpInfo>());
  const [linkPanel,    setLinkPanel]    = useState(false);
  const [textureIdx,   setTextureIdx]   = useState(0);
  const [focusTarget,  setFocusTarget]  = useState<{ lat: number; lng: number } | null>(null);
  const [globalSearch, setGlobalSearch] = useState('');

  useEffect(() => {
    fetch('/api/v1/ip/me')
      .then(r => r.json())
      .then((data: IpInfo) => {
        const m: GlobeMarker = { id: 'you', lat: data.lat, lng: data.lon, name: 'You', markerType: 'local', color: 0x00e5ff, ip: data.query, country: data.country, city: data.city };
        setMarkers(prev => [m, ...prev]);
        setIpCache(prev => new Map(prev).set('you', data));
      })
      .catch(() => {});

    fetch('/api/v1/markers')
      .then(r => r.json())
      .then((data: DBMarker[]) => {
        setMarkers(prev => [...prev, ...data.map(m => dbToMarker(m))]);
      })
      .catch(() => {});

    const es = new EventSource('/api/v1/markers/stream');
    es.onmessage = (e) => {
      const m: DBMarker = JSON.parse(e.data);
      setMarkers(prev => prev.some(p => p.id === `g-${m.id}`) ? prev : [...prev, dbToMarker(m)]);
    };
    return () => es.close();
  }, []);

  const lookup = useCallback(async (ip: string) => {
    const q = ip.trim();
    if (!q) return;
    const existing = markers.find(m => m.ip === q || m.id === q);
    if (existing) { setSelected(existing); return; }

    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/v1/ip/${q}`);
      const data = await res.json() as IpInfo & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Lookup failed');
      const m: GlobeMarker = { id: q, lat: data.lat, lng: data.lon, name: q, markerType: 'local', ip: data.query, country: data.country, city: data.city };
      setMarkers(prev => [...prev.filter(p => p.id !== q), m]);
      setIpCache(prev => new Map(prev).set(q, data));
      setSelected(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed');
    } finally {
      setLoading(false);
    }
  }, [markers]);

  const saveGlobal = useCallback(async () => {
    if (!selected || selected.markerType === 'global') return;
    const res = await fetch('/api/v1/markers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: selected.name, ip: selected.ip ?? '', lat: selected.lat, lon: selected.lng, country: selected.country ?? '', city: selected.city ?? '' }),
    });
    if (!res.ok) return;
    const saved: DBMarker = await res.json();
    const updated: GlobeMarker = { ...selected, id: `g-${saved.id}`, markerType: 'global' };
    setMarkers(prev => prev.map(m => m.id === selected.id ? updated : m));
    setSelected(updated);
  }, [selected]);

  const selectAndFocus = useCallback((m: GlobeMarker) => {
    setSelected(m);
    setFocusTarget({ lat: m.lat, lng: m.lng });
  }, []);

  const onMarkerClick = useCallback((m: GlobeMarker) => {
    setSelected(m);
    setFocusTarget(null);
  }, []);

  const local  = markers.filter(m => m.markerType === 'local');
  const global = markers.filter(m => m.markerType === 'global');
  const filteredGlobal = globalSearch.trim()
    ? global.filter(m => m.name.toLowerCase().includes(globalSearch.toLowerCase()) || m.city?.toLowerCase().includes(globalSearch.toLowerCase()) || m.country?.toLowerCase().includes(globalSearch.toLowerCase()))
    : global;

  const ipInfo = selected ? ipCache.get(selected.id) : null;

  const formatVal = (key: keyof IpInfo, val: IpInfo[keyof IpInfo]) => {
    if (key === 'country') return `${val} (${ipInfo?.countryCode})`;
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    return String(val);
  };

  return (
    <div className="app">
      <aside className="left-panel">
        <h1>FindYou</h1>

        <div className="search-row">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && lookup(input)} placeholder="IP address" spellCheck={false} />
          <button onClick={() => lookup(input)} disabled={loading}>{loading ? '…' : 'Go'}</button>
        </div>

        <button className="my-ip-btn" onClick={() => { const m = markers.find(m => m.id === 'you'); if (m) selectAndFocus(m); }}>
          My IP
        </button>

        {error && <p className="error">{error}</p>}

        {local.length > 0 && (
          <div className="marker-section">
            <p className="section-label">Local</p>
            {local.map(m => (
              <div key={m.id} className={`marker-item${selected?.id === m.id ? ' active' : ''}`} onClick={() => setSelected(m)}>
                {m.name}
              </div>
            ))}
          </div>
        )}

        {global.length > 0 && (
          <div className="marker-section">
            <p className="section-label">Global</p>
            <input
              className="search-global"
              value={globalSearch}
              onChange={e => setGlobalSearch(e.target.value)}
              placeholder="Search…"
              spellCheck={false}
            />
            {filteredGlobal.map(m => (
              <div key={m.id} className={`marker-item global${selected?.id === m.id ? ' active' : ''}`} onClick={() => selectAndFocus(m)}>
                <span>{m.name}</span>
                {m.city && <span className="marker-sub">{m.city}</span>}
              </div>
            ))}
            {filteredGlobal.length === 0 && <p className="placeholder">No match.</p>}
          </div>
        )}
      </aside>

      <div className="globe-container">
        <Globe markers={markers} onMarkerClick={onMarkerClick} textureUrl={GLOBE_TEXTURES[textureIdx].url} focusTarget={focusTarget} />

        <div className="globe-actions">
          <button
            className="texture-btn"
            onClick={() => setTextureIdx(i => (i + 1) % GLOBE_TEXTURES.length)}
            title="Switch texture"
          >
            {GLOBE_TEXTURES[textureIdx].label}
          </button>
          <button className="link-builder-btn" onClick={() => setLinkPanel(true)}>Add someone</button>
        </div>

        <LinkBuilderPanel open={linkPanel} onClose={() => setLinkPanel(false)} />
      </div>

      <aside className="right-panel">
        {selected ? (
          <>
            <div className="detail-header">
              <span className="detail-name">{selected.name}</span>
              <span className={`type-badge ${selected.markerType}`}>{selected.markerType}</span>
            </div>
            {ipInfo ? (
              <div className="info-list">
                {IP_FIELDS.map(([key, label]) => (
                  <div key={key} className="info-row">
                    <span className="info-label">{label}</span>
                    <span className="info-value">{formatVal(key, ipInfo[key])}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="info-list">
                {selected.ip      && <div className="info-row"><span className="info-label">IP</span><span className="info-value">{selected.ip}</span></div>}
                {selected.country && <div className="info-row"><span className="info-label">Country</span><span className="info-value">{selected.country}</span></div>}
                {selected.city    && <div className="info-row"><span className="info-label">City</span><span className="info-value">{selected.city}</span></div>}
                <div className="info-row"><span className="info-label">Lat</span><span className="info-value">{selected.lat.toFixed(4)}</span></div>
                <div className="info-row"><span className="info-label">Lon</span><span className="info-value">{selected.lng.toFixed(4)}</span></div>
              </div>
            )}
            {selected.markerType === 'local' && selected.id !== 'you' && (
              <button className="save-btn" onClick={saveGlobal}>Save globally</button>
            )}
          </>
        ) : (
          <p className="placeholder">Click a point on the globe or in the list to see details.</p>
        )}
      </aside>
    </div>
  );
}

function dbToMarker(m: DBMarker): GlobeMarker {
  return { id: `g-${m.id}`, lat: m.lat, lng: m.lon, name: m.name, markerType: 'global', ip: m.ip, country: m.country, city: m.city };
}
