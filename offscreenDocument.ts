type BatteryStatusMessage = {
	isCharging: boolean;
	level: number;
};

type SuspendedTabInfo = {
	url: string;
	title: string;
	favicon?: string;
};

const batteryDebug = false;
const oldSettingsKeyPrefix = "store.tabSuspenderSettings.";
const BACKUP_SYNC_ORIGIN = 'https://uninstall.tab-suspender.com';

setTimeout(startBatteryStatusNotifier, 3500);
setTimeout(startServiceWorkerHeartbeat, 4000);
setTimeout(initBackupSync, 5000);

// Fork: robust-startup — optional keep-alive port (captured in onConnect below).
let keepAlivePort: chrome.runtime.Port | null = null;

function startServiceWorkerHeartbeat() {
	console.log('Starting service worker heartbeat from offscreen document...');

	// Send a heartbeat ping every 20 seconds to keep the service worker alive
	// This works because handling messages resets the service worker's idle timer
	setInterval(() => {
		// Fork: the 20s sendMessage is the keep-alive OF RECORD and must ALWAYS fire.
		// A quiescent connect port does NOT reliably reset the MV3 idle timer, so the
		// optional keep-alive port is additive hardening only — never a replacement for
		// this heartbeat. (Previously this early-returned when keepAlivePort was set,
		// which could let the SW die at the 30s idle limit once the queue drained.)
		chrome.runtime.sendMessage({
			method: '[TS:offscreenDocument:heartbeat]'
		}).catch((error) => {
			// Service worker might not be running yet, that's ok
			if (error.message !== 'Could not establish connection. Receiving end does not exist.') {
				console.error('Heartbeat error:', error);
			}
		});
	}, 20000); // Every 20 seconds

	console.log('Service worker heartbeat started');
}

// ============================================
// Fork: PACED PARKED-TAB FAVICON BACKFILL QUEUE
// Drains a queue of parked+faviconless tab ids in batches, messaging the SW per
// batch to perform the actual reloads (MV3 single-owner). One setInterval is armed
// while the queue is non-empty and torn down when it drains (no perpetual wakeup).
// ============================================
let lazyRefreshQueue: number[] = [];
let lazyRefreshTimer: ReturnType<typeof setInterval> | null = null;
let lazyRefreshBatch = 3;

function startLazyRefresh(ids: number[], options: { delayMs: number, batch: number }) {
	if (!Array.isArray(ids) || ids.length === 0)
		return;

	lazyRefreshQueue = lazyRefreshQueue.concat(ids);
	lazyRefreshBatch = (options && typeof options.batch === 'number' && options.batch > 0) ? options.batch : 3;
	const delayMs = (options && typeof options.delayMs === 'number' && options.delayMs > 0) ? options.delayMs : 250;

	console.log(`[offscreenDocument] startLazyRefresh: queued ${ids.length} (total ${lazyRefreshQueue.length}), batch=${lazyRefreshBatch}, delayMs=${delayMs}`);

	// Arm exactly ONE interval.
	if (lazyRefreshTimer != null)
		return;

	lazyRefreshTimer = setInterval(() => {
		if (lazyRefreshQueue.length === 0) {
			if (lazyRefreshTimer != null) {
				clearInterval(lazyRefreshTimer);
				lazyRefreshTimer = null;
			}
			console.log('[offscreenDocument] lazyRefresh queue drained, interval cleared.');
			return;
		}

		const tabIds = lazyRefreshQueue.splice(0, lazyRefreshBatch);
		chrome.runtime.sendMessage({
			method: '[TS:offscreenDocument:reloadParkedTab]',
			tabIds
		}).catch((error) => {
			if (error.message !== 'Could not establish connection. Receiving end does not exist.')
				console.error('[offscreenDocument] reloadParkedTab message error:', error);
		});
	}, delayMs);
}

