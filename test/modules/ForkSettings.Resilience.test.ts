// Fork: robust-startup
// The 7 new settings keys must survive SettingsStore init without throwing
// 'Unknown property', and must keep their declared types:
//  - STRING/NUMBER keys (startupEagerScope, parkedTabMigrationLegacyIds,
//    lazyFaviconRefreshConcurrency, lazyRefreshDelayMs) are in SETTINGS_TYPES so
//    store.ts does NOT type-reset them to boolean on startup;
//  - boolean keys (hybridStartupFaviconRefresh, useOffscreenKeepAlivePort,
//    enableParkedTabIdMigration) default via the boolean fallback.
import '../lib/Chrome';
import '../typing/global.d';
import '../../fancy-settings/source/lib/store';
import '../../modules/Settings';

(global as any).debug = false;

function makeMockStorage(
  localData: Record<string, any> = {},
  syncData: Record<string, any> = {}
) {
  return {
    local: {
      get: jest.fn().mockImplementation(async (keys: string | string[]) => {
        const result: Record<string, any> = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => {
          if (localData[k] !== undefined) result[k] = localData[k];
        });
        return result;
      }),
      set: jest.fn().mockImplementation(async (data: Record<string, any>) => {
        Object.assign(localData, data);
      }),
      remove: jest.fn().mockImplementation(async (keys: string | string[]) => {
        (Array.isArray(keys) ? keys : [keys]).forEach(k => delete localData[k]);
      }),
      clear: jest.fn().mockImplementation(async () => {
        Object.keys(localData).forEach(k => delete localData[k]);
      }),
    },
    sync: {
      get: jest.fn().mockImplementation(async (keys: string | string[] | null) => {
        if (keys === null) return { ...syncData };
        const result: Record<string, any> = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => {
          if (syncData[k] !== undefined) result[k] = syncData[k];
        });
        return result;
      }),
      set: jest.fn().mockImplementation(async (data: Record<string, any>) => {
        Object.assign(syncData, data);
      }),
      remove: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    },
    onChanged: { addListener: jest.fn() },
  };
}

function makeOffscreenProvider() {
  return {
    extractOldSettings: jest.fn().mockResolvedValue({}),
    cleanupFormDatas: jest.fn().mockResolvedValue(undefined),
  };
}

async function createStore(storage: any) {
  (global as any).chrome.storage = storage;
  const store = new (global as any).SettingsStore(
    'tabSuspenderSettings',
    (global as any).DEFAULT_SETTINGS,
    makeOffscreenProvider()
  );
  await store.getOnStorageInitialized();
  return store;
}

const NEW_KEYS = [
  'hybridStartupFaviconRefresh',
  'startupEagerScope',
  'lazyFaviconRefreshConcurrency',
  'lazyRefreshDelayMs',
  'useOffscreenKeepAlivePort',
  'enableParkedTabIdMigration',
  'parkedTabMigrationLegacyIds',
];

describe('Fork settings - DEFAULT_SETTINGS / SETTINGS_TYPES contract', () => {
  it('all 7 new keys exist in DEFAULT_SETTINGS', () => {
    const D = (global as any).DEFAULT_SETTINGS;
    for (const k of NEW_KEYS)
      expect(Object.prototype.hasOwnProperty.call(D, k)).toBe(true);
  });

  it('STRING/NUMBER keys are registered in SETTINGS_TYPES (so they are NOT reset to boolean)', () => {
    const T = (global as any).SETTINGS_TYPES;
    expect(T.startupEagerScope).toBe('string');
    expect(T.parkedTabMigrationLegacyIds).toBe('string');
    expect(T.lazyFaviconRefreshConcurrency).toBe('number');
    expect(T.lazyRefreshDelayMs).toBe('number');
  });

  it('boolean keys are NOT in SETTINGS_TYPES (default boolean via fallback)', () => {
    const T = (global as any).SETTINGS_TYPES;
    expect(T.hybridStartupFaviconRefresh).toBeUndefined();
    expect(T.useOffscreenKeepAlivePort).toBeUndefined();
    expect(T.enableParkedTabIdMigration).toBeUndefined();
  });

  it('default values have the expected real typed values', () => {
    const D = (global as any).DEFAULT_SETTINGS;
    expect(D.hybridStartupFaviconRefresh).toBe(true);
    expect(D.startupEagerScope).toBe('activeWindow');
    expect(D.lazyFaviconRefreshConcurrency).toBe(3);
    expect(D.lazyRefreshDelayMs).toBe(250);
    expect(D.useOffscreenKeepAlivePort).toBe(false);
    expect(D.enableParkedTabIdMigration).toBe(true);
    expect(D.parkedTabMigrationLegacyIds).toBe('fiabciakcmgepblmdkmemdbbkilneeeh');
  });
});

