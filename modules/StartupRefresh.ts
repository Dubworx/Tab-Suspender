/*
 * Fork: robust-startup
 *
 * Pure, side-effect-free helpers for the large-session startup favicon-refresh
 * and the one-time parked-tab id migration. Extracted from background.ts so the
 * decision logic is unit-testable (mirrors SessionRestoreDetector's pattern).
 *
 * Nothing here touches chrome.* — callers in background.ts perform the actual
 * reload/update side effects from the plans these helpers return.
 */

// Matches chrome-extension://<32 a-p chars>/park.html?...  with the id captured.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const FOREIGN_PARK_URL_REGEX = /^chrome-extension:\/\/([a-p]{32})\/park\.html\?/;

interface StartupRefreshTab {
	id: number;
	url: string;
	windowId: number;
	favIconUrl?: string;
}

interface StartupRefreshPlan {
	// Parked + faviconless tabs in the focused window -> reload eagerly now.
	eager: number[];
	// Parked + faviconless tabs in background windows -> backfill lazily.
	deferred: number[];
}

interface HybridRefreshOptions {
	hybrid: boolean;
	scope: string;          // 'activeWindow' | 'all'
	parkUrl: string;
	focusedWindowId?: number;
}

class StartupRefresh {

	/**
	 * Is the tab a parked tab whose favicon is missing (needs a refresh)?
	 */
	static isParkedFaviconless(tab: StartupRefreshTab, parkUrl: string): boolean {
		return tab != null &&
			typeof tab.url === 'string' &&
			tab.url.startsWith(parkUrl) &&
			(tab.favIconUrl === null || tab.favIconUrl === undefined || tab.favIconUrl === '');
	}

	/**
	 * Classify a list of (active:false) tabs into eager vs deferred refresh sets.
	 *
	 * - hybrid && scope==='activeWindow': only the focused window's parked+faviconless
	 *   tabs are eager; the rest are deferred (backfilled by the offscreen queue).
	 * - hybrid OFF or scope==='all': every parked+faviconless tab is eager (original
	 *   unconditional behaviour, back-compat).
	 */
	static planHybridRefresh(tabs: StartupRefreshTab[], opts: HybridRefreshOptions): StartupRefreshPlan {
		const eager: number[] = [];
		const deferred: number[] = [];

		const windowScoped = opts.hybrid && opts.scope === 'activeWindow';

		for (const tab of (tabs || [])) {
			if (!StartupRefresh.isParkedFaviconless(tab, opts.parkUrl))
				continue;

			if (windowScoped) {
				if (tab.windowId === opts.focusedWindowId)
					eager.push(tab.id);
				else
					deferred.push(tab.id);
			} else {
				eager.push(tab.id);
			}
		}

		return { eager, deferred };
	}

	/**
	 * Parse a comma/newline-joined legacy-id string into a trimmed, non-empty list.
	 */
	static parseLegacyIds(raw: string | null | undefined): string[] {
		if (typeof raw !== 'string')
			return [];
		return raw.split(/[\n,]/).map(s => s.trim()).filter(s => s.length > 0);
	}

	/**
	 * Build the one-time migration plan: for every tab whose url is a FOREIGN
	 * park.html (captured id !== selfId), produce the new url that re-points it at
	 * THIS extension's park.html, preserving the query string VERBATIM (no re-encode).
	 *
	 * Self-id tabs are skipped (idempotent — avoids a no-op update storm). A 2nd run
	 * over an already-migrated set yields an empty plan.
	 *
	 * @param parkUrlForSelf  chrome.runtime.getURL('park.html') for this extension.
	 */
	static planLegacyMigration(
		tabs: StartupRefreshTab[],
		selfId: string,
		parkUrlForSelf: string
	): { id: number, url: string }[] {
		const plan: { id: number, url: string }[] = [];
		for (const tab of (tabs || [])) {
			if (tab == null || tab.url == null || tab.id == null)
				continue;
			const match = FOREIGN_PARK_URL_REGEX.exec(tab.url);
			if (match == null)
				continue;
			const capturedId = match[1];
			if (capturedId === selfId)
				continue; // skip self-id (idempotent)
			// Keep the query VERBATIM — slice from the first '?'.
			const url = parkUrlForSelf + tab.url.slice(tab.url.indexOf('?'));
			plan.push({ id: tab.id, url });
		}
		return plan;
	}
}

// @ts-ignore
if (typeof global !== 'undefined') {
	(global as any).StartupRefresh = StartupRefresh;
	(global as any).FOREIGN_PARK_URL_REGEX = FOREIGN_PARK_URL_REGEX;
}

// @ts-ignore
if (typeof module != 'undefined')
	// @ts-ignore
	module.exports = {
		StartupRefresh,
		FOREIGN_PARK_URL_REGEX,
	};
