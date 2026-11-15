#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_TLDS,
  formatPrice,
  PLATFORMS,
  PORKBUN_ENV,
  porkbunFromEnv,
  scout,
  sortResults,
  toJSON,
  toMarkdown,
  verifyPorkbunKeys,
  type CheckResult,
  type Mode,
  type Report,
  type ScoutEvent,
  type State,
} from '@handle-scout/core';

const VERSION = '0.1.0';

const HELP = `handle-scout ${VERSION}
Check one name across domains and platforms, with honest results.

Usage
  handle-scout <name> [more names...] [options]

Examples
  handle-scout abcd
  handle-scout "Ram Sharma" --mode personal
  handle-scout acme globex initech --only domains      (bulk mode)
  handle-scout abcd --json > report.json
  handle-scout abcd --md --out report.md

Options
  --mode <personal|brand>   How to build alternatives. Default: personal when the
                            name has spaces, otherwise brand.
  --only <domains|socials>  Check only domains, or only platforms.
  --tlds <list>             Comma-separated TLDs. Default: ${DEFAULT_TLDS.join(',')}
  --json                    Print the report as JSON (an array when several names).
  --md                      Print the report as Markdown.
  --out <file>              Write the JSON/Markdown output to a file instead of stdout.
  --file <path>             Read names from a file, one per line (bulk mode).
  --no-suggestions          Skip generating and ranking alternatives.
  --suggestions <n>         How many alternatives to re-check and rank. Default: 10.
  --rank-all                Rank alternatives across every automated platform, not
                            only the core ones (slower, more requests).
  --concurrency <n>         Max simultaneous requests. Default: 12.
  --timeout <ms>            Per-check timeout. Default: 10000.
  --retries <n>             Retries after a timeout, HTTP 429 or 5xx. Default: 2.
  --no-registrar            Ignore the Porkbun API key even when one is set.
  --check-keys              Test the Porkbun API key, then exit.
  --list-platforms          Show every platform and how it is checked, then exit.
  --no-color                Disable colours (also honours NO_COLOR).
  -h, --help                Show this help.
  -v, --version             Show the version.

States
  [+] available   confirmed free (see the confidence column)
  [x] taken       confirmed in use
  [?] unknown     the site cannot be checked reliably by a script; open the link
  [-] invalid     the name breaks that platform's username rules

Porkbun API key (optional)
  With a free Porkbun API key, available domains are confirmed by a registrar and
  shown with their price, and .io .co .me .so .sh get a definite answer.
  Put these in a file named .env in the folder you run the command from:
    ${PORKBUN_ENV.apiKey}=pk1_...
    ${PORKBUN_ENV.secretKey}=sk1_...
  The README explains how to create the key.
`;

function fail(message: string): never {
  process.stderr.write(`handle-scout: ${message}\nRun "handle-scout --help" for usage.\n`);
  process.exit(2);
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        mode: { type: 'string' },
        only: { type: 'string' },
        tlds: { type: 'string' },
        json: { type: 'boolean', default: false },
        md: { type: 'boolean', default: false },
        out: { type: 'string' },
        file: { type: 'string' },
        'no-suggestions': { type: 'boolean', default: false },
        suggestions: { type: 'string' },
        'rank-all': { type: 'boolean', default: false },
        concurrency: { type: 'string' },
        timeout: { type: 'string' },
        retries: { type: 'string' },
        'list-platforms': { type: 'boolean', default: false },
        'no-registrar': { type: 'boolean', default: false },
        'check-keys': { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function positiveInt(value: string | undefined, flag: string, min = 1): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) fail(`--${flag} expects a whole number >= ${min}, got "${value}"`);
  return n;
}

// ---- output helpers --------------------------------------------------------------

let useColor = false;
const paint = (code: string) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const c = {
  green: paint('32'),
  red: paint('31'),
  yellow: paint('33'),
  gray: paint('90'),
  bold: paint('1'),
  dim: paint('2'),
};

// Plain ASCII markers plus a word: readable without colour and on any Windows console.
const BADGE: Record<State, { mark: string; label: string; color: (s: string) => string }> = {
  available: { mark: '[+]', label: 'available', color: c.green },
  taken: { mark: '[x]', label: 'taken', color: c.red },
  unknown: { mark: '[?]', label: 'unknown', color: c.yellow },
  invalid: { mark: '[-]', label: 'invalid', color: c.gray },
};

