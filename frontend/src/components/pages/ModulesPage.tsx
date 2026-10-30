import { useMemo, useState } from 'react';
import { GitBranch, Hash, Puzzle, Search } from 'lucide-react';
import { api } from '../../lib/api';
import { useAsyncData } from '../../lib/useAsyncData';
import { cn } from '../../lib/utils';
import type { ComponentTypeInfo, ComponentTypeKind, ModuleInfo } from '../../lib/types';
import { useSession } from '../../store/useSession';
import { Input } from '../ui/Field';
import { Badge, EmptyState, InfoRow, Spinner } from '../ui/Feedback';
import { Section, SplitPane } from '../ui/Layout';
import { PropertyGrid } from '../detail/PropertyGrid';

const KIND_LABELS: Record<ComponentTypeKind, string> = {
  device: 'Device types',
  functionBlock: 'Function block types',
  server: 'Server types',
  streaming: 'Streaming types',
};

/**
 * Loaded modules and the component types they provide.
 *
 * This answers the question that comes up whenever a device will not connect:
 * *is the module that speaks this protocol even loaded, which version is it, and
 * what does its configuration look like?*  The default configuration of a type is
 * shown read-only, so the options can be inspected before anything is created.
 */
export function ModulesPage() {
  const reportError = useSession((state) => state.reportError);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{ moduleId: string; kind: ComponentTypeKind; key: string } | null>(
    null,
  );

  const { data: modules, loading } = useAsyncData(
    (signal) => api.modules.list(signal).then((response) => response.modules),
    [],
    { onError: (error) => reportError(error, 'Could not list modules') },
  );

  const { data: detail, loading: detailLoading } = useAsyncData(
    (signal) =>
      api.modules.type(selected!.moduleId, selected!.kind, selected!.key, signal),
    [selected?.moduleId, selected?.kind, selected?.key],
    { enabled: selected !== null, onError: (error) => reportError(error, 'Could not load the type') },
  );

  const filtered = useMemo(() => {
    if (!modules) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return modules;
    return modules
      .map((module) => ({
        ...module,
        types: Object.fromEntries(
          Object.entries(module.types).map(([kind, entries]) => [
            kind,
            entries.filter(
              (entry) =>
                entry.name.toLowerCase().includes(needle) ||
                entry.id.toLowerCase().includes(needle) ||
                module.name.toLowerCase().includes(needle),
            ),
          ]),
        ) as ModuleInfo['types'],
      }))
      .filter(
        (module) =>
          module.name.toLowerCase().includes(needle) ||
          Object.values(module.types).some((entries) => entries.length > 0),
      );
  }, [modules, query]);

  return (
    <SplitPane
      className="min-h-0 flex-1"
      size={420}
      onSizeChange={() => undefined}
      min={300}
      max={640}
      ariaLabel="Resize the module list"
      first={
        <Section
          title="Modules"
          count={modules?.length}
          className="min-h-0 flex-1 border-r border-border bg-panel"
          bodyClassName="flex min-h-0 flex-col"
        >
          <div className="relative border-b border-border px-2 py-1.5">
            <Search
              size={12}
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-text-faint"
            />
            <Input
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search modules and types…"
              aria-label="Search modules"
              className="pl-6.5"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-text-muted">
                <Spinner size={14} /> Loading modules…
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Puzzle size={20} aria-hidden />}
                title="No modules match"
                description="Modules are loaded from the SDK's module directory and any extra paths passed to the backend."
              />
            ) : (
              filtered.map((module) => (
                <ModuleCard
                  key={module.id}
                  module={module}
                  selected={selected}
                  onSelect={(kind, key) => setSelected({ moduleId: module.id, kind, key })}
                />
              ))
            )}
          </div>
        </Section>
      }
      second={
        <div className="min-h-0 flex-1 overflow-y-auto bg-panel">
          {!selected ? (
            <EmptyState
              className="h-full"
              icon={<Puzzle size={22} aria-hidden />}
              title="Select a component type"
              description="Pick a device, function block, server or streaming type to see its identifier, connection prefix and default configuration."
            />
          ) : detailLoading && !detail ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-text-muted">
              <Spinner size={14} /> Loading…
            </div>
          ) : detail ? (
            <TypeDetail type={detail} />
          ) : null}
        </div>
      }
    />
  );
}

