// Fork: robust-startup
// TabManager lazy favicon backfill drain:
//  - a parked+faviconless tab whose id is in the deferred pendingFaviconRefresh Set,
//    when ACTIVATED, is reloaded exactly once and removed from the Set;
//  - onRemoved drops a tab id from the Set.
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

describe('TabManager - lazy favicon backfill drain', () => {
  let TabManager: any;
  let tabManager: any;
  let onActivatedCallback: (info: chrome.tabs.TabActiveInfo) => void;
  let onRemovedCallback: (tabId: number, info: chrome.tabs.TabRemoveInfo) => void;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    (global as any).getScreenCache = null;

    // settings: hybrid ON, everything else false (no autoRestore / animate).
    (global as any).settings = {
      get: jest.fn((key: string) =>
        Promise.resolve(key === 'hybridStartupFaviconRefresh' ? true : false))
    };

    // Fresh deferred set seeded with our background-window tab id.
    (global as any).pendingFaviconRefresh = new Set<number>([5]);

    (global as any).chrome.tabs.reload = jest.fn().mockResolvedValue(undefined);

    // Capture the activation/removal listeners.
    (global as any).chrome.tabs.onActivated.addListener = jest.fn((cb) => { onActivatedCallback = cb; });
    (global as any).chrome.tabs.onRemoved.addListener = jest.fn((cb) => { onRemovedCallback = cb; });

    const TabInfoModule = require('../../modules/model/TabInfo');
    (global as any).TabInfo = TabInfoModule.TabInfo;

    const TabManagerModule = require('../../modules/TabManager');
    TabManager = TabManagerModule.TabManager;
    tabManager = new TabManager();
    (global as any).tabManager = tabManager;
  });

  it('reloads a seeded parked faviconless tab once on activation and removes it from the Set', async () => {
    (global as any).chrome.tabs.get = jest.fn().mockResolvedValue(parkedFaviconless(5));

    onActivatedCallback({ tabId: 5, windowId: 1 });

    // allow the processedPromise.then() microtasks + awaited settings.get to settle
    await new Promise(r => setTimeout(r, 50));

    expect((global as any).chrome.tabs.reload).toHaveBeenCalledTimes(1);
    expect((global as any).chrome.tabs.reload).toHaveBeenCalledWith(5);
    expect((global as any).pendingFaviconRefresh.has(5)).toBe(false);
  });

  it('does NOT reload a parked tab whose id is not in the deferred Set', async () => {
    (global as any).pendingFaviconRefresh = new Set<number>([999]); // 5 not present
    (global as any).chrome.tabs.get = jest.fn().mockResolvedValue(parkedFaviconless(5));

    onActivatedCallback({ tabId: 5, windowId: 1 });
    await new Promise(r => setTimeout(r, 50));

    expect((global as any).chrome.tabs.reload).not.toHaveBeenCalled();
    expect((global as any).pendingFaviconRefresh.has(999)).toBe(true);
  });

  it('does NOT reload when the activated parked tab already has a favicon', async () => {
    const tabWithIcon = { ...parkedFaviconless(5), favIconUrl: 'https://x/fav.ico' };
    (global as any).chrome.tabs.get = jest.fn().mockResolvedValue(tabWithIcon);

    onActivatedCallback({ tabId: 5, windowId: 1 });
    await new Promise(r => setTimeout(r, 50));

    expect((global as any).chrome.tabs.reload).not.toHaveBeenCalled();
    // Not reloaded -> id stays for a later backfill pass.
    expect((global as any).pendingFaviconRefresh.has(5)).toBe(true);
  });

  it('onRemoved drops the tab id from the deferred Set', () => {
    expect((global as any).pendingFaviconRefresh.has(5)).toBe(true);
    onRemovedCallback(5, { windowId: 1, isWindowClosing: false });
    expect((global as any).pendingFaviconRefresh.has(5)).toBe(false);
  });
});