const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - text.length));

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function resultTable(results: CheckResult[], nameHeader: string): string {
  const rows = sortResults(results);
  const nameWidth = Math.max(nameHeader.length, ...rows.map((r) => r.name.length));
  const linkWidth = Math.max(4, ...rows.map((r) => r.url.length));
  // The price column only appears when a registrar priced something.
  const prices = rows.map((r) => formatPrice(r.price));
  const priceWidth = prices.some(Boolean) ? Math.max(5, ...prices.map((p) => p.length)) : 0;
  const priceCell = (text: string) => (priceWidth ? `${pad(text, priceWidth)}  ` : '');
  const out: string[] = [];
  out.push(c.dim(`  ${pad('STATE', 13)}  ${pad(nameHeader, nameWidth)}  ${pad('CONF', 6)}  ${priceCell('PRICE')}${pad('LINK', linkWidth)}`));
  rows.forEach((r, i) => {
    const badge = BADGE[r.state];
    const state = badge.color(pad(`${badge.mark} ${badge.label}`, 13));
    out.push(`  ${state}  ${pad(r.name, nameWidth)}  ${pad(r.confidence ?? '-', 6)}  ${priceCell(prices[i] || '-')}${c.dim(r.url)}`);
    // Explain everything that is not a clean yes/no, and any low-confidence verdict.
    if (
      r.reason &&
      (r.state === 'unknown' || r.state === 'invalid' || r.confidence === 'low' || r.method === 'dns' || r.method === 'registrar')
    ) {
      for (const line of wrap(r.reason, 92)) out.push(c.gray(`  ${' '.repeat(13)}    ${line}`));
    }
  });
  return out.join('\n');
}

function counts(s: { available: number; taken: number; unknown: number; invalid: number }): string {
  const parts = [`${s.available} available`, `${s.taken} taken`, `${s.unknown} unknown`];
  if (s.invalid) parts.push(`${s.invalid} invalid`);
  return parts.join(', ');
}

function renderReport(report: Report): string {
  const out: string[] = [];
  out.push('');
  out.push(c.bold(`${report.input}`) + c.dim(`   mode: ${report.mode}   username: ${report.handle}   domain label: ${report.domainLabel}`));

  if (report.domains.length > 0) {
    out.push('', c.bold('DOMAINS') + c.dim(`   ${counts(report.summary.domains)}`));
    out.push(resultTable(report.domains.map((d) => ({ ...d, name: d.handle })), 'DOMAIN'));
    const p = report.domainProvider;
    if (p && p.confirmed > 0) {
      out.push(c.gray(`  ${p.confirmed} confirmed and priced by ${p.name}. Prices are in US dollars and can change.`));
    }
    if (p?.error) {
      const scope = p.confirmed > 0 ? `${p.failed} could not be confirmed by ${p.name}` : `${p.name} could not be used`;
      for (const line of wrap(`${scope}: ${p.error}`, 96)) out.push(c.yellow(`  ${line}`));
    }
    if (!p && registrarHint) {
      out.push(c.gray('  Tip: add a free Porkbun API key to confirm these with a registrar and see prices. See --help.'));
    }
  }

  if (report.platforms.length > 0) {
    out.push('', c.bold('PLATFORMS') + c.dim(`   ${counts(report.summary.platforms)}`));
    out.push(resultTable(report.platforms, 'PLATFORM'));
  }

  if (report.suggestions.length > 0) {
    out.push('', c.bold('SUGGESTIONS') + c.dim('   ranked by how many places each one is confirmed free'));
    const width = Math.max(6, ...report.suggestions.map((s) => s.handle.length));
    out.push(c.dim(`  ${pad('#', 3)} ${pad('HANDLE', width)}  ${pad('FREE', 7)}  ${pad('TAKEN', 5)}  ${pad('UNKN', 4)}  ${pad('N/A', 3)}  TAKEN OR NOT ALLOWED ON`));
    report.suggestions.forEach((s, i) => {
      const blocked = s.results
        .filter((r) => r.state === 'taken' || r.state === 'invalid')
        .map((r) => (r.state === 'invalid' ? `${r.name} (n/a)` : r.name));
      const free = `${s.freeCount}/${s.total}`;
      const freeText = s.freeCount === s.total ? c.green(pad(free, 7)) : pad(free, 7);
      out.push(
        `  ${pad(String(i + 1), 3)} ${c.bold(pad(s.handle, width))}  ${freeText}  ${pad(String(s.takenCount), 5)}  ${pad(String(s.unknownCount), 4)}  ${pad(String(s.invalidCount), 3)}  ${c.dim(blocked.join(', ') || '-')}`,
      );
    });
    const targets = report.suggestions[0]?.results.map((r) => r.name).join(', ');
    if (targets) for (const line of wrap(`Checked on: ${targets}.`, 96)) out.push(c.gray(`  ${line}`));
  } else if (report.summary.domains.taken + report.summary.platforms.taken === 0) {
    out.push('', c.dim('Nothing is confirmed taken, so no alternatives were generated.'));
  }

  out.push('');
  out.push(
    c.gray(
      '[?] unknown = the site cannot be checked reliably by a script. Open the link to verify by hand.\n' +
        '[+] available is a strong hint, not a guarantee: sites reserve names without saying so.',
    ),
  );
  out.push(c.dim(`Done in ${(report.durationMs / 1000).toFixed(1)}s.`));
  return out.join('\n');
}