describe('Fork settings - survive init and get/set without throwing', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('first install (empty storage): all 7 keys initialize to their typed defaults', async () => {
    const store = await createStore(makeMockStorage({}, {}));

    expect(await store.get('hybridStartupFaviconRefresh')).toBe(true);
    expect(await store.get('startupEagerScope')).toBe('activeWindow');
    expect(await store.get('lazyFaviconRefreshConcurrency')).toBe(3);
    expect(await store.get('lazyRefreshDelayMs')).toBe(250);
    expect(await store.get('useOffscreenKeepAlivePort')).toBe(false);
    expect(await store.get('enableParkedTabIdMigration')).toBe(true);
    expect(await store.get('parkedTabMigrationLegacyIds'))
      .toBe('fiabciakcmgepblmdkmemdbbkilneeeh');
  });

  it('STRING/NUMBER stored values are NOT type-reset to boolean on init', async () => {
    // Pre-seed local storage with valid typed values; init must keep them.
    const localData: Record<string, any> = {
      'store.tabSuspenderSettings.startupEagerScope': 'all',
      'store.tabSuspenderSettings.lazyFaviconRefreshConcurrency': 7,
      'store.tabSuspenderSettings.lazyRefreshDelayMs': 1000,
      'store.tabSuspenderSettings.parkedTabMigrationLegacyIds': 'abc,def',
    };
    const store = await createStore(makeMockStorage(localData, {}));

    expect(await store.get('startupEagerScope')).toBe('all');
    expect(await store.get('lazyFaviconRefreshConcurrency')).toBe(7);
    expect(await store.get('lazyRefreshDelayMs')).toBe(1000);
    expect(await store.get('parkedTabMigrationLegacyIds')).toBe('abc,def');
  });

  it('get() and set() never throw "Unknown property" for the new keys', async () => {
    const store = await createStore(makeMockStorage({}, {}));

    // get() must resolve (not reject with 'Unknown property') for every new key.
    let getError: unknown = null;
    try {
      for (const k of NEW_KEYS)
        await store.get(k);
    } catch (e) {
      getError = e;
    }
    expect(getError).toBeNull();

    // set with the correct type for each — must resolve (never reject 'Unknown property').
    // Awaiting directly: any rejection (e.g. 'Unknown property') would fail the test.
    let setError: unknown = null;
    try {
      await store.set('hybridStartupFaviconRefresh', false);
      await store.set('startupEagerScope', 'all');
      await store.set('lazyFaviconRefreshConcurrency', 5);
      await store.set('lazyRefreshDelayMs', 500);
      await store.set('useOffscreenKeepAlivePort', true);
      await store.set('enableParkedTabIdMigration', false);
      await store.set('parkedTabMigrationLegacyIds', 'x,y');
    } catch (e) {
      setError = e;
    }
    expect(setError).toBeNull();

    expect(await store.get('hybridStartupFaviconRefresh')).toBe(false);
    expect(await store.get('startupEagerScope')).toBe('all');
    expect(await store.get('lazyFaviconRefreshConcurrency')).toBe(5);
    expect(await store.get('lazyRefreshDelayMs')).toBe(500);
    expect(await store.get('useOffscreenKeepAlivePort')).toBe(true);
    expect(await store.get('enableParkedTabIdMigration')).toBe(false);
    expect(await store.get('parkedTabMigrationLegacyIds')).toBe('x,y');
  });
});