function ModuleCard({
  module,
  selected,
  onSelect,
}: {
  module: ModuleInfo;
  selected: { moduleId: string; kind: ComponentTypeKind; key: string } | null;
  onSelect: (kind: ComponentTypeKind, key: string) => void;
}) {
  const kinds = Object.entries(module.types) as [ComponentTypeKind, ComponentTypeInfo[]][];
  const total = kinds.reduce((sum, [, entries]) => sum + entries.length, 0);

  return (
    <div className="border-b border-border">
      <div className="px-2.5 py-2">
        <div className="flex items-baseline gap-2">
          <h3 className="min-w-0 truncate text-[12.5px] font-semibold" title={module.id}>
            {module.name}
          </h3>
          <Badge tone={module.isDevelopment ? 'warn' : 'neutral'}>v{module.version ?? '?'}</Badge>
        </div>
        {module.branch || module.hash ? (
          <p className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-text-faint">
            {module.branch ? (
              <span className="flex items-center gap-1">
                <GitBranch size={9} aria-hidden />
                {module.branch}
              </span>
            ) : null}
            {module.hash ? (
              <span className="flex items-center gap-1">
                <Hash size={9} aria-hidden />
                {module.hash.slice(0, 10)}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      {total === 0 ? (
        <p className="px-2.5 pb-2 text-[11.5px] text-text-faint">Provides no component types.</p>
      ) : (
        kinds
          .filter(([, entries]) => entries.length > 0)
          .map(([kind, entries]) => (
            <div key={kind} className="pb-1">
              <p className="px-2.5 py-0.5 text-[10px] font-semibold tracking-wide text-text-faint uppercase">
                {KIND_LABELS[kind]}
              </p>
              <ul>
                {entries.map((entry) => {
                  const active =
                    selected?.moduleId === module.id && selected.kind === kind && selected.key === entry.key;
                  return (
                    <li key={`${kind}:${entry.key}`}>
                      <button
                        type="button"
                        onClick={() => onSelect(kind, entry.key)}
                        aria-pressed={active}
                        className={cn(
                          'flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-[12px]',
                          'row-hover',
                          active && 'row-selected',
                        )}
                        title={entry.description || entry.id}
                      >
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        {entry.connectionStringPrefix ? (
                          <span className="shrink-0 font-mono text-[10px] text-text-faint">
                            {entry.connectionStringPrefix}://
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
      )}
    </div>
  );
}

function TypeDetail({ type }: { type: ComponentTypeInfo }) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[14px] font-semibold">{type.name}</h2>
          <Badge>{KIND_LABELS[type.kind].replace(' types', '')}</Badge>
        </div>
        {type.description ? (
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{type.description}</p>
        ) : null}
        <dl className="mt-2">
          <InfoRow label="Type id" mono>
            {type.id}
          </InfoRow>
          {type.connectionStringPrefix ? (
            <InfoRow label="Connection prefix" mono>
              {type.connectionStringPrefix}://
            </InfoRow>
          ) : null}
          {type.moduleId ? (
            <InfoRow label="Module" mono>
              {type.moduleId}
            </InfoRow>
          ) : null}
        </dl>
      </div>

      {type.defaultConfig && type.defaultConfig.properties.length > 0 ? (
        <Section title="Default configuration" className="min-h-0 flex-1" bodyClassName="flex min-h-0 flex-col">
          <PropertyGrid componentId={type.id} tree={type.defaultConfig} readOnly />
        </Section>
      ) : (
        <EmptyState
          title="No configuration options"
          description="This type is created without a configuration object."
        />
      )}
    </div>
  );
}
