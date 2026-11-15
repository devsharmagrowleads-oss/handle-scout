'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CheckResult, DomainPrice, Report, ScoutEvent, State, Suggestion } from '@handle-scout/core';
import { Icon, Spinner, type IconName } from './Icons';

// ---- types -----------------------------------------------------------------------

type StreamEvent = ScoutEvent | { type: 'export'; markdown: string } | { type: 'error'; message: string };
type PlanEvent = Extract<ScoutEvent, { type: 'plan' }>;
type SuggestionsPlan = Extract<ScoutEvent, { type: 'suggestions-plan' }>;
type ModeChoice = 'auto' | 'personal' | 'brand';
type ScopeChoice = 'all' | 'domains' | 'socials';
type Filter = 'all' | 'available' | 'unknown' | 'taken';

interface Run {
  status: 'idle' | 'loading' | 'done' | 'error';
  query: string;
  plan?: PlanEvent;
  results: Record<string, CheckResult>;
  suggestionsPlan?: SuggestionsPlan;
  suggestionResults: Record<string, CheckResult[]>;
  report?: Report;
  markdown?: string;
  error?: string;
}

type Action =
  | { type: 'start'; query: string }
  | { type: 'event'; event: StreamEvent }
  | { type: 'fail'; message: string }
  | { type: 'reset' };

const IDLE: Run = { status: 'idle', query: '', results: {}, suggestionResults: {} };
const key = (r: Pick<CheckResult, 'kind' | 'id'>) => `${r.kind}:${r.id}`;

function reducer(state: Run, action: Action): Run {
  switch (action.type) {
    case 'reset':
      return IDLE;
    case 'start':
      return { ...IDLE, status: 'loading', query: action.query };
    case 'fail':
      return { ...state, status: 'error', error: action.message };
    case 'event': {
      const event = action.event;
      switch (event.type) {
        case 'plan':
          return { ...state, plan: event };
        case 'result':
          return { ...state, results: { ...state.results, [key(event.result)]: event.result } };
        case 'suggestions-plan':
          return { ...state, suggestionsPlan: event };
        case 'suggestion-result':
          return {
            ...state,
            suggestionResults: {
              ...state.suggestionResults,
              [event.handle]: [...(state.suggestionResults[event.handle] ?? []), event.result],
            },
          };
        case 'done':
          return { ...state, report: event.report };
        case 'export':
          return { ...state, status: 'done', markdown: event.markdown };
        case 'error':
          return { ...state, status: 'error', error: event.message };
      }
    }
  }
}

// ---- presentation helpers --------------------------------------------------------

const STATE_META: Record<State, { label: string; icon: IconName }> = {
  available: { label: 'Available', icon: 'available' },
  taken: { label: 'Taken', icon: 'taken' },
  unknown: { label: 'Unknown', icon: 'unknown' },
  invalid: { label: 'Not allowed', icon: 'invalid' },
};

const CONFIDENCE_TEXT = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' } as const;

function StateBadge({ state }: { state: State | 'pending' }) {
  if (state === 'pending') {
    return (
      <span className="badge badge-pending">
        <Spinner />
        <span>Checking</span>
      </span>
    );
  }
  const meta = STATE_META[state];
  return (
    <span className={`badge badge-${state}`}>
      <Icon name={meta.icon} />
      <span>{meta.label}</span>
    </span>
  );
}

function showReason(r: CheckResult): boolean {
  return (
    Boolean(r.reason) &&
    (r.state === 'unknown' || r.state === 'invalid' || r.confidence === 'low' || r.method === 'dns' || r.method === 'registrar')
  );
}

// Kept in step with formatPrice in @handle-scout/core, which cannot be imported into
// a client component because the core entry point also pulls in node:dns.
function priceText(price: DomainPrice): string {
  const renewal = price.renewal ?? price.regular;
  return renewal && renewal !== price.registration
    ? `$${price.registration} first year, then $${renewal}/yr`
    : `$${price.registration}/yr`;
}

/** Says how the registrar was used, or why it could not be, next to the Domains heading. */
function providerNote(report: Report | undefined): string {
  const p = report?.domainProvider;
  if (!p) return '';
  if (p.confirmed > 0 && p.error) return `. ${p.confirmed} priced by ${p.name}; ${p.failed} could not be confirmed: ${p.error}`;
  if (p.confirmed > 0) return `. ${p.confirmed} confirmed and priced by ${p.name}, in US dollars`;
  if (p.error) return `. ${p.name} could not be used: ${p.error}`;
  return '';
}

