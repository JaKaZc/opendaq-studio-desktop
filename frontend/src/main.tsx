import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PictureWindow } from './components/signals/PictureWindow';
import { applyTheme, useSettings } from './store/useSettings';
import './index.css';

// Apply the stored theme before the first paint so there is no flash of the
// wrong palette while React mounts.
applyTheme(useSettings.getState().theme);

const container = document.getElementById('root');
if (!container) {
  throw new Error('The #root element is missing from index.html');
}

// A picture window, opened from a picture track, shows only that picture.
const params = new URLSearchParams(window.location.search);
const picture = params.get('picture');

createRoot(container).render(
  <StrictMode>
    {picture ? <PictureWindow signalId={picture} name={params.get('name') ?? picture} /> : <App />}
  </StrictMode>,
);
