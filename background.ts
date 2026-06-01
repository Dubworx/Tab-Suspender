/*
 * Copyright (c) 2015 Sergey Zadorozhniy. The content presented herein may not, under any circumstances,
 * be reproduced in whole or in any part or form without written permission from Sergey Zadorozhniy.
 * Zadorozhniy.Sergey@gmail.com
 */
'use strict';

const Copyright = 'Copyright (c) 2015 Sergey Zadorozhniy. The content presented herein may not, under any circumstances, be reproduced in whole or in any part or form without written permission from Sergey Zadorozhniy. Zadorozhniy.Sergey@gmail.com';
const TS_SESSION_ID_KEY = 'TSSessionId';

const TSSessionId = Date.now();
let previousTSSessionId;


// Globals
const parkUrl = chrome.runtime.getURL('park.html');


// eslint-disable-next-line @typescript-eslint/no-unused-vars
const historyPageUrl = chrome.runtime.getURL('history.html');

// @ts-ignore
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let database: DBProvider;
let parkHistory = [];
let closeHistory = [];
//window.tabScreens = {}; // map of tabIDs with last 'screen'
let settings: SettingsStore;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
let pauseTics = 0;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let pauseTicsStartedFrom = 0;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let isCharging = true;
let startedAt = new Date().getTime();
const firstTimeTabDiscardMap = {};

/*
 * Fork: robust-startup
 * Set of parked+faviconless tab ids that were NOT eagerly reloaded at startup
 * (background windows under hybrid 'activeWindow' scope). They are backfilled
 * lazily — either on activation (TabManager.onActivated) or via the offscreen
 * paced backfill queue. Exposed via globalThis so TabManager / offscreen handler can read it.
 *
 * NOTE: must use `globalThis` (NOT `global`). The MV3 service worker is a classic worker
 * (worker.js -> importScripts, no "type":"module"); there is NO `global` binding there —
 * `global` is a Node-ism. `globalThis` is defined in the SW, in jsdom, and in Node, so the
 * Set is published in production and the three readers (here, TabManager, BGMessageListener)
 * all operate on the SAME live Set. Publish unconditionally — no `typeof` guard needed.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const pendingFaviconRefresh = new Set<number>();
(globalThis as any).pendingFaviconRefresh = pendingFaviconRefresh;

let whiteList: WhiteList;
const offscreenDocumentProvider = new OffscreenDocumentProvider();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let windowManger: WindowManager;
let tabManager: TabManager;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let tabObserver: TabObserver;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let tabCapture: TabCapture;
let contextMenuController: ContextMenuController;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let formRestoreController: PageStateRestoreController;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let settingsPageController: SettingsPageController;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let ignoreList: IgnoreList;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let bgMessageListener: BGMessageListener;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const tabsMarkedForUnsuspend = [];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TABS_MARKED_FOR_UNSUSPEND_TTL = 5000;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let batteryLevel = -1.0;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let getScreenCache = null;
// Track Ctrl+Click (Cmd+Click on Mac) for suspending next tab
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let nextTabShouldBeSuspended = false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const NEXT_TAB_SUSPEND_TTL = 3000; // 3 seconds to create tab after Ctrl/Cmd+click
// eslint-disable-next-line prefer-const

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const openSuspendedHistory = () =>
	focusOrOpenTSPage(chrome.runtime.getURL('history.html'));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const openClosedHistory = () =>
	focusOrOpenTSPage(chrome.runtime.getURL('history.html') + '#closed');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getRestoreEvent = async function() {
	return (await settings.get('restoreOnMouseHover') == true ? 'hover' : 'click');
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getReloadTabOnRestore = (): Promise<boolean> =>
	settings.get('reloadTabOnRestore');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getTabIconStatusVisualize = (): Promise<boolean> =>
	settings.get('tabIconStatusVisualize');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getTabIconOpacityChange = (): Promise<boolean> =>
	settings.get('tabIconOpacityChange');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getRestoreButtonView = (): Promise<string> =>
	settings.get('restoreButtonView');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getScreenshotCssStyle = (): Promise<string> =>
	settings.get('screenshotCssStyle');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getStartDiscarted = function(): Promise<boolean> {
	return settings.get('startDiscarted');
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const isFirstTimeTabDiscard = function(tabId) {
	const isFirstTime = !(tabId in firstTimeTabDiscardMap);
	firstTimeTabDiscardMap[tabId] = true;
	return isFirstTime;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getParkBgColor = async function(): Promise<string> {
	const color = await settings.get('parkBgColor');
	if (color != null && color.search(/^([A-Fa-f0-9]{8}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/) >= 0)
		return color;
	else
		return DEFAULT_SETTINGS.parkBgColor;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getStartedAt = async function() {
	return startedAt;
};

chrome.notifications.onClicked.addListener(function(id) {
	chrome.notifications.clear(id);
});

chrome.runtime.setUninstallURL('https://uninstall.tab-suspender.com/', null);

/*
 * STARTUP/UPDATE
 */


