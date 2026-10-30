import { useEffect } from 'react';
import { usePicture } from '../../lib/pictures';
import { PictureCanvas } from './PictureCanvas';
import { PlotCanvas } from './PlotCanvas';

/**
 * Opens an image signal, such as a renderer's or a camera's, in a window of
 * its own, sized to the picture. In the desktop app it is a new app window;
 * in a browser, a popup.
 */
export function openPictureWindow(signalId: string, name: string, size?: { width: number; height: number } | null) {
  const query = new URLSearchParams({ picture: signalId, name });
  const width = Math.min(size?.width ?? 800, window.screen.availWidth);
  const height = Math.min(size?.height ?? 600, window.screen.availHeight);
  // One window per signal: opening it again brings the same window forward.
  const opened = window.open(`${window.location.pathname}?${query}`, `picture:${signalId}`, `popup,width=${width},height=${height}`);
  opened?.focus();
}

/** The page of such a window: the newest picture, filling the window. */
export function PictureWindow({ signalId, name }: { signalId: string; name: string }) {
  const picture = usePicture(signalId);

  useEffect(() => {
    document.title = name;
  }, [name]);

  return (
    <div className="group fixed inset-0 bg-[#101418]">
      {picture?.plot ? (
        <PlotCanvas data={picture.plot} label={`The newest plot of ${name}`} />
      ) : picture?.bitmap ? (
        <PictureCanvas bitmap={picture.bitmap} label={`The newest picture of ${name}`} />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-[13px] text-white/70">Waiting for the first frame</span>
      )}
      {picture ? (
        <span className="absolute right-2 bottom-2 rounded bg-black/55 px-2 py-0.5 font-mono text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          {picture.rate.toFixed(1)} frames/s
        </span>
      ) : null}
    </div>
  );
}
