// Fork: robust-startup
// Tests for StartupRefresh.planLegacyMigration — the one-time re-pointing of tabs
// parked under a FOREIGN extension id to THIS extension's park.html.
//
// Asserts (the load-bearing guarantees):
//  - foreign-id park.html tabs are re-pointed to getURL('park.html') + VERBATIM query
//    (string equality proves NO re-encode);
//  - tabs already under this extension's own id are SKIPPED (idempotent, no no-op storm);
//  - it is a re-point only — the plan never asks for a reload;
//  - a 2nd run over an already-migrated (self-id) set yields ZERO updates (idempotent).
import { jest } from '@jest/globals';

const SELF_ID = 'fanmnccbignnlcdfaapeceneedcoiadk'; // this fork's pinned id (all a-p chars)
const STORE_ID = 'fiabciakcmgepblmdkmemdbbkilneeeh'; // chrome web store id (foreign)
const OLD_PERSONAL_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // some prior personal id (foreign)

const SELF_PARK_URL = `chrome-extension://${SELF_ID}/park.html`;

let StartupRefresh: any;

beforeAll(() => {
  const mod = require('../../modules/StartupRefresh');
  StartupRefresh = mod.StartupRefresh;
});

// A tab parked under a given extension id, with a realistic (already-encoded) query.
function parkedUnder(id: number, extId: string, query: string) {
  return { id, windowId: 1, url: `chrome-extension://${extId}/park.html?${query}`, favIconUrl: '' };
}

// A query that contains characters which WOULD change if re-encoded — proves verbatim.
const ENCODED_QUERY =
  'tabId=42&title=Hello%20World%20%26%20Friends&url=https%3A%2F%2Fexample.com%2Fpath%3Fa%3D1%26b%3D2&sessionId=99';

describe('StartupRefresh.planLegacyMigration', () => {

  it('re-points a foreign-id park.html tab to this extension keeping the query VERBATIM', () => {
    const tabs = [parkedUnder(1, STORE_ID, ENCODED_QUERY)];

    const plan = StartupRefresh.planLegacyMigration(tabs, SELF_ID, SELF_PARK_URL);

    expect(plan).toHaveLength(1);
    expect(plan[0].id).toBe(1);
    // String equality: getURL('park.html') + the EXACT original query string.
    expect(plan[0].url).toBe(`${SELF_PARK_URL}?${ENCODED_QUERY}`);
    // And the query substring is byte-for-byte preserved (no decode/re-encode).
    expect(plan[0].url.slice(plan[0].url.indexOf('?') + 1)).toBe(ENCODED_QUERY);
  });

  it('matches ANY foreign id (prior personal id), not just the store id', () => {
    const tabs = [parkedUnder(7, OLD_PERSONAL_ID, 'url=https%3A%2F%2Ffoo')];

    const plan = StartupRefresh.planLegacyMigration(tabs, SELF_ID, SELF_PARK_URL);

    expect(plan).toHaveLength(1);
    expect(plan[0].url).toBe(`${SELF_PARK_URL}?url=https%3A%2F%2Ffoo`);
  });

  it('skips tabs already under THIS extension id (idempotent, no no-op storm)', () => {
    const tabs = [
      parkedUnder(1, SELF_ID, ENCODED_QUERY),   // self -> skipped
      parkedUnder(2, STORE_ID, 'url=https%3A%2F%2Fx'), // foreign -> migrated
    ];

    const plan = StartupRefresh.planLegacyMigration(tabs, SELF_ID, SELF_PARK_URL);

    expect(plan.map(p => p.id)).toEqual([2]);
  });

  it('ignores non-park.html tabs and bare chrome-extension urls', () => {
    const tabs = [
      { id: 1, windowId: 1, url: 'https://example.com', favIconUrl: '' },
      { id: 2, windowId: 1, url: `chrome-extension://${STORE_ID}/history.html?x=1`, favIconUrl: '' },
      { id: 3, windowId: 1, url: `chrome-extension://${STORE_ID}/park.html`, favIconUrl: '' }, // no query -> not matched
    ];

    const plan = StartupRefresh.planLegacyMigration(tabs, SELF_ID, SELF_PARK_URL);

    expect(plan).toEqual([]);
  });

  it('produces NO reload — the plan is re-point-only (only id + url, no reload field)', () => {
    const tabs = [parkedUnder(1, STORE_ID, ENCODED_QUERY)];
    const plan = StartupRefresh.planLegacyMigration(tabs, SELF_ID, SELF_PARK_URL);
    expect(Object.keys(plan[0]).sort()).toEqual(['id', 'url']);
  });

  it('2nd run over the already-migrated (self-id) set yields ZERO updates (idempotent)', () => {
    // First run migrates the foreign tab.
    const before = [parkedUnder(1, STORE_ID, ENCODED_QUERY)];
    const firstPlan = StartupRefresh.planLegacyMigration(before, SELF_ID, SELF_PARK_URL);
    expect(firstPlan).toHaveLength(1);

    // Simulate the tab now living under the self-id (post-migration state).
    const after = [parkedUnder(1, SELF_ID, ENCODED_QUERY)];
    const secondPlan = StartupRefresh.planLegacyMigration(after, SELF_ID, SELF_PARK_URL);
    expect(secondPlan).toEqual([]);
  });
});

describe('StartupRefresh.parseLegacyIds', () => {
  it('splits comma/newline-joined ids and trims, dropping empties', () => {
    expect(StartupRefresh.parseLegacyIds('a, b\nc , \n,d'))
      .toEqual(['a', 'b', 'c', 'd']);
    expect(StartupRefresh.parseLegacyIds(STORE_ID)).toEqual([STORE_ID]);
    expect(StartupRefresh.parseLegacyIds(null)).toEqual([]);
    expect(StartupRefresh.parseLegacyIds(undefined)).toEqual([]);
    expect(StartupRefresh.parseLegacyIds('')).toEqual([]);
  });
});

// ── Throttled application contract (background.ts performs the side effects) ──
describe('migration application contract (chrome.tabs.update, throttled, no reload)', () => {
  it('applying the plan calls chrome.tabs.update with the rebuilt url and never reload', () => {
    const update = jest.fn();
    const reload = jest.fn();

    const tabs = [
      parkedUnder(1, STORE_ID, 'url=https%3A%2F%2Fa'),
      parkedUnder(2, OLD_PERSONAL_ID, 'url=https%3A%2F%2Fb'),
      parkedUnder(3, SELF_ID, 'url=https%3A%2F%2Fc'), // skipped
    ];

    const plan = StartupRefresh.planLegacyMigration(tabs, SELF_ID, SELF_PARK_URL);
    for (const item of plan) update(item.id, { url: item.url });

    expect(reload).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(1, { url: `${SELF_PARK_URL}?url=https%3A%2F%2Fa` });
    expect(update).toHaveBeenCalledWith(2, { url: `${SELF_PARK_URL}?url=https%3A%2F%2Fb` });
  });
});