function linkLabel(r: CheckResult): string {
  if (r.kind === 'domain') return r.state === 'available' ? 'Look up' : 'WHOIS';
  if (r.state === 'unknown') return 'Check by hand';
  if (r.state === 'available') return 'Verify';
  return 'Open';
}

interface RowModel {
  id: string;
  title: string;
  subtitle?: string;
  /** Render the title in the mono face (domains). */
  mono?: boolean;
  result?: CheckResult;
}

function ResultRow({ row }: { row: RowModel }) {
  const r = row.result;
  return (
    <li className={`row ${r ? `row-${r.state}` : 'row-pending'}`}>
      <div className="row-state">
        <StateBadge state={r ? r.state : 'pending'} />
      </div>
      <div className="row-main">
        <span className={row.mono ? "row-title row-title-mono" : "row-title"}>{row.title}</span>
        {row.subtitle ? <span className="row-sub">{row.subtitle}</span> : null}
        {r?.price ? (
          <p className="row-price">
            {r.price.premium ? <span className="tag tag-premium">Premium</span> : null}
            <span>{priceText(r.price)}</span>
            {r.provider ? <span className="row-price-source">via {r.provider}</span> : null}
          </p>
        ) : null}
        {r && showReason(r) ? <p className="row-reason">{r.reason}</p> : null}
      </div>
      <div className="row-meta">
        {r?.confidence ? (
          <span className={`confidence confidence-${r.confidence}`} title={CONFIDENCE_TEXT[r.confidence]}>
            <span className="confidence-pips" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {r.confidence}
            <span className="sr-only"> confidence</span>
          </span>
        ) : null}
      </div>
      <div className="row-link">
        {r ? (
          <a className="link" href={r.url} target="_blank" rel="noopener noreferrer">
            {linkLabel(r)}
            <Icon name="external" size={14} />
            <span className="sr-only"> {row.title} (opens in a new tab)</span>
          </a>
        ) : null}
      </div>
    </li>
  );
}

