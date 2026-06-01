import Reason = chrome.offscreen.Reason;

/**
 * Manages the offscreen document lifecycle.
 *
 * IMPORTANT: The offscreen document is kept alive (not closed) after initialization
 * because it serves multiple purposes:
 * 1. Migrating localStorage data and monitoring battery status
 * 2. Keeping the MV3 service worker alive by sending periodic heartbeat messages
 *    (see offscreenDocument.ts:startServiceWorkerHeartbeat)
 * 3. Syncing suspended tabs to external backup via iframe
 *    (see offscreenDocument.ts:initBackupSync)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
class OffscreenDocumentProvider {

	private readonly documentCreatedPromise: Promise<void>;

	// Fork: optional keep-alive port (only used when useOffscreenKeepAlivePort=true).
	private keepAlivePort: chrome.runtime.Port | null = null;

	constructor() {
		this.documentCreatedPromise = new Promise<void>(async (resolve, reject) => {

			await new Promise(r => setTimeout(r, 1500));

			try {
				// Check if an offscreen document already exists
				const hasDocument = await chrome.offscreen.hasDocument();

				if (hasDocument) {
					console.log('Offscreen Document already exists, skipping creation');
					resolve();
					return;
				}

				console.log('Offscreen Document Creating...');
				await chrome.offscreen.createDocument({
					url: 'offscreenDocument.html',
					reasons: [Reason.LOCAL_STORAGE, Reason.BATTERY_STATUS, Reason.IFRAME_SCRIPTING],
					justification: 'Need to migrate from localStorage, monitor battery status, and sync suspended tabs backup via iframe'
				});
				console.log('Offscreen Document Created successfully');
				resolve();
			} catch (error) {
				console.error('Error creating offscreen document:', error);
				reject(error);
			}
		});
	}

	async extractOldSettings(settingsKeys: string[]) {

		console.log('ExtractOldSettings started...');

		await this.documentCreatedPromise;

		const localStorageData = await chrome.runtime.sendMessage({
			method: '[TS:offscreenDocument:getLocalStorageData]',
			settingsKeys
		});

		console.log('LocalStorageData: ', localStorageData);

		// DO NOT close the offscreen document - it's needed for:
		// 1. Battery status monitoring
		// 2. Service worker heartbeat (keeps the service worker alive)
		// See class documentation for details

		return localStorageData;
	}

	/*
	 * Fork: robust-startup — hand a list of parked+faviconless tab ids to the offscreen
	 * document's paced backfill queue. The offscreen doc drains them in batches and
	 * messages the SW per batch ([TS:offscreenDocument:reloadParkedTab]) which performs
	 * the actual reloads (MV3 single-owner). delayMs/batch are passed in by the caller
	 * (sourced from Settings, which the provider cannot read at construction time).
	 *
	 * If useOffscreenKeepAlivePort is enabled we open a runtime.connect port for hardening;
	 * the message itself still goes via sendMessage (the keep-alive of record is the 20s
	 * sendMessage heartbeat — a quiescent port does not reliably reset the MV3 idle timer).
	 */
	async enqueueLazyRefresh(tabIds: number[], options: { delayMs: number, batch: number }) {
		if (!Array.isArray(tabIds) || tabIds.length === 0)
			return;

		console.log(`[OffscreenDocumentProvider] enqueueLazyRefresh: ${tabIds.length} tabs, batch=${options.batch}, delayMs=${options.delayMs}`);

		await this.documentCreatedPromise;

		// Optional port hardening (off by default). The port is opened lazily once.
		let usePort = false;
		try {
			if (typeof settings !== 'undefined' && settings != null)
				usePort = await settings.get('useOffscreenKeepAlivePort');
		} catch (e) {
			console.warn('[OffscreenDocumentProvider] could not read useOffscreenKeepAlivePort', e);
		}

		const payload = {
			method: '[TS:offscreenDocument:startLazyRefresh]',
			tabIds,
			delayMs: options.delayMs,
			batch: options.batch,
		};

		if (usePort) {
			this.ensureKeepAlivePort();
			if (this.keepAlivePort != null) {
				try {
					this.keepAlivePort.postMessage(payload);
					return;
				} catch (e) {
					console.warn('[OffscreenDocumentProvider] port postMessage failed, falling back to sendMessage', e);
				}
			}
		}

		await chrome.runtime.sendMessage(payload).catch(console.error);
	}

	private ensureKeepAlivePort() {
		if (this.keepAlivePort != null)
			return;
		try {
			const port = chrome.runtime.connect({ name: 'ts-offscreen-keepalive' });
			this.keepAlivePort = port;
			port.onDisconnect.addListener(() => {
				this.keepAlivePort = null;
				// Recreate the offscreen doc + reconnect with a small backoff.
				setTimeout(() => {
					void (async () => {
						try {
							const hasDocument = await chrome.offscreen.hasDocument();
							if (!hasDocument) {
								await chrome.offscreen.createDocument({
									url: 'offscreenDocument.html',
									reasons: [Reason.LOCAL_STORAGE, Reason.BATTERY_STATUS, Reason.IFRAME_SCRIPTING],
									justification: 'Need to migrate from localStorage, monitor battery status, and sync suspended tabs backup via iframe'
								});
							}
							this.ensureKeepAlivePort();
						} catch (e) {
							console.error('[OffscreenDocumentProvider] keep-alive reconnect failed', e);
						}
					})();
				}, 1000);
			});
		} catch (e) {
			console.warn('[OffscreenDocumentProvider] keep-alive connect failed', e);
			this.keepAlivePort = null;
		}
	}

	async cleanupFormDatas() {
		return new Promise<void>(async resolve => {

			console.log('CleanupFormDatas started...');

			await this.documentCreatedPromise;

			const messageListener = (message) => {
				if (message.method === '[TS:offscreenDocument:cleanupComplete]') {
					console.log(`CleanupFormDatas - Complete.`);
					// DO NOT close the offscreen document - it's needed for service worker heartbeat
					chrome.runtime.onMessage.removeListener(messageListener);
					resolve();
				}
			};

			chrome.runtime.onMessage.addListener(messageListener);

			/*await chrome.offscreen.createDocument({
				url: 'offscreenDocument.html',
				reasons: [Reason.LOCAL_STORAGE],
				justification: 'reason for needing the document'
			});*/

			await chrome.runtime.sendMessage({
				method: '[TS:offscreenDocument:startFormDatasCleanup]'
			});
		});
	}
}