// init function
/**
 *
 */
async function init(options) {
	'use strict';

	console.log('Started at ' + new Date());

	contextMenuController.create(parkUrl);

	whiteList = new WhiteList(settings);

	tabManager.init(options);

	/* Restore parkHistory */
	try {
		parkHistory = await LocalStore.get(LocalStoreKeys.PARK_HISTORY);
		if (!Array.isArray(parkHistory))
			parkHistory = [];
	} catch (e) {
		console.error('Exception while restore previous parkHistory:', e);
	}

	/* Restore closeHistory */
	try {
		closeHistory = await LocalStore.get(LocalStoreKeys.CLOSE_HISTORY);
		if (!Array.isArray(closeHistory))
			closeHistory = [];
	} catch (e) {
		console.error('Exception while restore previous closeHistory:', e);
	}
}

/**
 *
 */
chrome.runtime.onUpdateAvailable.addListener(function(details) {
	console.log('Update available.. ' + (details ? details.version : 'no version info.'));
});

/**
 *
 */
chrome.runtime.onInstalled.addListener(function(details) {

	if (debug)
		console.log('Installed at ' + new Date().getTime());

	if (details.reason == 'install') {
		if (debug)
			console.log('This is a first install!');
		// Fork: re-point any tabs parked under a foreign (prior) extension id to this id.
		void migrateLegacyParkedTabs();
	} else if (details.reason == 'update') {
		const thisVersion = chrome.runtime.getManifest().version;
		console.log('Updated from ' + details.previousVersion + ' to ' + thisVersion + '!'); /* Updated from 0.4.8.3 to 0.4.8.4! */


		/************* PATCHES: ********************************
		 * TODO: remove this variable after migration complete!!!
		 *******************************************************/
		/* PATCH #1 */
		/*if (versionCompare(details.previousVersion, '0.4.8.2') < 0)
			restoreTabOnStartup_TemporarlyEnabel = true;*/

		//settings.getOnStorageInitialized().then(async function() {
		/* PATCH #2 */
		/*if (versionCompare(details.previousVersion, '1.3.2.3') < 0) {
			console.log('Disabling "animateTabIconSuspendTimeout" for versions less then 1.3.2.3...');
			settings.set('animateTabIconSuspendTimeout', false);
		}
		/!* PATCH #3 *!/
		if (versionCompare(details.previousVersion, '1.3.2.4') < 0) {
			if (await settings.get('screenshotQuality') == 100)
				settings.set('screenshotQuality', 90);
		}*/
		//}, console.error);

		// Fork: re-point any tabs parked under a foreign (prior) extension id to this id.
		void migrateLegacyParkedTabs();
	}
});

/*
 * Fork: robust-startup — resume an interrupted migration on SW restart.
 * onInstalled fires only on install/update, NOT when the service worker is woken back up.
 * If the migration loop was interrupted (SW evicted / browser quit mid-loop), the done-flag
 * was deliberately left unset (see migrateLegacyParkedTabs). onStartup re-runs migration,
 * which re-derives remaining work from a fresh chrome.tabs.query and no-ops once the flag is
 * set, so this is idempotent and closes the partial-migration gap.
 */
chrome.runtime.onStartup.addListener(function() {
	void migrateLegacyParkedTabs();
});