function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  hideLegend,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string; hint?: string; count?: number }[];
  onChange: (value: T) => void;
  hideLegend?: boolean;
}) {
  return (
    <fieldset className="segmented">
      <legend className={hideLegend ? 'sr-only' : 'field-label'}>{legend}</legend>
      <div className="segmented-track">
        {options.map((option) => (
          <label key={option.value} className="segment" title={option.hint}>
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span className="segment-face">
              {option.label}
              {option.count !== undefined ? <span className="segment-count">{option.count}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-quiet btn-small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard blocked: the handle is still selectable text */
        }
      }}
    >
      <Icon name={copied ? 'available' : 'copy'} size={14} />
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

// ---- suggestions -----------------------------------------------------------------

interface SuggestionView extends Suggestion {
  results: CheckResult[];
  total: number;
  free: number;
  taken: number;
  unknown: number;
  invalid: number;
  settled: boolean;
}

function SuggestionItem({ item, rank }: { item: SuggestionView; rank: number }) {
  const allFree = item.settled && item.free === item.total;
  return (
    <li className={`suggestion ${allFree ? 'suggestion-clear' : ''}`}>
      <span className="suggestion-rank" aria-hidden="true">
        {rank}
      </span>
      <div className="suggestion-body">
        <div className="suggestion-head">
          <span className="suggestion-handle">{item.handle}</span>
          <CopyButton text={item.handle} />
        </div>

        <div className="tally" role="img" aria-label={`${item.free} of ${item.total} places free`}>
          {Array.from({ length: item.total }, (_, i) => {
            const r = item.results[i];
            return <i key={i} className={`tally-cell tally-${r ? r.state : 'pending'}`} />;
          })}
        </div>

        <p className="suggestion-counts">
          {item.settled ? (
            <>
              <strong>
                Free on {item.free} of {item.total}
              </strong>
              {item.taken > 0 ? <span> · {item.taken} taken</span> : null}
              {item.unknown > 0 ? <span> · {item.unknown} unknown</span> : null}
              {item.invalid > 0 ? <span> · {item.invalid} not allowed</span> : null}
            </>
          ) : (
            <span>
              Checking {item.results.length} of {item.total}
            </span>
          )}
        </p>

        {item.settled ? (
          <details className="where">
            <summary>
              <Icon name="chevron" size={14} />
              Where
            </summary>
            <ul className="where-list">
              {item.results.map((r) => (
                <li key={`${r.kind}:${r.id}`}>
                  <a className={`chip chip-${r.state}`} href={r.url} target="_blank" rel="noopener noreferrer" title={r.reason}>
                    <Icon name={STATE_META[r.state].icon} size={14} />
                    <span>{r.name}</span>
                    <span className="sr-only">: {STATE_META[r.state].label} (opens in a new tab)</span>
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </li>
  );
}

// ---- main component --------------------------------------------------------------

const EXAMPLES: { name: string; note: string }[] = [
  { name: 'Ram Sharma', note: 'a personal name' },
  { name: 'abcd', note: 'a brand' },
  { name: 'northwind labs', note: 'two words' },
];

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';

export function Scout() {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ModeChoice>('auto');
  const [scope, setScope] = useState<ScopeChoice>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [run, dispatch] = useReducer(reducer, IDLE);
  const controller = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const start = useCallback(async (rawName: string, modeChoice: ModeChoice, scopeChoice: ScopeChoice) => {
    const query = rawName.trim();
    if (!query) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    dispatch({ type: 'start', query });
    setFilter('all');

    try {
      const url = new URL(window.location.href);
      url.searchParams.set('q', query);
      window.history.replaceState(null, '', url);
    } catch {
      /* history is a nicety */
    }

    try {
      const params = new URLSearchParams({ name: query, mode: modeChoice, only: scopeChoice });
      const res = await fetch(`/api/check?${params}`, { signal: abort.signal, cache: 'no-store' });
      if (!res.ok || !res.body) {
        let message = `The server answered ${res.status}.`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* keep the generic message */
        }
        dispatch({ type: 'fail', message });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as StreamEvent;
          if (event.type === 'export' || event.type === 'error') finished = true;
          dispatch({ type: 'event', event });
        }
      }
      if (!finished && !abort.signal.aborted) {
        dispatch({ type: 'fail', message: 'The connection closed before the check finished. Try again.' });
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      dispatch({
        type: 'fail',
        message: err instanceof Error && err.message ? `Could not reach the server (${err.message}).` : 'Could not reach the server.',
      });
    }
  }, []);

  // Run a shared link (?q=name) on first load.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (q) {
      setName(q);
      void start(q, 'auto', 'all');
    }
    return () => controller.current?.abort();
  }, [start]);

  // ---- derived view models ----
  const domainRows: RowModel[] = useMemo(
    () =>
      (run.plan?.domains ?? []).map((d) => ({
        id: `domain:${d.id}`,
        title: d.handle,
        mono: true,
        result: run.results[`domain:${d.id}`],
      })),
    [run.plan, run.results],
  );
  const platformRows: RowModel[] = useMemo(
    () =>
      (run.plan?.platforms ?? []).map((p) => ({
        id: `platform:${p.id}`,
        title: p.name,
        subtitle: run.results[`platform:${p.id}`]?.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''),
        result: run.results[`platform:${p.id}`],
      })),
    [run.plan, run.results],
  );

  const allRows = useMemo(() => [...domainRows, ...platformRows], [domainRows, platformRows]);
  const counts = useMemo(() => {
    const c = { available: 0, taken: 0, unknown: 0, invalid: 0, pending: 0 };
    for (const row of allRows) c[row.result ? row.result.state : 'pending']++;
    return c;
  }, [allRows]);

  const passes = useCallback(
    (row: RowModel) => {
      if (filter === 'all') return true;
      if (!row.result) return false;
      if (filter === 'taken') return row.result.state === 'taken' || row.result.state === 'invalid';
      return row.result.state === filter;
    },
    [filter],
  );

  const suggestions: SuggestionView[] = useMemo(() => {
    const total = run.suggestionsPlan?.targets.length ?? 0;
    const view = (s: Suggestion, results: CheckResult[], settled: boolean): SuggestionView => ({
      ...s,
      results,
      total: settled ? results.length : total,
      free: results.filter((r) => r.state === 'available').length,
      taken: results.filter((r) => r.state === 'taken').length,
      unknown: results.filter((r) => r.state === 'unknown').length,
      invalid: results.filter((r) => r.state === 'invalid').length,
      settled,
    });
    if (run.report) return run.report.suggestions.map((s) => view(s, s.results, true));
    return (run.suggestionsPlan?.handles ?? []).map((s) => view(s, run.suggestionResults[s.handle] ?? [], false));
  }, [run.report, run.suggestionsPlan, run.suggestionResults]);

  const totalChecks = allRows.length;
  const doneChecks = totalChecks - counts.pending;
  const suggestionTotal = (run.suggestionsPlan?.handles.length ?? 0) * (run.suggestionsPlan?.targets.length ?? 0);
  const suggestionDone = Object.values(run.suggestionResults).reduce((n, list) => n + list.length, 0);
  const overallTotal = totalChecks + suggestionTotal;
  const overallDone = doneChecks + suggestionDone;
  const loading = run.status === 'loading';

  let statusText = '';
  if (loading && !run.plan) statusText = 'Starting…';
  else if (loading && !run.suggestionsPlan) statusText = `Checked ${doneChecks} of ${totalChecks}`;
  else if (loading) statusText = `Ranking alternatives: ${suggestionDone} of ${suggestionTotal}`;
  else if (run.status === 'done' && run.report) statusText = `Finished in ${(run.report.durationMs / 1000).toFixed(1)} s`;
  else if (run.status === 'error') statusText = 'Stopped';

  const hasResults = Boolean(run.plan);
  const nothingTaken = run.status === 'done' && counts.taken + counts.invalid === 0;

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    void start(name, mode, scope);
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  return (
    <>
      <form id="search" className="search" onSubmit={onSubmit} noValidate>
        <div className="field field-name">
          <label className="field-label" htmlFor="name">
            Name to check
          </label>
          <div className="input-wrap">
            <Icon name="search" size={20} />
            <input
              id="name"
              className="input"
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={64}
              placeholder="Ram Sharma, or abcd"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-describedby="name-hint"
            />
          </div>
          <p id="name-hint" className="field-hint">
            Words are joined into one handle: <span className="mono">Ram Sharma</span> is checked as{' '}
            <span className="mono">ramsharma</span>.
          </p>
        </div>

        <div className="search-options">
          <Segmented
            legend="Alternatives for"
            name="mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'auto', label: 'Auto', hint: 'Personal when the name has spaces, otherwise brand' },
              { value: 'personal', label: 'A person', hint: 'iamname, thename, name_surname…' },
              { value: 'brand', label: 'A brand', hint: 'getname, tryname, namehq…' },
            ]}
          />
          <Segmented
            legend="Check"
            name="scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'Everything' },
              { value: 'domains', label: 'Domains' },
              { value: 'socials', label: 'Platforms' },
            ]}
          />
          <button className="btn btn-primary" type="submit" disabled={!name.trim() || loading}>
            {loading ? <Spinner /> : null}
            {loading ? 'Checking' : 'Check name'}
          </button>
        </div>
      </form>

      <div ref={resultsRef} className="results-anchor" />
      <p className="sr-only" role="status" aria-live="polite">
        {run.status === 'done' ? `Check finished. ${counts.available} available, ${counts.taken} taken, ${counts.unknown} unknown.` : ''}
        {run.status === 'error' ? `Check failed. ${run.error ?? ''}` : ''}
      </p>

      {run.status === 'error' ? (
        <div className="notice notice-error" role="alert">
          <Icon name="alert" size={20} />
          <div>
            <strong>The check did not finish.</strong>
            <p>{run.error}</p>
          </div>
          <button type="button" className="btn btn-outline btn-small" onClick={() => void start(run.query, mode, scope)}>
            Try again
          </button>
        </div>
      ) : null}

      {!hasResults && run.status === 'idle' ? (
        <section className="empty" aria-labelledby="empty-title">
          <div className="empty-col">
            <h2 id="empty-title" className="eyebrow">
              Try one
            </h2>
            <ul className="examples">
              {EXAMPLES.map((example) => (
                <li key={example.name}>
                  <button
                    type="button"
                    className="example"
                    onClick={() => {
                      setName(example.name);
                      void start(example.name, mode, scope);
                    }}
                  >
                    <span className="example-name">{example.name}</span>
                    <span className="example-note">{example.note}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="empty-col">
            <h2 className="eyebrow">How to read the results</h2>
            <dl className="legend">
              <div>
                <dt>
                  <StateBadge state="available" />
                </dt>
                <dd>Confirmed free, with a confidence level.</dd>
              </div>
              <div>
                <dt>
                  <StateBadge state="taken" />
                </dt>
                <dd>Confirmed in use.</dd>
              </div>
              <div>
                <dt>
                  <StateBadge state="unknown" />
                </dt>
                <dd>The site blocks scripts. You get the link, not a guess.</dd>
              </div>
              <div>
                <dt>
                  <StateBadge state="invalid" />
                </dt>
                <dd>The name breaks that site&rsquo;s username rules.</dd>
              </div>
            </dl>
          </div>
        </section>
      ) : null}

      {loading && !run.plan ? (
        <div className="starting" aria-hidden="true">
          <Spinner /> Preparing checks for <span className="mono">{run.query}</span>
        </div>
      ) : null}

      {hasResults && run.plan ? (
        <section className="results" aria-busy={loading}>
          <div className="results-bar">
            <div className="results-title">
              <p className="eyebrow">Report</p>
              <h2>
                <span className="mono">{run.plan.handle}</span>
              </h2>
              <p className="results-sub">
                {run.plan.mode === 'personal' ? 'Personal name' : 'Brand name'}
                {statusText ? <> · {statusText}</> : null}
              </p>
            </div>
            <div className="results-actions">
              <button
                type="button"
                className="btn btn-outline btn-small"
                disabled={!run.report}
                onClick={() => run.report && download(`handle-scout-${slug(run.query)}.json`, JSON.stringify(run.report, null, 2), 'application/json')}
              >
                <Icon name="download" size={14} />
                JSON
              </button>
              <button
                type="button"
                className="btn btn-outline btn-small"
                disabled={!run.markdown}
                onClick={() => run.markdown && download(`handle-scout-${slug(run.query)}.md`, run.markdown, 'text/markdown')}
              >
                <Icon name="download" size={14} />
                Markdown
              </button>
            </div>
          </div>

          <div
            className={`progress ${loading ? '' : 'progress-done'}`}
            role="progressbar"
            aria-label="Check progress"
            aria-valuemin={0}
            aria-valuemax={overallTotal || 1}
            aria-valuenow={overallDone}
          >
            <span style={{ width: `${overallTotal ? Math.round((overallDone / overallTotal) * 100) : 0}%` }} />
          </div>

          <Segmented
            legend="Show"
            hideLegend
            name="filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: totalChecks },
              { value: 'available', label: 'Available', count: counts.available },
              { value: 'unknown', label: 'Unknown', count: counts.unknown },
              { value: 'taken', label: 'Taken', count: counts.taken + counts.invalid },
            ]}
          />

          {domainRows.length > 0 ? <Group title="Domains" note={`${run.plan.domains.length} endings for ${run.plan.domainLabel}${providerNote(run.report)}`} rows={domainRows.filter(passes)} filtered={filter !== 'all'} /> : null}

          {platformRows.length > 0 ? <Group title="Platforms" note={`${run.plan.platforms.length} sites for @${run.plan.handle}`} rows={platformRows.filter(passes)} filtered={filter !== 'all'} /> : null}

          <section className="group" aria-labelledby="suggestions-title">
            <header className="group-head">
              <h3 id="suggestions-title">Suggestions</h3>
              <p>
                {suggestions.length > 0
                  ? 'Alternatives, re-checked everywhere and ranked by how many places each is free.'
                  : 'Alternatives that are free in the most places.'}
              </p>
            </header>
            {suggestions.length > 0 ? (
              <>
                <ol className="suggestions">
                  {suggestions.map((item, index) => (
                    <SuggestionItem key={item.handle} item={item} rank={index + 1} />
                  ))}
                </ol>
                {run.suggestionsPlan ? (
                  <p className="group-foot">
                    Each alternative is checked on: {run.suggestionsPlan.targets.map((t) => t.name).join(', ')}. Sites
                    that cannot be checked automatically are left out of the ranking.
                  </p>
                ) : null}
              </>
            ) : loading ? (
              <p className="group-empty">
                <Spinner /> Waiting for the first results before generating alternatives.
              </p>
            ) : nothingTaken ? (
              <p className="group-empty">
                Nothing is confirmed taken, so there is no need for alternatives. Check the Unknown rows by hand before
                you commit.
              </p>
            ) : (
              <p className="group-empty">No alternatives were generated for this run.</p>
            )}
          </section>
        </section>
      ) : null}
    </>
  );
}

function Group({ title, note, rows, filtered }: { title: string; note: string; rows: RowModel[]; filtered: boolean }) {
  const id = `${title.toLowerCase()}-title`;
  return (
    <section className="group" aria-labelledby={id}>
      <header className="group-head">
        <h3 id={id}>{title}</h3>
        <p>{note}</p>
      </header>
      {rows.length > 0 ? (
        <ul className="rows">
          {rows.map((row) => (
            <ResultRow key={row.id} row={row} />
          ))}
        </ul>
      ) : (
        <p className="group-empty">{filtered ? 'Nothing here matches the current filter.' : 'Nothing to show.'}</p>
      )}
    </section>
  );
}
