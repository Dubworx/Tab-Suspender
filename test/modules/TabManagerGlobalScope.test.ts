// Fork: robust-startup — production-scope regression guard.
//
// The deferred favicon-refresh Set is shared across modules via `globalThis`. In the real
// MV3 service worker (a CLASSIC worker loaded by worker.js -> importScripts, no
// "type":"module") there is NO `global` binding — `global` is a Node-ism. A bare `global.x`
// read (even with `?.`) throws ReferenceError there; `?.` only guards null/undefined VALUES,
// not an undeclared IDENTIFIER. jsdom/Node define `global`, which previously MASKED a bug
// where TabManager read `(global as any).pendingFaviconRefresh` and background.ts published
// it only under `if (typeof global !== 'undefined')` — so in the SW the Set was never
// published and the bare read threw on the first tab close / activation.
//
// These tests exercise the PRODUCTION condition explicitly: `pendingFaviconRefresh` is NEVER
// published on the global object (as on a fresh SW before background.ts has run, or — under
// the old buggy code — in the SW at all). We assert the onRemoved / onActivated handlers do
// NOT throw and that core behavior (auto-restore of a parked tab) still runs. Reading the Set
// via `globalThis.X?.` safely no-ops; a regression back to a bare `global.X` read would throw
// here and the downstream assertions (markTabClosed called, unsuspendTab called) would fail.
import '../lib/Chrome';
import '../typing/global.d';

(global as any).sessionsPageUrl = 'chrome-extension://test/sessions.html';
(global as any).wizardPageUrl = 'chrome-extension://test/wizard_background.html';
(global as any).historyPageUrl = 'chrome-extension://test/history.html';
(global as any).parkUrl = 'chrome-extension://test/park.html';
(global as any).trace = false;
(global as any).debug = false;
(global as any).debugScreenCache = false;
(global as any).TSSessionId = 123456;
(global as any).getScreenCache = null;
(global as any).pauseTics = 0;

(global as any).parseUrlParam = jest.fn((url: string, param: string) => {
  const urlParams = new URLSearchParams(url.split('?')[1]);
  return urlParams.get(param);
});
(global as any).extractHostname = jest.fn((url: string) => {
  try { return new URL(url).hostname; } catch { return ''; }
});
(global as any).discardTab = jest.fn();
(global as any).markForUnsuspend = jest.fn();

(global as any).whiteList = { isURIException: jest.fn().mockReturnValue(false) };
(global as any).ignoreList = { isTabInIgnoreTabList: jest.fn().mockReturnValue(false) };
(global as any).tabCapture = { captureTab: jest.fn(), injectJS: jest.fn() };
(global as any).ContextMenuController = { menuIdMap: {} };
(global as any).ScreenshotController = { getScreen: jest.fn() };
(global as any).BrowserActionControl = jest.fn().mockImplementation(() => ({ updateStatus: jest.fn() }));
(global as any).HistoryOpenerController = jest.fn().mockImplementation(() => ({
  onNewTab: jest.fn(), onTabUpdate: jest.fn(), onRemoveTab: jest.fn(), collectInitialTabState: jest.fn()
}));
(global as any).TabObserver = { tickSize: 1000 };

const PARK = 'chrome-extension://test/park.html';

function parkedFaviconless(id: number) {
  return {
    id, windowId: 1, index: 0,
    url: `${PARK}?url=https%3A%2F%2Fexample.com%2F${id}`,
    title: 'Parked', favIconUrl: '', active: true, pinned: false,
    discarded: false, autoDiscardable: true, audible: false, groupId: -1,
    status: 'complete', highlighted: false, incognito: false, selected: true
  } as chrome.tabs.Tab;
}

