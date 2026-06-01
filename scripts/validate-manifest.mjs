#!/usr/bin/env node
/*
 * Manifest / load-readiness validator — mimics the checks Chrome/Brave perform
 * at "Load unpacked" time, which neither tsc nor jest exercise.
 * Usage: node scripts/validate-manifest.mjs [dir=build_dir]
 * Exit 0 = clean; exit 1 = would fail to load (or referenced files missing).
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'build_dir';
const errors = [];
const warns = [];
const E = (m) => errors.push(m);
const W = (m) => warns.push(m);
const exists = (p) => fs.existsSync(path.join(dir, p));

const mpath = path.join(dir, 'manifest.json');
if (!fs.existsSync(mpath)) { console.error(`FATAL: ${mpath} not found`); process.exit(1); }
let m;
try { m = JSON.parse(fs.readFileSync(mpath, 'utf8')); }
catch (e) { console.error(`FATAL: manifest.json is not valid JSON: ${e.message}`); process.exit(1); }

// version: 1-4 dot-separated integers, each 0..65535 (the exact rule Brave enforced)
if (m.version == null) E(`"version" missing`);
else {
  const parts = String(m.version).split('.');
  if (parts.length < 1 || parts.length > 4) E(`"version" must be 1-4 dot-separated integers (got "${m.version}")`);
  for (const p of parts) {
    if (!/^\d+$/.test(p)) E(`"version" segment "${p}" is not an integer (got "${m.version}") — put labels in "version_name"`);
    else if (+p < 0 || +p > 65535) E(`"version" segment "${p}" out of range 0..65535`);
  }
}
if (m.version_name != null && typeof m.version_name !== 'string') E(`"version_name" must be a string`);
if (m.manifest_version !== 3) W(`manifest_version is ${m.manifest_version} (expected 3)`);

// name (allow __MSG_*__ if the locale message exists)
const msgKey = (v) => (typeof v === 'string' && /^__MSG_(.+)__$/.exec(v)?.[1]) || null;
let messages = null;
if (m.default_locale) {
  const mp = `_locales/${m.default_locale}/messages.json`;
  if (!exists(mp)) E(`default_locale "${m.default_locale}" but ${mp} missing`);
  else { try { messages = JSON.parse(fs.readFileSync(path.join(dir, mp), 'utf8')); } catch (e) { E(`${mp} invalid JSON: ${e.message}`); } }
}
const checkMsg = (field, val) => {
  const k = msgKey(val);
  if (!k) return;
  if (!m.default_locale) E(`${field} uses ${val} but no default_locale set`);
  else if (messages && !messages[k]) E(`${field} references message "${k}" missing from _locales/${m.default_locale}/messages.json`);
};
if (!m.name) E(`"name" missing`); else checkMsg('name', m.name);
checkMsg('description', m.description);

// key (pinned id) sanity
if (m.key != null) {
  if (typeof m.key !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(m.key)) E(`"key" is not valid base64`);
}

// background service worker
const sw = m.background?.service_worker;
if (m.manifest_version === 3) {
  if (!sw) E(`background.service_worker missing (MV3)`);
  else if (!exists(sw)) E(`background.service_worker "${sw}" not found in ${dir}`);
}

// referenced files must exist
const refs = [];
if (m.action?.default_popup) refs.push(['action.default_popup', m.action.default_popup]);
if (m.options_page) refs.push(['options_page', m.options_page]);
if (m.options_ui?.page) refs.push(['options_ui.page', m.options_ui.page]);
const iconRefs = (field, val) => {
  if (val == null) return;
  if (typeof val === 'string') refs.push([field, val]);              // Chrome allows a single string
  else if (typeof val === 'object') for (const [k, v] of Object.entries(val)) refs.push([`${field}.${k}`, v]);
};
iconRefs('icons', m.icons);
iconRefs('action.default_icon', m.action?.default_icon);
(m.content_scripts || []).forEach((cs, i) => (cs.js || []).forEach((j) => refs.push([`content_scripts[${i}].js`, j])));
for (const [field, rel] of refs) if (!exists(rel)) E(`${field} -> "${rel}" not found in ${dir}`);

// CSP shape (MV3: no remote script)
const csp = m.content_security_policy?.extension_pages;
if (csp && /script-src[^;]*(https?:|'unsafe-eval'|'unsafe-inline')/.test(csp)) W(`extension_pages CSP may be rejected by MV3: "${csp}"`);

// permissions sanity (warn-only on unknowns)
const KNOWN = new Set(['tabs','notifications','unlimitedStorage','contextMenus','storage','scripting','favicon','offscreen','alarms','idle','activeTab','cookies','webNavigation','downloads','sessions','tabGroups','declarativeNetRequest','power']);
for (const p of m.permissions || []) if (!KNOWN.has(p)) W(`permission "${p}" not in known set (verify it's a real Chrome permission)`);

// report
for (const w of warns) console.log(`WARN  ${w}`);
if (errors.length) { for (const e of errors) console.error(`ERROR ${e}`); console.error(`\nMANIFEST INVALID: ${errors.length} error(s) — extension would fail to load.`); process.exit(1); }
console.log(`OK: manifest valid for load (${dir}) — version ${m.version}${m.version_name ? ` (${m.version_name})` : ''}, ${warns.length} warning(s).`);
