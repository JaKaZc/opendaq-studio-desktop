import { useState } from 'react';
import {
  Crosshair,
  Gauge,
  Grid3x3,
  Layers,
  Pause,
  Play,
  Radio,
  Sigma,
  SlidersHorizontal,
  TrendingDown,
  TrendingUp,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { WINDOW_FUNCTIONS } from '../../lib/dsp';
import { cn } from '../../lib/utils';
import { formatDuration } from '../../lib/format';
import type { TriggerMode, TriggerStatus } from '../../lib/trigger';
import { traces } from '../../store/traceStore';
import { useScope, visibleWindow, WINDOW_PRESETS } from '../../store/useScope';
import { Button, ButtonGroup, IconButton, Segment } from '../ui/Button';
import { CommitInput, Checkbox, Select } from '../ui/Field';
import { Badge, type BadgeTone } from '../ui/Feedback';
import { AlignToggle } from '../time/TimeSync';

/** The scope's control strip: time base, transport, vertical scale, overlays. */
export function ScopeToolbar() {
  const state = useScope();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const traceCount = state.traces.length;
  const cursorsOn = state.cursorA.enabled || state.cursorB.enabled;

  return (
    <div className="flex flex-col gap-1.5 border-b border-border bg-panel px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* --- transport ---------------------------------------------------- */}
        <ButtonGroup>
          <Segment active={!state.paused} onClick={() => state.setPaused(false)}>
            <Play size={11} className="inline" /> Run
          </Segment>
          <Segment active={state.paused} onClick={() => state.setPaused(true)}>
            <Pause size={11} className="inline" /> Pause
          </Segment>
        </ButtonGroup>

        {/* One button back to the newest samples, labelled, and loud when needed. */}
        <button
          type="button"
          onClick={state.goLive}
          title="Jump to the newest samples, resume and fit the vertical scale (L)"
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors',
            state.xMode === 'rolling' && !state.paused
              ? 'text-text-muted hover:bg-sunken hover:text-text'
              : 'bg-accent text-white hover:brightness-110',
          )}
        >
          <Radio size={12} /> Live
        </button>

        {/* Devices whose clocks differ line up, as on the Signals page. */}
        <AlignToggle />

        {/* --- trigger ------------------------------------------------------ */}
        <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
          Trigger
          <Select
            size="sm"
            className="w-24"
            aria-label="Trigger mode"
            value={state.trigger.mode}
            disabled={traceCount === 0}
            onChange={(event) => enableTrigger(event.target.value as TriggerMode)}
          >
            <option value="off" title="Free-running: the newest samples at the right edge">
              Off
            </option>
            <option value="auto" title="Trigger when the level is crossed; free-run if it is not">
              Auto
            </option>
            <option value="normal" title="Only redraw on a crossing; hold the last one meanwhile">
              Normal
            </option>
            <option value="single" title="Capture the next crossing, then stop">
              Single
            </option>
          </Select>
        </label>

        {/* --- time base --------------------------------------------------- */}
        <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
          Window
          <Select
            size="sm"
            className="w-24"
            aria-label="Time window"
            value={String(state.windowSeconds)}
            onChange={(event) => state.setWindowSeconds(Number(event.target.value))}
          >
            {(WINDOW_PRESETS as readonly number[]).map((seconds) => (
              <option key={seconds} value={seconds}>
                {formatDuration(seconds)}
              </option>
            ))}
            {!(WINDOW_PRESETS as readonly number[]).includes(state.windowSeconds) ? (
              <option value={state.windowSeconds}>{formatDuration(state.windowSeconds)}</option>
            ) : null}
          </Select>
        </label>

        <ButtonGroup>
          <Segment active={false} onClick={() => state.zoomBy(0.5)} aria-label="Zoom in">
            <ZoomIn size={12} className="inline" />
          </Segment>
          <Segment active={false} onClick={() => state.zoomBy(2)} aria-label="Zoom out">
            <ZoomOut size={12} className="inline" />
          </Segment>
        </ButtonGroup>

        {/* --- vertical scale --------------------------------------------- */}
        <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
          Y axis
          <Select
            size="sm"
            className="w-32"
            aria-label="Vertical scale mode"
            value={state.yMode}
            onChange={(event) => state.setYMode(event.target.value as typeof state.yMode)}
          >
            <option value="auto">Auto scale</option>
            <option value="descriptor">Signal range</option>
            <option value="manual">Manual</option>
          </Select>
        </label>

        {state.yMode === 'manual' ? (
          <div className="flex items-center gap-1">
            {/* Fixed-width wrappers: see the note on the trigger level input. */}
            <span className="w-20 shrink-0">
              <CommitInput
                value={String(state.yMin)}
                ariaLabel="Y axis minimum"
                onCommit={(next) => {
                  const value = Number(next);
                  if (Number.isFinite(value)) state.setYRange(value, state.yMax);
                }}
              />
            </span>
            <span className="text-text-faint">…</span>
            <span className="w-20 shrink-0">
              <CommitInput
                value={String(state.yMax)}
                ariaLabel="Y axis maximum"
                onCommit={(next) => {
                  const value = Number(next);
                  if (Number.isFinite(value)) state.setYRange(state.yMin, value);
                }}
              />
            </span>
          </div>
        ) : null}

        {/* --- overlays --------------------------------------------------- */}
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label="Grid" size="sm" active={state.showGrid} onClick={() => state.toggle('showGrid')}>
            <Grid3x3 size={13} />
          </IconButton>
          <IconButton
            label="Stack traces"
            size="sm"
            active={state.stacked}
            onClick={() => state.toggle('stacked')}
          >
            <Layers size={13} />
          </IconButton>
          <IconButton
            label="Statistics"
            size="sm"
            active={state.showStatistics}
            onClick={() => state.toggle('showStatistics')}
          >
            <Sigma size={13} />
          </IconButton>
          <IconButton
            label="Spectrum"
            size="sm"
            active={state.showSpectrum}
            onClick={() => state.toggle('showSpectrum')}
          >
            <Gauge size={13} />
          </IconButton>
          <IconButton
            label={cursorsOn ? 'Clear cursors' : 'Cursors (shift-drag on the plot)'}
            size="sm"
            active={cursorsOn}
            onClick={() => {
              state.setCursor('A', { enabled: !cursorsOn });
              state.setCursor('B', { enabled: false });
            }}
          >
            <Crosshair size={13} />
          </IconButton>
          <IconButton
            label="Scope settings"
            size="sm"
            active={showAdvanced}
            onClick={() => setShowAdvanced((value) => !value)}
          >
            <SlidersHorizontal size={13} />
          </IconButton>
        </div>
      </div>

      {state.trigger.mode !== 'off' ? <TriggerBar /> : null}

      {showAdvanced ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-control)] bg-sunken px-2.5 py-2">
          <Checkbox
            checked={state.autoResolution}
            onChange={state.setAutoResolution}
            label="Match resolution to the plot width"
            hint="two points per pixel"
          />
          <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
            Points / second
            <span className="w-24 shrink-0">
              <CommitInput
                value={String(state.pointsPerSecond)}
                ariaLabel="Points per second"
                disabled={state.autoResolution}
                onCommit={(next) => {
                  const value = Number(next);
                  if (Number.isFinite(value)) state.setPointsPerSecond(value);
                }}
              />
            </span>
          </label>
          <Badge title="Higher than the signal rate means raw samples; lower means the backend sends min/max pairs">
            {state.autoResolution ? 'auto' : 'fixed'}
          </Badge>

          <div className="h-5 w-px bg-border" />

          <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
            FFT window
            <Select
              size="sm"
              className="w-28"
              aria-label="FFT window function"
              value={state.spectrum.windowFunction}
              onChange={(event) =>
                state.setSpectrum({ windowFunction: event.target.value as typeof state.spectrum.windowFunction })
              }
            >
              {WINDOW_FUNCTIONS.map((entry) => (
                <option key={entry.id} value={entry.id} title={entry.note}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
            FFT size
            <Select
              size="sm"
              className="w-24"
              aria-label="FFT size"
              value={String(state.spectrum.size)}
              onChange={(event) => state.setSpectrum({ size: Number(event.target.value) })}
            >
              {[1024, 2048, 4096, 8192, 16_384, 32_768].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          </label>
          <Checkbox
            checked={state.spectrum.decibels}
            onChange={(value) => state.setSpectrum({ decibels: value })}
            label="dB scale"
          />
          <Checkbox
            checked={state.spectrum.logFrequency}
            onChange={(value) => state.setSpectrum({ logFrequency: value })}
            label="Log frequency"
          />
          <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
            Averaging
            <input
              type="range"
              min={0}
              max={0.95}
              step={0.05}
              value={state.spectrum.smoothing}
              aria-label="Spectrum averaging"
              onChange={(event) => state.setSpectrum({ smoothing: Number(event.target.value) })}
              className="w-24 accent-[var(--color-brand)]"
            />
            <span className="num w-8">{state.spectrum.smoothing.toFixed(2)}</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A level halfway through what the source is showing right now.
 *
 * The level from a previous source is meaningless for a new one - a 10 V
 * level on a 5 mV signal never fires - so choosing a source resets it to
 * something that will. Rounded, because a level of 0.0312847 is noise to read.
 */
function midLevel(signalId: string): number {
  const window_ = visibleWindow(useScope.getState());
  const extent = traces.buffer(signalId)?.extent(window_.start, window_.end);
  if (!extent) return 0;
  const middle = (extent.min + extent.max) / 2;
  return middle === 0 ? 0 : Number(middle.toPrecision(3));
}

/** Turning the trigger on needs a source; take the first trace if none is set. */
function enableTrigger(mode: TriggerMode): void {
  const state = useScope.getState();
  const current = state.trigger.sourceId;
  const stillPlotted = current !== null && state.traces.some((trace) => trace.signalId === current);
  if (mode === 'off' || stillPlotted) {
    state.setTrigger({ mode });
    return;
  }
  const first = state.traces.find((trace) => trace.visible) ?? state.traces[0];
  if (!first) return;
  state.setTrigger({ mode, sourceId: first.signalId, level: midLevel(first.signalId) });
}

const STATUS_LABELS: Record<TriggerStatus, string> = {
  off: 'Off',
  armed: 'Waiting',
  triggered: 'Triggered',
  holding: 'Holding',
  auto: 'Free-running',
  stopped: 'Captured',
};

/**
 * Not status colours: none of these states is good or bad, they are just what
 * the trigger is doing. The accent marks the one state where something happened.
 */
const STATUS_TONES: Record<TriggerStatus, BadgeTone> = {
  off: 'neutral',
  armed: 'neutral',
  triggered: 'brand',
  holding: 'neutral',
  auto: 'neutral',
  stopped: 'brand',
};

const POSITIONS = [0.1, 0.25, 0.5, 0.75, 0.9] as const;

function TriggerBar() {
  const trigger = useScope((state) => state.trigger);
  const status = useScope((state) => state.triggerStatus);
  const traceConfigs = useScope((state) => state.traces);
  const setTrigger = useScope((state) => state.setTrigger);
  const armTrigger = useScope((state) => state.armTrigger);

  const unit = trigger.sourceId ? (traces.meta(trigger.sourceId)?.unit ?? '') : '';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-control)] bg-sunken px-2.5 py-1.5">
      <label className="flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-text-muted">
        Source
        <Select
          size="sm"
          className="w-40"
          aria-label="Trigger source"
          value={trigger.sourceId ?? ''}
          onChange={(event) => {
            const sourceId = event.target.value || null;
            setTrigger({ sourceId, level: sourceId ? midLevel(sourceId) : 0 });
          }}
        >
          {trigger.sourceId === null ? <option value="">Choose a signal…</option> : null}
          {traceConfigs.map((trace) => (
            <option key={trace.signalId} value={trace.signalId}>
              {trace.name}
            </option>
          ))}
        </Select>
      </label>

      <ButtonGroup>
        <Segment
          active={trigger.slope === 'rising'}
          onClick={() => setTrigger({ slope: 'rising' })}
          aria-label="Rising edge"
          title="Trigger on a rising edge"
        >
          <TrendingUp size={12} className="inline" /> Rising
        </Segment>
        <Segment
          active={trigger.slope === 'falling'}
          onClick={() => setTrigger({ slope: 'falling' })}
          aria-label="Falling edge"
          title="Trigger on a falling edge"
        >
          <TrendingDown size={12} className="inline" /> Falling
        </Segment>
      </ButtonGroup>

      <label className="flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-text-muted">
        Level
        {/* Fixed-width wrapper: the control's base class is `w-full`, and `cn`
            concatenates rather than merges, so a width on the input itself loses. */}
        <span className="w-20 shrink-0">
          <CommitInput
            value={String(trigger.level)}
            ariaLabel="Trigger level"
            onCommit={(next) => {
              const value = Number(next);
              if (Number.isFinite(value)) setTrigger({ level: value });
            }}
          />
        </span>
        {unit ? <span className="text-text-faint">{unit}</span> : null}
      </label>
      <Button
        size="sm"
        variant="ghost"
        disabled={!trigger.sourceId}
        title="Set the level halfway through what the source is showing"
        onClick={() => trigger.sourceId && setTrigger({ level: midLevel(trigger.sourceId) })}
      >
        50%
      </Button>

      <label className="flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-text-muted">
        Pre-trigger
        <Select
          size="sm"
          className="w-20"
          aria-label="Share of the window shown before the trigger"
          value={String(trigger.position)}
          onChange={(event) => setTrigger({ position: Number(event.target.value) })}
        >
          {POSITIONS.map((position) => (
            <option key={position} value={position}>
              {Math.round(position * 100)}%
            </option>
          ))}
        </Select>
      </label>

      <label
        className="flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-text-muted"
        title="How far back past the level the signal must go before it can trigger again. Stops noise on a slow edge from firing several times."
      >
        Noise reject
        <span className="w-16 shrink-0">
          <CommitInput
            value={String(trigger.hysteresis)}
            ariaLabel="Trigger noise rejection"
            onCommit={(next) => {
              const value = Number(next);
              if (Number.isFinite(value) && value >= 0) setTrigger({ hysteresis: value });
            }}
          />
        </span>
        {unit ? <span className="text-text-faint">{unit}</span> : null}
      </label>

      <div className="ml-auto flex items-center gap-1.5">
        <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>
        {trigger.mode === 'single' ? (
          <Button size="sm" variant={status === 'stopped' ? 'primary' : 'secondary'} onClick={armTrigger}>
            {status === 'stopped' ? 'Arm again' : 'Re-arm'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