// Fork: capture the optional keep-alive port from the SW.
chrome.runtime.onConnect.addListener((port) => {
	if (port.name === 'ts-offscreen-keepalive') {
		console.log('[offscreenDocument] keep-alive port connected.');
		keepAlivePort = port;
		port.onMessage.addListener((message) => {
			if (message && message.method === '[TS:offscreenDocument:startLazyRefresh]') {
				startLazyRefresh(message.tabIds, { delayMs: message.delayMs, batch: message.batch });
			}
		});
		port.onDisconnect.addListener(() => {
			console.log('[offscreenDocument] keep-alive port disconnected.');
			keepAlivePort = null;
		});
	}
});

function startBatteryStatusNotifier() {
	try {
		// @ts-ignore
		(navigator as (Navigator)).getBattery().then(function(battery) {
			battery.onchargingchange = function(event) {
				if (batteryDebug)
					console.log(`Charging event: ${event.target.charging}`);
				void chrome.runtime.sendMessage({
					method: '[TS:offscreenDocument:batteryStatusChanged]',
					battery: {
						isCharging: event.target.charging,
					} as BatteryStatusMessage,
				});
			};
			battery.onlevelchange = () => {
				if (batteryDebug)
					console.log(`Battery level event: ${battery.level}`);

				void chrome.runtime.sendMessage({
					method: '[TS:offscreenDocument:batteryStatusChanged]',
					battery: {
						level: battery.level,
					} as BatteryStatusMessage,
				});
			}

			console.log(`Startup Charging status: ${battery.charging}`);
			void chrome.runtime.sendMessage({
				method: '[TS:offscreenDocument:batteryStatusChanged]',
				battery: {
					isCharging: battery.charging
				} as BatteryStatusMessage,
			});
		});
	} catch (e) {
		console.log('navigator.getBattery() does not support by browser!', e);
	}
}

// @ts-ignore
// Sentry.init({
// 	dsn: "https://d03bb30d517ec1594272cf217fc44f39@o4509192171945984.ingest.de.sentry.io/4509192186495056",
// 	allowUrls: [/.*/],
// 	integrations: (defaultIntegrations) => {
// 		// Remove browser session
// 		return defaultIntegrations.filter(
// 			(integration) => {
// 				console.log(`integration: `, integration);
// 				return integration.name !== "BrowserSession"
// 			},
// 		);
// },
// });

function sendError(errorData) {
	const targetError = new Error(errorData.message);
	targetError.stack = errorData.stack;

	// @ts-ignore
	//Sentry
	//	.captureException(targetError);
}

function sendEvent(event) {
	// @ts-ignore
	//Sentry
	//	.captureEvent(event);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

		if (message.method === '[TS:offscreenDocument:heartbeatAck]') {
			// Heartbeat acknowledgment received from service worker
			// No action needed, this is just to confirm the connection
			return true;

		} else if (message.method === '[TS:offscreenDocument:sendError]') {

			console.log(`[TS:offscreenDocument:sendError]: ${message.type}`);

			if (message.type === 'error')
				sendError(message.error);
			else
				sendEvent(message.event);

		} else if (message.method === '[TS:offscreenDocument:getLocalStorageData]') {

			console.log(`[TS:offscreenDocument:getLocalStorageData]: ${message.settingsKeys}`);

			const oldSettings = {};
			for (const i in message.settingsKeys) {
				// Get old settings...
				console.log(`Key: ${message.settingsKeys[i]}`);
				//debugger;
				oldSettings[message.settingsKeys[i]] = localStorage.getItem(oldSettingsKeyPrefix + message.settingsKeys[i]);
			}
			sendResponse(oldSettings);

		} else if (message.method === '[TS:offscreenDocument:startFormDatasCleanup]') {

			console.log(`[TS:offscreenDocument:startFormDatasCleanup]`);

			void cleanup();

		} else if (message.method === '[TS:offscreenDocument:startLazyRefresh]') {

			// Fork: robust-startup — start/append the paced parked-tab favicon backfill queue.
			startLazyRefresh(message.tabIds, { delayMs: message.delayMs, batch: message.batch });
		}
	}
);