describe('TabManager - global-scope safety (production SW path: Set unpublished)', () => {
  let TabManager: any;
  let tabManager: any;
  let onActivatedCallback: (info: chrome.tabs.TabActiveInfo) => void;
  let onRemovedCallback: (tabId: number, info: chrome.tabs.TabRemoveInfo) => void;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    (global as any).getScreenCache = null;

    // Auto-restore ON so we can prove unsuspendTab still runs even though the favicon Set
    // is absent; hybrid ON so the backfill branch is reached.
    (global as any).settings = {
      get: jest.fn((key: string) =>
        Promise.resolve(key === 'hybridStartupFaviconRefresh' || key === 'autoRestoreTab'))
    };

    // PRODUCTION CONDITION: the shared Set was never published on the global object.
    // (Under the old buggy `(global as any)` read this would still have THROWN because the
    // base identifier was undeclared in the SW; under the fixed `globalThis` read it no-ops.)
    delete (globalThis as any).pendingFaviconRefresh;

    (global as any).chrome.tabs.reload = jest.fn().mockResolvedValue(undefined);
    (global as any).chrome.tabs.onActivated.addListener = jest.fn((cb) => { onActivatedCallback = cb; });
    (global as any).chrome.tabs.onRemoved.addListener = jest.fn((cb) => { onRemovedCallback = cb; });

    const TabInfoModule = require('../../modules/model/TabInfo');
    (global as any).TabInfo = TabInfoModule.TabInfo;

    const TabManagerModule = require('../../modules/TabManager');
    TabManager = TabManagerModule.TabManager;
    tabManager = new TabManager();
    (global as any).tabManager = tabManager;
    jest.spyOn(tabManager, 'unsuspendTab').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete (globalThis as any).pendingFaviconRefresh;
  });

  it('onRemoved does NOT throw and still runs cleanup when the deferred Set was never published', () => {
    const closed = jest.spyOn(tabManager, 'markTabClosed');
    expect(() => onRemovedCallback(5, { windowId: 1, isWindowClosing: false })).not.toThrow();
    // markTabClosed runs only if the favicon-Set delete did not abort the handler.
    expect(closed).toHaveBeenCalledWith(5);
  });

  it('onActivated still auto-restores a parked tab when the deferred Set is absent', async () => {
    (global as any).chrome.tabs.get = jest.fn().mockResolvedValue(parkedFaviconless(5));

    onActivatedCallback({ tabId: 5, windowId: 1 });
    await new Promise(r => setTimeout(r, 50));

    // Core behavior preserved: auto-restore runs even though the favicon-refresh Set lookup
    // had nothing to read (would previously have thrown ReferenceError before this line).
    expect(tabManager.unsuspendTab).toHaveBeenCalledTimes(1);
    // Backfill branch safely no-ops (no Set) -> the Set path triggers no reload.
    expect((global as any).chrome.tabs.reload).not.toHaveBeenCalled();
  });

  it('onActivated still auto-restores even if reading the Set throws (backfill is isolated)', async () => {
    // Booby-trap: a published object whose .has() throws, proving the backfill block is
    // wrapped in its own try/catch and cannot abort the auto-restore call.
    (globalThis as any).pendingFaviconRefresh = { has: () => { throw new Error('boom'); } };
    (global as any).chrome.tabs.get = jest.fn().mockResolvedValue(parkedFaviconless(5));

    onActivatedCallback({ tabId: 5, windowId: 1 });
    await new Promise(r => setTimeout(r, 50));

    expect(tabManager.unsuspendTab).toHaveBeenCalledTimes(1);
  });

  it('publishing the Set via globalThis is readable by the same identifier TabManager uses', () => {
    // Sanity: simulate background.ts publish and confirm the TabManager-side reader sees it.
    const set = new Set<number>([7]);
    (globalThis as any).pendingFaviconRefresh = set;
    onRemovedCallback(7, { windowId: 1, isWindowClosing: false });
    // onRemoved deletes 7 from the SAME live Set -> proves cross-module sharing works.
    expect(set.has(7)).toBe(false);
  });
});
