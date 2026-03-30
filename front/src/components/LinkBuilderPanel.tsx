import { useState, useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
}

const PREFIXES = ['track', 'visit', 'ping', 'join'];

const DURATIONS = [
  { label: '1 hour',   value: 1 },
  { label: '24 hours', value: 24 },
  { label: '3 days',   value: 72 },
  { label: '7 days',   value: 168 },
  { label: '30 days',  value: 720 },
  { label: 'Forever',  value: 0 },
];

type SlugState = 'idle' | 'checking' | 'available' | 'taken';

export default function LinkBuilderPanel({ open, onClose }: Props) {
  const [name,        setName]        = useState('');
  const [expires,     setExpires]     = useState(24);
  const [prefix,      setPrefix]      = useState('track');
  const [safeSlug,    setSafeSlug]    = useState(true);
  const [customSlug,  setCustomSlug]  = useState('');
  const [slugState,   setSlugState]   = useState<SlugState>('idle');
  const [validation,  setValidation]  = useState(true);
  const [singleUse,   setSingleUse]   = useState(true);
  const [link,        setLink]        = useState<string | null>(null);
  const [copied,      setCopied]      = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (safeSlug || !customSlug.trim()) { setSlugState('idle'); return; }
    setSlugState('checking');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res  = await fetch(`/api/v1/links/check?prefix=${prefix}&slug=${encodeURIComponent(customSlug.trim())}`);
        const data = await res.json() as { available: boolean };
        setSlugState(data.available ? 'available' : 'taken');
      } catch {
        setSlugState('idle');
      }
    }, 400);
  }, [customSlug, prefix, safeSlug]);

  const canGenerate = !!name.trim() && (safeSlug || slugState === 'available');

  const generate = async () => {
    if (!canGenerate) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:                name.trim(),
          expires_hours:       expires,
          path_prefix:         prefix,
          slug:                safeSlug ? '' : customSlug.trim(),
          requires_validation: validation,
          single_use:          singleUse,
        }),
      });
      const data = await res.json() as { token?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to create link');
      setLink(`${window.location.origin}/${prefix}/${data.token}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  const copy = () => {
    if (!link) return;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = () => {
    setName(''); setExpires(24); setPrefix('track'); setSafeSlug(true);
    setCustomSlug(''); setSlugState('idle'); setValidation(true); setSingleUse(true);
    setLink(null); setError(null);
  };

  const slugIndicator = () => {
    if (safeSlug) return null;
    if (!customSlug.trim()) return null;
    if (slugState === 'checking')  return <span className="slug-check checking">Checking…</span>;
    if (slugState === 'available') return <span className="slug-check available">✓ Available</span>;
    if (slugState === 'taken')     return <span className="slug-check taken">✗ Already taken</span>;
    return null;
  };

  if (!open) return null;

  return (
    <div className="lb-overlay" onClick={onClose}>
      <div className="lb-panel" onClick={e => e.stopPropagation()}>
        <button className="lb-close" onClick={onClose}>✕</button>
        <h2 className="lb-title">Create a tracking link</h2>

        <p className="lb-desc">
          Share this link with anyone. When they open it, their approximate position (based on IP address) will appear on your globe as a global marker.
          Choose whether they must consent first or are tracked automatically on page load.
        </p>

        {!link ? (
          <div className="lb-form">
            <div className="lb-field">
              <label>Marker name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Friend, Office, Bob…" spellCheck={false} />
            </div>

            <div className="lb-field">
              <label>Path prefix</label>
              <div className="lb-prefix-row">
                {PREFIXES.map(p => (
                  <button key={p} className={`lb-prefix-btn${prefix === p ? ' selected' : ''}`} onClick={() => setPrefix(p)}>
                    /{p}/
                  </button>
                ))}
              </div>
            </div>

            <div className="lb-field">
              <label>Slug</label>
              <div className="lb-toggle-row">
                <input type="checkbox" id="safe-slug" checked={safeSlug} onChange={e => setSafeSlug(e.target.checked)} />
                <label htmlFor="safe-slug" className="lb-toggle-label">Use safe random token (guaranteed unique)</label>
              </div>
              {!safeSlug && (
                <div className="lb-slug-row">
                  <span className="lb-slug-prefix">/{prefix}/</span>
                  <input
                    value={customSlug}
                    onChange={e => setCustomSlug(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                    placeholder="my-custom-slug"
                    spellCheck={false}
                  />
                  {slugIndicator()}
                </div>
              )}
            </div>

            <div className="lb-field">
              <label>Visitor consent</label>
              <div className="lb-toggle-row">
                <input type="checkbox" id="validation" checked={validation} onChange={e => setValidation(e.target.checked)} />
                <label htmlFor="validation" className="lb-toggle-label">
                  {validation ? 'Visitor must click a button to confirm' : 'Track automatically on page load'}
                </label>
              </div>
            </div>

            <div className="lb-field">
              <label>Link usage</label>
              <div className="lb-toggle-row">
                <input type="checkbox" id="single-use" checked={singleUse} onChange={e => setSingleUse(e.target.checked)} />
                <label htmlFor="single-use" className="lb-toggle-label">
                  {singleUse ? 'Single use — link expires after first visit' : 'Multiple uses — link stays active'}
                </label>
              </div>
            </div>

            <div className="lb-field">
              <label>Data retention</label>
              <select value={expires} onChange={e => setExpires(Number(e.target.value))}>
                {DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>

            {error && <p className="error">{error}</p>}

            <button className="lb-generate" onClick={generate} disabled={loading || !canGenerate}>
              {loading ? 'Generating…' : 'Generate link'}
            </button>
          </div>
        ) : (
          <div className="lb-result">
            <p className="lb-result-label">Your tracking link</p>
            <div className="lb-link-row">
              <span className="lb-link-text">{link}</span>
              <button className="lb-copy" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
            </div>
            <p className="lb-result-note">
              Retention: <strong>{DURATIONS.find(d => d.value === expires)?.label}</strong>
              {expires === 0 ? ' — marker never expires.' : ' — marker auto-deletes after the period.'}<br />
              Consent: <strong>{validation ? 'required' : 'automatic'}</strong><br />
              Usage: <strong>{singleUse ? 'single use' : 'multiple uses'}</strong>
            </p>
            <button className="lb-new" onClick={reset}>Create another</button>
          </div>
        )}
      </div>
    </div>
  );
}