async function cleanup() {
	console.log(`Starting f_t cleanup...`);
	let i = -1;
	for (const key in localStorage) {
		i++;
		// Cleaning f_t items...
		if (key.startsWith('f_t')) {
			localStorage.removeItem(key);
			if (i % 100 === 0) {
				console.log(`Cleaned ${i} f_t items`);
				await new Promise(r => setTimeout(r, 500));
			}
		}
	}

	void chrome.runtime.sendMessage({
		method: '[TS:offscreenDocument:cleanupComplete]'
	});

	console.log(`f_t cleanup completed.`);
}

// ============================================
// BACKUP SYNC - Sync suspended tabs to external localStorage
// ============================================

let backupSyncFrame: HTMLIFrameElement | null = null;
let backupSyncReady = false;

function initBackupSync() {
	console.log('[BackupSync] Initializing...');
	console.log('[BackupSync] Expected origin:', BACKUP_SYNC_ORIGIN);

	backupSyncFrame = document.getElementById('backupSyncFrame') as HTMLIFrameElement;

	if (!backupSyncFrame) {
		console.error('[BackupSync] ERROR: iframe element not found in DOM');
		return;
	}

	console.log('[BackupSync] iframe element found:', backupSyncFrame);
	console.log('[BackupSync] iframe src:', backupSyncFrame.src);

	// Function to mark iframe as ready and start sync
	const markReady = () => {
		console.log('[BackupSync] iframe onload fired');
		// Give iframe 500ms to initialize its scripts
		setTimeout(() => {
			backupSyncReady = true;
			console.log('[BackupSync] iframe marked as ready, starting initial sync');
			syncSuspendedTabs();
		}, 500);
	};

	// Check if iframe is already loaded (if we attached listener after load event)
	// For cross-origin iframes we can't check contentDocument, so we just assume it's loaded
	// if we're attaching the listener after a delay
	const isAlreadyLoaded = backupSyncFrame.src && document.readyState === 'complete';

	if (isAlreadyLoaded) {
		console.log('[BackupSync] iframe appears to be already loaded, marking ready immediately');
		markReady();
	} else {
		// Wait for iframe to load
		// Note: postMessage from cross-origin iframe to parent doesn't work in offscreen documents
		backupSyncFrame.addEventListener('load', markReady);
		console.log('[BackupSync] Waiting for iframe load event...');
	}

	backupSyncFrame.addEventListener('error', (e) => {
		console.error('[BackupSync] iframe onerror:', e);
	});

	// Listen for acknowledgment messages from iframe
	window.addEventListener('message', (event) => {
		console.log('[BackupSync] Received message:', {
			origin: event.origin,
			data: event.data,
			expectedOrigin: BACKUP_SYNC_ORIGIN,
			originMatch: event.origin === BACKUP_SYNC_ORIGIN
		});

		if (event.origin !== BACKUP_SYNC_ORIGIN) {
			console.log('[BackupSync] Origin mismatch, ignoring message');
			return;
		}

		if (event.data?.type === 'SYNC_ACK') {
			console.log(`[BackupSync] Acknowledged: ${event.data.count} tabs saved`);
		}
	});

	// Start periodic sync (every 20 seconds, aligned with heartbeat)
	setInterval(syncSuspendedTabs, 20000);

	console.log('[BackupSync] Initialization complete');
}

async function syncSuspendedTabs() {
	if (!backupSyncFrame || !backupSyncReady) {
		console.log('Backup sync not ready, skipping...');
		return;
	}

	try {
		// Request suspended tabs list from background
		const response = await chrome.runtime.sendMessage({
			method: '[TS:offscreenDocument:getSuspendedTabs]'
		});

		if (response?.tabs && Array.isArray(response.tabs)) {
			// Send to iframe
			backupSyncFrame.contentWindow?.postMessage({
				type: 'SYNC_TABS',
				tabs: response.tabs,
				timestamp: Date.now()
			}, BACKUP_SYNC_ORIGIN);

			console.log(`Synced ${response.tabs.length} suspended tabs to backup`);
		}
	} catch (error) {
		console.error('Error syncing suspended tabs:', error);
	}
}