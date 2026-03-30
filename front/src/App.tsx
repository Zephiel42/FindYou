import { Routes, Route } from 'react-router-dom';
import MainUI from './MainUI';
import TrackPage from './pages/TrackPage';

export default function App() {
  return (
    <Routes>
      <Route path="/track/:slug"  element={<TrackPage />} />
      <Route path="/visit/:slug"  element={<TrackPage />} />
      <Route path="/ping/:slug"   element={<TrackPage />} />
      <Route path="/join/:slug"   element={<TrackPage />} />
      <Route path="*"             element={<MainUI />} />
    </Routes>
  );
}
