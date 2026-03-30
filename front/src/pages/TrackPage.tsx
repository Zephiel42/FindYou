import { useEffect, useState } from 'react';
import { useParams, useLocation } from 'react-router-dom';

type Status = 'loading' | 'ready' | 'done' | 'error' | 'not_found';

const DURATION_LABEL: Record<number, string> = {
  0: 'Forever', 1: '1 hour', 24: '24 hours', 72: '3 days', 168: '7 days', 720: '30 days',
};
const durationLabel = (h: number) => DURATION_LABEL[h] ?? `${h} hours`;

export default function TrackPage() {
  const { slug }     = useParams<{ slug: string }>();
  const location     = useLocation();
  const prefix       = location.pathname.split('/')[1];

  const [status,  setStatus]  = useState<Status>('loading');
  const [name,    setName]    = useState('');
  const [expires, setExpires] = useState(0);

  const doTrack = async () => {
    const res = await fetch(`/api/v1/link/${prefix}/${slug}`, { method: 'POST' });
    setStatus(res.ok ? 'done' : 'error');
  };

  useEffect(() => {
    fetch(`/api/v1/link/${prefix}/${slug}`)
      .then(r => {
        if (r.status === 404) { setStatus('not_found'); return null; }
        return r.json();
      })
      .then(data => {
        if (!data) return;
        setName(data.name);
        setExpires(data.expires_hours);
        if (!data.requires_validation) {
          doTrack();
        } else {
          setStatus('ready');
        }
      })
      .catch(() => setStatus('error'));
  }, []);

  return (
    <div className="track-page">
      <div className="track-card">
        <h1 className="track-logo">FindYou</h1>

        {status === 'loading' && <p className="track-msg">Loading…</p>}

        {status === 'not_found' && (
          <>
            <h2 className="track-title">Link not found</h2>
            <p className="track-body">This tracking link doesn't exist or has been removed.</p>
          </>
        )}

        {status === 'error' && (
          <>
            <h2 className="track-title">Something went wrong</h2>
            <p className="track-body">Please try again later.</p>
          </>
        )}

        {status === 'ready' && (
          <>
            <h2 className="track-title">Someone wants to know where you are</h2>
            <p className="track-body">
              Clicking the button below will share your approximate location with the person who created this link.
              Your position will appear on their map as <strong>"{name}"</strong>.
            </p>

            <div className="track-info-box">
              <div className="track-info-row">
                <span className="track-info-label">How it works</span>
                <span className="track-info-val">IP address geolocation — city-level accuracy, no GPS required</span>
              </div>
              <div className="track-info-row">
                <span className="track-info-label">Data stored</span>
                <span className="track-info-val">Approximate city, country, and IP address</span>
              </div>
              <div className="track-info-row">
                <span className="track-info-label">Retention</span>
                <span className="track-info-val">{durationLabel(expires)}</span>
              </div>
            </div>

            <button className="track-btn" onClick={doTrack}>Share my location</button>

            <p className="track-disclaimer">
              By clicking above you consent to your approximate location being stored for the duration shown.
              Nothing is collected unless you click the button.
            </p>
          </>
        )}

        {status === 'done' && (
          <>
            <h2 className="track-title">Location shared</h2>
            <p className="track-body">
              Your approximate location has been saved as <strong>"{name}"</strong>.
              {expires > 0 ? ` It will be automatically removed after ${durationLabel(expires)}.` : ''}
            </p>
            <div className="track-check">✓</div>
          </>
        )}
      </div>
    </div>
  );
}