function renderBulkSummary(reports: Report[]): string {
  const width = Math.max(4, ...reports.map((r) => r.input.length));
  const out = ['', c.bold('SUMMARY')];
  out.push(c.dim(`  ${pad('NAME', width)}  ${pad('DOMAINS FREE', 12)}  ${pad('PLATFORMS FREE', 14)}  ${pad('UNKNOWN', 7)}  BEST ALTERNATIVE`));
  for (const r of reports) {
    const best = r.suggestions[0];
    out.push(
      `  ${pad(r.input, width)}  ${pad(`${r.summary.domains.available}/${r.domains.length}`, 12)}  ${pad(`${r.summary.platforms.available}/${r.platforms.length}`, 14)}  ${pad(String(r.summary.domains.unknown + r.summary.platforms.unknown), 7)}  ${best ? `${best.handle} (${best.freeCount}/${best.total} free)` : '-'}`,
    );
  }
  return out.join('\n');
}

function listPlatforms(): string {
  const width = Math.max(...PLATFORMS.map((p) => p.name.length));
  const out = [c.bold('PLATFORMS') + c.dim(`   ${PLATFORMS.length} defined`), ''];
  for (const p of PLATFORMS) {
    const how =
      p.detect.type === 'manual'
        ? c.yellow(pad('manual link', 12))
        : p.detect.available
          ? c.green(pad('automatic', 12))
          : c.yellow(pad('taken-only', 12));
    out.push(`  ${pad(p.name, width)}  ${how}  ${pad(p.detect.type === 'manual' ? '-' : p.confidence, 6)}  ${c.dim(p.rules.description)}`);
  }
  out.push('', c.gray('automatic = can report available or taken.  taken-only = can confirm taken, otherwise unknown.'));
  out.push(c.gray('manual link = always unknown; you get the direct link to check by hand.'));
  return out.join('\n');
}

/** Set when domains were checked without a registrar key, to print the one-line tip. */
let registrarHint = false;

/**
 * Load API keys from a .env file: the folder the command is run from first, then the
 * repository root when running from a clone. Variables already set in the shell win.
 */
function loadEnvFiles() {
  const load = (process as { loadEnvFile?: (file: string) => void }).loadEnvFile;
  if (!load) return; // Node older than 20.12: set the variables in the shell instead.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = [path.resolve('.env'), path.resolve(here, '..', '..', '..', '.env')];
  for (const file of new Set(files)) {
    try {
      if (existsSync(file)) load(file);
    } catch {
      /* an unreadable .env is the same as none */
    }
  }
}

async function checkKeys(): Promise<number> {
  const apiKey = process.env[PORKBUN_ENV.apiKey]?.trim();
  const secretKey = process.env[PORKBUN_ENV.secretKey]?.trim();
  if (!apiKey || !secretKey) {
    process.stdout.write(
      `No Porkbun API key found. Set ${PORKBUN_ENV.apiKey} and ${PORKBUN_ENV.secretKey} in a .env file\n` +
        'in this folder, or in your shell. The README explains how to create the key.\n',
    );
    return 1;
  }
  const result = await verifyPorkbunKeys({ apiKey, secretKey });
  if (result.ok) {
    process.stdout.write(`Porkbun API key works${result.scopes.length ? ` (permissions: ${result.scopes.join(', ')})` : ''}.\n`);
    return 0;
  }
  process.stdout.write(`Porkbun API key did not work. ${result.reason}\n`);
  return 1;
}

