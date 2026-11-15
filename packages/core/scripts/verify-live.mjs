#!/usr/bin/env node
// Live honesty check for platform detectors.
//
// For every platform it checks a handle that is known to be taken (`probe.taken`)
// and a freshly generated random string that is almost certainly free, then prints
// what the detector said. A detector PASSES only if it says "taken" for the first
// and "available" for the second. Anything else means the definition must be fixed
// or downgraded to `type: 'manual'`.
//
//   npm run verify:platforms              # all platforms
//   npm run verify:platforms -- github x  # only these ids
import { checkPlatform, PLATFORMS } from '../dist/index.js';

const only = process.argv.slice(2);
const targets = PLATFORMS.filter((p) => only.length === 0 || only.includes(p.id));

function randomHandle(platform) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const length = Math.min(13, platform.rules.maxLength);
  let out = 'q';
  while (out.length < length) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const rows = await Promise.all(
  targets.map(async (platform) => {
    if (platform.detect.type === 'manual') {
      return { platform, verdict: 'MANUAL', detail: 'no automated check (reports unknown + link)' };
    }
    const takenHandle = platform.probe?.taken ?? 'google';
    const freeHandle = randomHandle(platform);
    const taken = await checkPlatform(platform, takenHandle, { retries: 1 });
    const free = await checkPlatform(platform, freeHandle, { retries: 1 });
    const takenOnly = !platform.detect.available;
    let verdict = 'FAIL';
    if (taken.state === 'taken' && free.state === 'available') verdict = 'PASS';
    else if (takenOnly && taken.state === 'taken' && free.state === 'unknown') verdict = 'PASS (taken-only)';
    else if (taken.state === 'unknown' && free.state === 'unknown') verdict = 'BLOCKED';
    else if (taken.state === 'unknown' || free.state === 'unknown') verdict = 'PARTIAL';
    const why = verdict.startsWith('PASS') ? '' : ` | ${taken.reason ?? ''} | ${free.reason ?? ''}`;
    return {
      platform,
      verdict,
      detail: `${takenHandle} -> ${taken.state}; ${freeHandle} -> ${free.state}${why}`,
    };
  }),
);

for (const { platform, verdict, detail } of rows) {
  console.log(`${verdict.padEnd(18)} ${platform.id.padEnd(18)} ${detail}`);
}
const count = (test) => rows.filter((r) => test(r.verdict)).length;
const wrong = count((v) => v === 'FAIL');
console.log(
  `\n${count((v) => v.startsWith('PASS'))} pass, ${count((v) => v === 'MANUAL')} manual, ` +
    `${count((v) => v === 'BLOCKED' || v === 'PARTIAL')} blocked/partial, ${wrong} fail`,
);
// FAIL = the detector gave a confident wrong answer. That is the one thing that must never ship.
process.exit(wrong > 0 ? 1 : 0);
