import type { CheckResult, DomainPrice, Report, State } from './types.js';

export const STATE_LABEL: Record<State, string> = {
  available: 'Available',
  taken: 'Taken',
  unknown: 'Unknown - check by hand',
  invalid: 'Not allowed',
};

/** Order used when listing results: free first, then needs-a-look, then the rest. */
export const STATE_ORDER: Record<State, number> = { available: 0, unknown: 1, taken: 2, invalid: 3 };

export function sortResults(results: CheckResult[]): CheckResult[] {
  return [...results].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
}

/** `$9.73/yr`, `$1.50 first year, then $48.00/yr`, with `premium` in front when it applies. */
export function formatPrice(price: DomainPrice | undefined): string {
  if (!price) return '';
  const renewal = price.renewal ?? price.regular;
  const text =
    renewal && renewal !== price.registration
      ? `$${price.registration} first year, then $${renewal}/yr`
      : `$${price.registration}/yr`;
  return price.premium ? `premium, ${text}` : text;
}

export function toJSON(report: Report | Report[]): string {
  return JSON.stringify(report, null, 2);
}

const cell = (text: string | undefined) => (text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function table(results: CheckResult[], firstColumn: string, showHandle: boolean): string {
  const showPrice = results.some((r) => r.price);
  const lines = [
    `| ${firstColumn} | ${showHandle ? 'Checked | ' : ''}State | Confidence | ${showPrice ? 'Price | ' : ''}Link | Notes |`,
    `| --- | ${showHandle ? '--- | ' : ''}--- | --- | ${showPrice ? '--- | ' : ''}--- | --- |`,
  ];
  for (const r of sortResults(results)) {
    const handle = showHandle ? `\`${cell(r.handle)}\` | ` : '';
    const price = showPrice ? `${cell(formatPrice(r.price)) || '-'} | ` : '';
    const notes = [r.reason, r.providerError].filter(Boolean).join(' ');
    lines.push(
      `| ${cell(r.name)} | ${handle}${STATE_LABEL[r.state]} | ${r.confidence ?? '-'} | ${price}[open](${r.url}) | ${cell(notes)} |`,
    );
  }
  return lines.join('\n');
}

/** Render a report as a self-contained Markdown document. */
export function toMarkdown(report: Report): string {
  const out: string[] = [];
  out.push(`# handle-scout report: ${report.input}`);
  out.push('');
  out.push(`- Mode: ${report.mode}`);
  out.push(`- Username checked: \`${report.handle}\``);
  out.push(`- Domain label checked: \`${report.domainLabel}\``);
  out.push(`- Generated: ${report.generatedAt}`);
  out.push('');
  out.push(
    '> "Unknown" means the site could not be checked reliably by a script. Follow the link to verify by hand. ' +
      '"Available" is a strong hint, not a guarantee: sites reserve names and block look-alikes without saying so.',
  );

  if (report.domains.length > 0) {
    const s = report.summary.domains;
    out.push('', '## Domains', '', `${s.available} available, ${s.taken} taken, ${s.unknown} unknown.`, '');
    const p = report.domainProvider;
    if (p) {
      out.push(
        p.confirmed > 0
          ? `${p.confirmed} confirmed and priced by ${p.name}. Prices are in US dollars and can change.`
          : p.error
            ? `${p.name} could not be used: ${p.error}`
            : `${p.name} was not needed: every domain already has a registration record.`,
        '',
      );
    }
    out.push(table(report.domains, 'TLD', true));
  }

  if (report.platforms.length > 0) {
    const s = report.summary.platforms;
    out.push(
      '',
      '## Platforms',
      '',
      `${s.available} available, ${s.taken} taken, ${s.unknown} unknown, ${s.invalid} not allowed by the platform's rules.`,
      '',
    );
    out.push(table(report.platforms, 'Platform', false));
  }

  if (report.suggestions.length > 0) {
    out.push('', '## Suggestions', '', 'Ranked by the number of places each alternative is confirmed free.', '');
    out.push('| Rank | Handle | Free | Taken | Unknown | Not allowed | Free on | Taken on |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    report.suggestions.forEach((s, i) => {
      const names = (state: State) =>
        s.results
          .filter((r) => r.state === state)
          .map((r) => r.name)
          .join(', ') || '-';
      out.push(
        `| ${i + 1} | \`${s.handle}\` | ${s.freeCount}/${s.total} | ${s.takenCount} | ${s.unknownCount} | ${s.invalidCount} | ${cell(names('available'))} | ${cell(names('taken'))} |`,
      );
    });
  }

  out.push('');
  return out.join('\n');
}
