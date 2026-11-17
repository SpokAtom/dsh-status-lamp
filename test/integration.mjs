/**
 * Integration test for the view-options filter rows, run against a real DOM
 * (jsdom) instead of the minimal stubs used by smoke.mjs. It builds a menu that
 * mirrors the shipped structure, lets the plugin inject its two rows, then
 * exercises clicking, native-filter reset, label tidying and re-injection after a
 * React-style re-render.
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
const localeListeners = [];
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
    subscribe(listener) {
      localeListeners.push(listener);
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

const nativeLabels = ['隐藏已归档', '全部对话（显示已归档）', '仅显示已归档'];
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
  const rect = { width: 200, height: 30, top: 130 + index * 30, left: 0, right: 200, bottom: 160 + index * 30 };
  button.__rect = rect;
  wrapper.__rect = rect;
  wrapper.appendChild(button);
  menu.appendChild(wrapper);
  nativeWrappers.push(wrapper);
  return button;
});
window.document.body.appendChild(menu);

const rows = () => [...window.document.querySelectorAll('[data-status-lamp-filter-item]')];
const waitFor = async (predicate, timeout = 1500) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

assert.ok(await waitFor(() => rows().length === 2), 'two filter rows were not injected');

const hideRow = window.document.querySelector('[data-status-lamp-filter-role="hide-toggle"]');
const holdRow = window.document.querySelector('[data-status-lamp-filter-role="hold-only"]');
const rowWrapper = (row) => row.closest('[data-status-lamp-filter-wrap]');
assert.ok(hideRow, 'hide toggle row missing');
assert.ok(holdRow, 'on-hold-only row missing');
assert.ok(rowWrapper(hideRow), 'injected rows must clone the shipped wrapper');
assert.equal(hideRow.textContent.includes('隐藏已归档及挂起'), true, 'hide row label is wrong');
assert.equal(holdRow.textContent.includes('仅显示已挂起'), true, 'on-hold-only label is wrong');
assert.equal(rowWrapper(holdRow).previousElementSibling, nativeWrappers[2], 'on-hold-only row must be last');
assert.equal(sectionLabel.nextElementSibling, rowWrapper(hideRow), 'hide toggle must be first');
assert.equal(nativeWrappers[2].querySelectorAll('[data-status-lamp-filter-item]').length, 0, 'on-hold-only row must not be nested inside a shipped row');

assert.equal(nativeButtons[1].textContent.includes('（显示已归档）'), false, 'parenthetical suffix was not removed');
assert.equal(nativeButtons[1].textContent.trim(), '全部对话', 'native label after tidying is wrong');

// Click the hide toggle: the stylesheet attribute and storage must follow.
const click = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
click(hideRow);
assert.equal(window.document.documentElement.getAttribute('data-status-lamp-filter'), 'hide');
assert.equal(window.localStorage.getItem('dsh.status-lamp.filter.v1'), 'hide');

// Click the on-hold-only row: it replaces the mode, not stacks on it.
click(holdRow);
assert.equal(window.document.documentElement.getAttribute('data-status-lamp-filter'), 'hold');
assert.equal(window.localStorage.getItem('dsh.status-lamp.filter.v1'), 'hold');

// Choosing a shipped filter clears the plugin mode so the two never stack.
click(nativeButtons[2]);
assert.equal(window.document.documentElement.getAttribute('data-status-lamp-filter'), 'show');

// A React-style re-render can drop the injected rows while the menu stays open.
rows().forEach((row) => row.remove());
const extra = window.document.createElement('span');
menu.appendChild(extra);
assert.ok(await waitFor(() => rows().length === 2), 'rows were not re-injected after a re-render');

for (const cleanup of cleanups) cleanup();
console.log('PASS menu rows injected in the right order');
console.log('PASS shipped parenthetical label tidied');
console.log('PASS hide toggle, on-hold-only mode and native-filter reset');
console.log('PASS rows re-injected after a React-style re-render');
console.log('integration: ok');