// ---- main ------------------------------------------------------------------------

async function main() {
  const { values, positionals } = parse();
  useColor = !values['no-color'] && !process.env.NO_COLOR && Boolean(process.stdout.isTTY) && !values.json && !values.md;

  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  if (values['list-platforms']) return void process.stdout.write(`${listPlatforms()}\n`);

  loadEnvFiles();
  if (values['check-keys']) {
    process.exitCode = await checkKeys();
    return;
  }

  const names = [...positionals];
  if (values.file) {
    let text: string;
    try {
      text = await readFile(values.file, 'utf8');
    } catch {
      fail(`cannot read --file "${values.file}"`);
    }
    names.push(...text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  }
  if (names.length === 0) {
    process.stderr.write(HELP);
    process.exit(2);
  }

  if (values.mode && values.mode !== 'personal' && values.mode !== 'brand') {
    fail(`--mode must be "personal" or "brand", got "${values.mode}"`);
  }
  if (values.only && values.only !== 'domains' && values.only !== 'socials') {
    fail(`--only must be "domains" or "socials", got "${values.only}"`);
  }
  if (values.json && values.md) fail('choose one of --json or --md');
  if (values.out && !values.json && !values.md) fail('--out needs --json or --md');

  const tlds = values.tlds
    ?.split(',')
    .map((t) => t.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  if (tlds && tlds.some((t) => !/^[a-z0-9-]+$/.test(t))) fail(`--tlds has an invalid entry: "${values.tlds}"`);

  // One provider for the whole run, so bulk mode shares its batches.
  const domainProvider = values['no-registrar'] ? undefined : porkbunFromEnv();
  registrarHint = !domainProvider && !values['no-registrar'] && values.only !== 'socials';

  const showProgress = Boolean(process.stderr.isTTY);
  const reports: Report[] = [];
  let exitCode = 0;

  for (const name of names) {
    let total = 0;
    let finished = 0;
    const progress = (label: string) => {
      if (showProgress) process.stderr.write(`\r\u001b[2K${label}`);
    };
    const onEvent = (event: ScoutEvent) => {
      if (event.type === 'plan') {
        total = event.domains.length + event.platforms.length;
        progress(`Checking "${event.input}": 0/${total}`);
      } else if (event.type === 'result') {
        progress(`Checking "${name}": ${++finished}/${total}`);
      } else if (event.type === 'suggestions-plan') {
        total = event.handles.length * event.targets.length;
        finished = 0;
        progress(`Ranking ${event.handles.length} alternatives: 0/${total}`);
      } else if (event.type === 'suggestion-result') {
        progress(`Ranking alternatives: ${++finished}/${total}`);
      }
    };

    try {
      const report = await scout(name, {
        mode: (values.mode as Mode | undefined) ?? 'auto',
        only: values.only as 'domains' | 'socials' | undefined,
        tlds,
        suggestions: values['no-suggestions'] ? 'never' : 'auto',
        suggestionLimit: positiveInt(values.suggestions, 'suggestions'),
        rankAcross: values['rank-all'] ? 'all' : 'core',
        concurrency: positiveInt(values.concurrency, 'concurrency'),
        timeoutMs: positiveInt(values.timeout, 'timeout', 100),
        retries: positiveInt(values.retries, 'retries', 0),
        domainProvider,
        onEvent,
      });
      if (showProgress) process.stderr.write('\r\u001b[2K');
      reports.push(report);
      if (!values.json && !values.md) process.stdout.write(`${renderReport(report)}\n`);
    } catch (err) {
      if (showProgress) process.stderr.write('\r\u001b[2K');
      process.stderr.write(`handle-scout: "${name}": ${err instanceof Error ? err.message : String(err)}\n`);
      exitCode = 1;
    }
  }

  if (values.json || values.md) {
    const text = values.json
      ? `${toJSON(reports.length === 1 ? reports[0]! : reports)}\n`
      : reports.map(toMarkdown).join('\n---\n\n');
    if (values.out) {
      await writeFile(values.out, text, 'utf8');
      process.stderr.write(`Wrote ${values.out}\n`);
    } else {
      process.stdout.write(text);
    }
  } else if (reports.length > 1) {
    process.stdout.write(`${renderBulkSummary(reports)}\n`);
  }

  process.exitCode = exitCode;
}

main().catch((err) => {
  process.stderr.write(`handle-scout: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