/*
 * Fork: robust-startup — one-time migration of tabs parked under a FOREIGN extension id.
 *
 * When the build's extension id changes (e.g. store id -> pinned personal fork id, or a
 * prior personal id), every existing parked tab still points at the old id's park.html and
 * becomes a dead chrome-extension:// page. This re-points any such tab to THIS extension's
 * park.html, preserving the query string VERBATIM (no re-encode). It does NOT reload tabs
 * (chrome.tabs.update with a new url already navigates) and skips this extension's own id
 * (idempotent — avoids a no-op update storm). Runs once, guarded by a storage flag.
 *
 * The foreign-id detection + verbatim url rebuild lives in StartupRefresh.planLegacyMigration
 * (pure + unit-tested). This function only performs the throttled side effects.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function migrateLegacyParkedTabs() {
	try {
		// settings may not be initialised yet on a fresh onInstalled; guard defensively.
		if (typeof settings === 'undefined' || settings == null)
			await new Promise(r => setTimeout(r, 1500));

		if (typeof settings !== 'undefined' && settings != null) {
			await settings.getOnStorageInitialized();
			if (!await settings.get('enableParkedTabIdMigration')) {
				console.log('[ParkedTabMigration] Disabled by settings, skipping.');
				return;
			}
		}

		const MIGRATION_DONE_KEY = 'parkedTabIdMigrationDone';
		const stored = await chrome.storage.local.get([MIGRATION_DONE_KEY]);
		if (stored && stored[MIGRATION_DONE_KEY]) {
			console.log('[ParkedTabMigration] Already done, skipping.');
			return;
		}

		const selfId = chrome.runtime.id;

		// Build the configured legacy-id allowlist (informational; the foreign-id regex is
		// the real mechanism and covers prior personal ids too).
		let legacyIds: string[] = [];
		if (typeof settings !== 'undefined' && settings != null) {
			const raw = await settings.get('parkedTabMigrationLegacyIds');
			legacyIds = StartupRefresh.parseLegacyIds(raw);
		}
		if (legacyIds.length === 0)
			legacyIds = ['fiabciakcmgepblmdkmemdbbkilneeeh'];

		const allTabs = await chrome.tabs.query({});

		// Re-point tabs parked under a FOREIGN id (captured id !== this id); query VERBATIM.
		const toMigrate = StartupRefresh.planLegacyMigration(
			allTabs as unknown as { id: number, url: string, windowId: number, favIconUrl?: string }[],
			selfId,
			chrome.runtime.getURL('park.html')
		);

		console.log(`[ParkedTabMigration] selfId=${selfId}, allowlist=[${legacyIds.join(',')}], foreign parked tabs=${toMigrate.length}`);

		// Throttle: batch by lazyFaviconRefreshConcurrency every lazyRefreshDelayMs.
		let batch = 3;
		let delayMs = 250;
		if (typeof settings !== 'undefined' && settings != null) {
			batch = await settings.get('lazyFaviconRefreshConcurrency');
			delayMs = await settings.get('lazyRefreshDelayMs');
		}

		for (let i = 0; i < toMigrate.length; i += batch) {
			const slice = toMigrate.slice(i, i + batch);
			for (const item of slice) {
				// item.url is already this extension's park.html + the VERBATIM query.
				chrome.tabs.update(item.id, { url: item.url }).catch(console.error);
			}
			if (i + batch < toMigrate.length)
				await new Promise(r => setTimeout(r, delayMs));
		}

		/*
		 * Fork: robust-startup — make migration CRASH-RESUMABLE.
		 * The throttled loop above can run for tens of seconds with a large session; if the
		 * MV3 service worker is evicted mid-loop the done-flag must NOT be written (otherwise
		 * onInstalled won't fire on SW restart and the remaining foreign tabs stay dead).
		 * Re-derive remaining work from a FRESH query and only mark done when ZERO foreign
		 * park.html tabs remain. If some remain (we were interrupted, or chrome.tabs.update
		 * has not settled yet), leave the flag unset so onStartup can finish the job later.
		 */
		const remainingTabs = await chrome.tabs.query({});
		const stillForeign = StartupRefresh.planLegacyMigration(
			remainingTabs as unknown as { id: number, url: string, windowId: number, favIconUrl?: string }[],
			selfId,
			chrome.runtime.getURL('park.html')
		);
		if (stillForeign.length === 0) {
			await chrome.storage.local.set({ [MIGRATION_DONE_KEY]: true });
			console.log(`[ParkedTabMigration] Complete — migrated ${toMigrate.length} tab(s); no foreign tabs remain.`);
		} else {
			console.log(`[ParkedTabMigration] Partial — ${stillForeign.length} foreign tab(s) still remain; done-flag NOT set, will resume on next startup.`);
		}
	} catch (e) {
		console.error('[ParkedTabMigration] Error:', e);
	}
}

