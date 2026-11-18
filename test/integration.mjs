/**
 * Integration test for the multi-select filter rows, run against a real DOM
 * (jsdom). The shipped filter is replaced by two checkbox rows — "On hold" and
 * "Archived" — where neither checked means only the remaining sessions are shown.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' });
const { window } = dom;

// jsdom lays nothing out; give every element a synthetic rect so the on-screen
// checks in the plugin accept our menu.
window.Element.prototype.getBoundingClientRect = function boundingRect() {
  return this.__rect ?? { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
};

let loaded = null;
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  Set,
  Map,
  String,
  Number,
  Array,
  Object,
  Infinity,
  document: window.document,
  window,
  Element: window.Element,
  MutationObserver: window.MutationObserver,
  localStorage: window.localStorage,
};
sandbox.globalThis = sandbox;
sandbox.window.__ModuleLoader__ = {
  load: (definition) => {
    loaded = definition;
  },
};
runInNewContext(source, sandbox, { filename: 'client.js' });

const reactStub = {
  createElement: () => null,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
};
const client = loaded.factory(() => reactStub);

const cleanups = [];
let registeredDicts = null;
const ctx = {
  effect(factory) {
    const cleanup = factory();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  },
  locale: {
    register(_ns, dicts) {
      registeredDicts = dicts;
      return () => {};
    },
    bind() {
      return (key) => registeredDicts.zh[key] ?? key;
    },
    subscribe() {
      return () => {};
    },
  },
  slots: {
    inject(_key, factory) {
      factory();
      return () => {};
    },
    register() {
      return () => {};
    },
  },
  contextMenus: {
    register() {
      return () => {};
    },
  },
  sessions: {
    list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} },
  },
};
client.apply(ctx);

// ------------------------------------------------------------- fake shipped menu
const menu = window.document.createElement('div');
menu.className = 'viewOptionsMenu_hash';
const sectionLabel = window.document.createElement('div');
sectionLabel.setAttribute('role', 'presentation');
sectionLabel.className = '_label_hash';
sectionLabel.textContent = '筛选会话';
sectionLabel.__rect = { width: 200, height: 20, top: 100, left: 0, right: 200, bottom: 120 };
menu.appendChild(sectionLabel);

const groupLabel = window.document.createElement('div');
groupLabel.setAttribute('role', 'presentation');
groupLabel.className = '_label_hash';
groupLabel.textContent = '分组方式';
groupLabel.__rect = { width: 200, height: 20, top: 20, left: 0, right: 200, bottom: 40 };
const groupWrapper = window.document.createElement('div');
groupWrapper.className = 'itemWrap_hash';
groupWrapper.__rect = { width: 200, height: 30, top: 50, left: 0, right: 200, bottom: 80 };
const groupButton = window.document.createElement('button');
groupButton.setAttribute('role', 'menuitem');
groupButton.className = '_item_hash';
groupButton.textContent = '按工作区';
groupWrapper.appendChild(groupButton);
menu.insertBefore(groupWrapper, sectionLabel);
menu.insertBefore(groupLabel, groupWrapper);

const nativeLabels = ['隐藏已归档', '全部对话', '仅显示已归档'];
const nativeWrappers = [];
const nativeButtons = nativeLabels.map((text, index) => {
  const wrapper = window.document.createElement('div');
  wrapper.className = 'itemWrap_hash';
  const button = window.document.createElement('button');
  button.setAttribute('role', 'menuitem');
  button.className = '_item_hash';
  const icon = window.document.createElement('span');
  icon.className = 'itemIcon_hash';
  const label = window.document.createElement('span');
  label.className = 'itemLabel_hash';
  label.textContent = text;
  button.append(icon, label);
  if (index === 2) {
    // Only the shipped selected row carries a check mark, like the real menu.
    const check = window.document.createElement('span');
    check.className = '_check_hash';
    check.textContent = '✓';
    button.appendChild(check);
  }
  const rect = { width: 200, height: 30, top: 130 + index * 30, left: 0, right: 200, bottom: 160 + index * 30 };
  button.__rect = rect;
  wrapper.__rect = rect;
  wrapper.appendChild(button);
  menu.appendChild(wrapper);
  nativeWrappers.push(wrapper);
  return button;
});

// Simulate a persisted shipped filter that is not the default ("only archived").
nativeButtons[2].classList.add('_selected_hash');
nativeWrappers[2].classList.add('_selected_hash_wrap');
let defaultClicks = 0;
nativeButtons[1].addEventListener('click', () => {
  defaultClicks += 1;
});

window.document.body.appendChild(menu);

const rows = () => [...window.document.querySelectorAll('[data-status-lamp-filter-item]')];
const rowFor = (role) => window.document.querySelector(`[data-status-lamp-filter-role="${role}"]`);
const waitFor = async (predicate, timeout = 1500) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

assert.ok(await waitFor(() => rows().length === 2), 'two checkbox rows were not injected');

const holdRow = rowFor('hold');
const archivedRow = rowFor('archived');
assert.ok(holdRow, 'on-hold checkbox missing');
assert.ok(archivedRow, 'archived checkbox missing');
assert.equal(holdRow.textContent.includes('已挂起'), true, 'on-hold label is wrong');
assert.ok(holdRow.querySelector('[class*="_check"]'), 'injected row must carry the shipped check mark');
assert.ok(archivedRow.querySelector('[class*="_check"]'), 'injected row must carry the shipped check mark');
assert.equal(archivedRow.textContent.includes('已归档'), true, 'archived label is wrong');

// The shipped rows are hidden: the section is now exactly two checkboxes.
assert.equal(
  nativeWrappers.every((wrapper) => wrapper.style.display === 'none'),
  true,
  'shipped filter rows must be hidden',
);
assert.equal(defaultClicks, 1, 'a persisted non-default shipped filter must be reset to all conversations');
assert.equal(groupWrapper.style.display, '', 'earlier menu sections must stay visible');
assert.equal(groupButton.isConnected, true, 'earlier menu buttons must stay in the DOM');
const rowWrapper = (row) => row.closest('[data-status-lamp-filter-wrap]');
assert.notEqual(rowWrapper(holdRow).style.display, 'none', 'injected row must be visible');
assert.notEqual(rowWrapper(archivedRow).style.display, 'none', 'injected row must be visible');
assert.equal(sectionLabel.nextElementSibling, rowWrapper(holdRow), 'hold row must come first');
assert.equal(rowWrapper(holdRow).nextElementSibling, rowWrapper(archivedRow), 'archived row must follow the hold row');

const attr = () => window.document.documentElement.getAttribute('data-status-lamp-show');
const stored = () => JSON.parse(window.localStorage.getItem('dsh.status-lamp.show.v1') ?? '[]');
const click = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const checked = (row) => {
  const check = row.querySelector('[class*="_check"]');
  return check !== null && check.style.display !== 'none';
};

// Nothing checked: hide both groups (only the remaining sessions stay visible).
assert.equal(attr(), '', 'default state must hide both groups');
assert.equal(stored().length, 0);
assert.equal(checked(holdRow), false);
assert.equal(checked(archivedRow), false);

// Check "On hold": adds on-hold rows on top of the remaining sessions.
click(holdRow);
assert.equal(attr(), 'hold');
assert.deepEqual(stored(), ['hold']);
assert.equal(checked(holdRow), true);
assert.equal(checked(archivedRow), false);
assert.equal(holdRow.classList.contains('_selected_hash'), true, 'checked row must borrow the shipped selected paint');
assert.equal(rowWrapper(holdRow).classList.contains('_selected_hash_wrap'), true, 'checked row wrapper must borrow the shipped selected paint');

// Check "Archived" as well: both groups are shown, still additive.
click(archivedRow);
assert.equal(attr(), 'hold archived');
assert.deepEqual(stored().sort(), ['archived', 'hold']);
assert.equal(checked(archivedRow), true);

// Unchecking one group only removes that group.
click(holdRow);
assert.equal(attr(), 'archived');
assert.deepEqual(stored(), ['archived']);
assert.equal(checked(holdRow), false);
assert.equal(holdRow.classList.contains('_selected_hash'), false, 'unchecked row must drop the selected paint');

// Unchecking the last group returns to "hide both".
click(archivedRow);
assert.equal(attr(), '');
assert.deepEqual(stored(), []);

// Checkboxes are independent: clicking a hidden shipped row changes nothing.
click(nativeButtons[0]);
assert.equal(attr(), '');

// A React-style re-render can drop the injected rows while the menu stays open.
click(holdRow);
rows().forEach((row) => row.remove());
const extra = window.document.createElement('span');
menu.appendChild(extra);
assert.ok(await waitFor(() => rows().length === 2), 'rows were not re-injected after a re-render');
assert.equal(attr(), 'hold', 'checked state must survive a re-render');
assert.equal(checked(rowFor('hold')), true, 're-injected row must render the persisted checked state');

for (const cleanup of cleanups) cleanup();
console.log('PASS two checkbox rows replace the shipped filter rows');
console.log('PASS both unchecked hides both groups; each check adds one group');
console.log('PASS additive multi-select and persistence');
console.log('PASS rows re-injected after a React-style re-render with state intact');
console.log('integration: ok');