/**
 *
 */
function drawSetupWizardDialog() {
	chrome.tabs.query({ currentWindow: true, active: true }, function(tabs) {
		chrome.tabs.create({
			'windowId': tabs[0].windowId,
			'index': tabs[0].index + 1,
			'url': chrome.runtime.getURL('wizard_background.html'),
			'active': true
		}).catch(console.error);
	});
}

/**
 *
 */
function start() {

	console.log(Copyright);

	if (debug)
		console.warn('********************************************************************************************************');
	console.warn('* Starting...   ', new Date());
	console.warn('********************************************************************************************************');

	trackErrors('background', false);

	startedAt = new Date().getTime();
	console.log('TSSessionId: ', TSSessionId);

	/* Save last session ID */
	chrome.storage.local.get([TS_SESSION_ID_KEY]).then((result) => {
		previousTSSessionId = result[TS_SESSION_ID_KEY];
		console.log('previousTSSessionId: ', previousTSSessionId);

		chrome.storage.local.set({ [TS_SESSION_ID_KEY]: TSSessionId }).then(() => {
			console.log('previousTSSessionId is stored in chrome.storage.local');
		}, console.error);
	}).catch(() => {
		console.error('previousTSSessionId is not found in chrome.storage.local');
	});


	/* Connect DB */
	// @ts-ignore
	database = new DBProvider('IndexedDB');

	setTimeout(cleanupDB, DELAY_BEFORE_DB_CLEANUP);


	const prepare = async function() {
		/* TODO: cleanup this logic after cleanup complete! */

		/* Prepare settings */
		const firstInstallation = ((await SettingsStoreClient.get('timeout', SETTINGS_STORAGE_NAMESPACE)) == null && !chrome.extension.inIncognitoContext);

		settings = new SettingsStore(SETTINGS_STORAGE_NAMESPACE, DEFAULT_SETTINGS, offscreenDocumentProvider);

		/*
		 * TODO: WIZARD: ADD IF FOR IS IT FIRST INSTALL OR UPDATE ONLY!!!
		 */
		try {
			settings.getOnStorageInitialized().then(async () => {

				/* ????? WILL BE INITIALISED 2 TIMES: HERE AND INSIDE INIT(..) TO RELOAD SETTINGS ?????????? */
				whiteList = new WhiteList(settings);

				windowManger = new WindowManager();
				tabManager = new TabManager();
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				tabObserver = new TabObserver(tabManager);
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				tabCapture = new TabCapture(tabManager);
				contextMenuController = new ContextMenuController(tabManager);
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				formRestoreController = new PageStateRestoreController();
				settingsPageController = new SettingsPageController();
				ignoreList = new IgnoreList();
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				bgMessageListener = new BGMessageListener(tabManager);

				setTimeout(() => void trackView('TS started', { version: chrome.runtime.getManifest().version }), 5000);

				const isAlreadyHasSyncSettings = ((await LocalStore.get(LocalStoreKeys.INSTALLED)) != null && !chrome.extension.inIncognitoContext);
				if (firstInstallation && !isAlreadyHasSyncSettings) {
					console.log('EX: Installed!');
					drawSetupWizardDialog();
					setTimeout(() => void trackView(LocalStoreKeys.INSTALLED), 5000);
				} else {
					console.log('EX: Updated!');
					//setTimeout(() => void trackView('updated'), 5000);
					if (!isAlreadyHasSyncSettings) {
						LocalStore.set(LocalStoreKeys.INSTALLED, true).catch(console.error);
					}
				}
			})
				.catch(console.error)
				.finally(() => {
					if (debug)
						setTimeout(preInit, 1000);
					else
						setTimeout(preInit, 500);
				});
			// eslint-disable-next-line no-empty
		} catch (e) {
			console.error(e);
		}

		// Wait for session restore, then process tabs
		await SessionRestoreDetector.waitForGroupRestore({ parkUrl });

		// Ensure settings init is complete before reading (guards against slow storage on startup)
		await settings.getOnStorageInitialized();

		const startNormalTabsDiscarted = await settings.get('startNormalTabsDiscarted');

		/*
		 * Fork: robust-startup — hybrid favicon refresh.
		 * Read feature flags ONCE before the query (settings already init above).
		 * With ~1000 parked tabs, unconditionally reloading every parked faviconless
		 * tab floods the single MV3 service worker (each park.js re-run sendMessages back).
		 * Instead, eagerly reload only the focused window's parked tabs and defer the rest
		 * to a paced backfill (offscreen queue + on-activation drain in TabManager).
		 */
		const hybrid = await settings.get('hybridStartupFaviconRefresh');
		const scope = await settings.get('startupEagerScope');
		const focused = await chrome.windows.getLastFocused({ populate: false }).catch(() => null);
		const focusedWindowId = focused != null ? focused.id : undefined;

		/* Discard tabs */
		chrome.tabs.query({ active: false/*, discarded: false*/ }, async function(tabs) {
			console.log('Processing tabs after session restore - total tabs:', tabs.length);

			/*
			 * Fork: classify parked+faviconless tabs into eager (reload now) vs deferred
			 * (backfill later) using the pure helper, then apply the side effects here.
			 */
			const refreshPlan = StartupRefresh.planHybridRefresh(
				tabs as unknown as { id: number, url: string, windowId: number, favIconUrl?: string }[],
				{ hybrid, scope, parkUrl, focusedWindowId }
			);
			for (const id of refreshPlan.eager)
				chrome.tabs.reload(id).catch(console.error);
			for (const id of refreshPlan.deferred)
				pendingFaviconRefresh.add(id);

			for (const i in tabs) {
				if (tabs.hasOwnProperty(i)) {
					// Parked-tab eager/deferred refresh handled above via refreshPlan.

					if (tabs[i].url.indexOf(parkUrl) == -1) {
						if (startNormalTabsDiscarted)
							if (tabs[i].discarded == false)
								if (!await tabManager.isExceptionTab(tabs[i]))
									try {
										console.log('Discarding tab:', tabs[i].id, 'groupId:', tabs[i].groupId, 'url:', tabs[i].url);
										discardTab(tabs[i].id);
									} catch (e) {
										console.error('Discard error', e);
									}
					}
				}
			}

			/*
			 * Fork: the active tab of the focused window is excluded by {active:false}.
			 * Eagerly reload it too if it is a parked+faviconless tab so the visible tab
			 * gets its favicon back immediately (only relevant under hybrid activeWindow).
			 */
			if (hybrid && scope === 'activeWindow' && focusedWindowId != null) {
				chrome.tabs.query({ active: true, windowId: focusedWindowId }, function(activeTabs) {
					for (const j in activeTabs) {
						if (activeTabs.hasOwnProperty(j)) {
							const t = activeTabs[j];
							if (t.url != null && t.url.startsWith(parkUrl) &&
								(t.favIconUrl === null || t.favIconUrl == '')) {
								chrome.tabs.reload(t.id).catch(console.error);
								pendingFaviconRefresh.delete(t.id);
							}
						}
					}
				});
			}

			/*
			 * Fork: hand the deferred (background-window) parked tabs to the offscreen
			 * paced-backfill queue so they refresh gradually without flooding the SW.
			 */
			if (hybrid && scope === 'activeWindow' && pendingFaviconRefresh.size > 0) {
				const batch = await settings.get('lazyFaviconRefreshConcurrency');
				const delayMs = await settings.get('lazyRefreshDelayMs');
				offscreenDocumentProvider.enqueueLazyRefresh(
					Array.from(pendingFaviconRefresh),
					{ delayMs, batch }
				).catch(console.error);
			}
		});
	};

	void prepare();
}

/**
 *
 */
async function preInit(options) {

	await init(options);

	new BrowserActionControl(settings, whiteList, ContextMenuController.menuIdMap, pauseTics).synchronizeActiveTabs();
}

start();
