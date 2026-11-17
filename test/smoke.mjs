/**
 * Smoke test for the Client half.
 *
 * The plugin ships as a single plain-JS browser module (no build step), so this
 * harness evaluates it inside `node:vm` with a minimal fake browser: enough DOM,
 * storage and Cordis surface to run `apply`, register the seats/menu action, and
 * exercise the hold/resume round trip. It intentionally does not render React or
 * the view-options menu; those are verified in the running app.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

// ---------------------------------------------------------------- fake page --
const storage = new Map();
const styleTags = [];
const rootAttributes = new Map();

class FakeElement {}
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  disconnect() {}
}

const documentStub = {
  documentElement: {
    setAttribute(name, value) {
      rootAttributes.set(name, value);
    },
    removeAttribute(name) {
      rootAttributes.delete(name);
    },
    get clientWidth() {
      return 1200;
    },
  },
  head: {
    appendChild(node) {
      styleTags.push(node);
      return node;
    },
  },
  body: {},
  createElement(tag) {
    return {
      tag,
      id: '',
      textContent: '',
      remove() {
        const index = styleTags.indexOf(this);
        if (index >= 0) styleTags.splice(index, 1);
      },
    };
  },
  getElementById() {
    return null;
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
};

let loaded = null;
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Element: FakeElement,
  MutationObserver: FakeMutationObserver,
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
  document: documentStub,
  window: {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    innerWidth: 1200,
    innerHeight: 900,
    setTimeout,
    clearTimeout,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  },
};
sandbox.window.document = documentStub;
sandbox.window.__ModuleLoader__ = {
  load: (definition) => {
    loaded = definition;
  },
};
sandbox.globalThis = sandbox;
createContext(sandbox);
runInContext(source, sandbox, { filename: 'client.js' });

assert.ok(loaded !== null, 'module loader was not called');
assert.equal(loaded.id, 'dsh-status-lamp');

const reactStub = {
  createElement: (...args) => ({ type: 'element', args }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
};
const client = loaded.factory(() => reactStub);
assert.equal(typeof client.apply, 'function', 'apply is missing');
assert.ok(Array.isArray(client.inject), 'inject list is missing');
for (const service of ['slots', 'locale', 'contextMenus', 'sessions']) {
  assert.ok(client.inject.includes(service), `inject is missing ${service}`);
}

// ---------------------------------------------------------------- fake ctx --
const cleanups = [];
const registrations = [];
const menuActions = [];
let localeDicts = null;
let localeListeners = [];

let listSnapshot = { ids: [], byId: {} };
const listListeners = [];
const emitList = (next) => {
  listSnapshot = next;
  for (const listener of [...listListeners]) listener();
};

const ctx = {
  effect(factory) {
    const cleanup = factory();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  },
  locale: {
    register(_namespace, dicts) {
      localeDicts = dicts;
      return () => {};
    },
    bind() {
      return (key) => key;
    },
    subscribe(listener) {
      localeListeners.push(listener);
      return () => {
        localeListeners = localeListeners.filter((entry) => entry !== listener);
      };
    },
  },
  slots: {
    inject(_key, factory) {
      factory();
      return () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
  contextMenus: {
    register(definition) {
      menuActions.push(definition);
      return () => {};
    },
  },
  sessions: {
    list: {
      getSnapshot: () => listSnapshot,
      subscribe(listener) {
        listListeners.push(listener);
        return () => {
          const index = listListeners.indexOf(listener);
          if (index >= 0) listListeners.splice(index, 1);
        };
      },
    },
  },
};

client.apply(ctx);

// ---------------------------------------------------------------- assertions --
const registeredIds = registrations.map((entry) => entry.options.id).sort();
assert.deepEqual(registeredIds, ['status-lamp', 'status-lamp-archive'], 'unexpected row seats');

const action = menuActions[0];
assert.ok(action, 'hold menu action was not registered');
assert.equal(action.id, 'status-lamp.hold');
assert.equal(action.target, 'session');

const first = action.resolve({ sessionId: 'session-1' });
assert.equal(first.length, 1);
assert.equal(first[0].id, 'hold', 'a fresh session should offer a hold');
first[0].run();

const stored = JSON.parse(storage.get('dsh.status-lamp.hold.v1'));
assert.deepEqual(stored.explicit, ['session-1'], 'hold mark was not persisted');
assert.equal(stored.awake['session-1'], undefined);

const second = action.resolve({ sessionId: 'session-1' });
assert.equal(second[0].id, 'resume', 'an on-hold session should offer resume');
second[0].run();
const afterResume = JSON.parse(storage.get('dsh.status-lamp.hold.v1'));
assert.deepEqual(afterResume.explicit, [], 'resume should clear the explicit mark');

// Hold again, then let the Host report the Session as running: the mark must go.
const third = action.resolve({ sessionId: 'session-1' });
assert.equal(third[0].id, 'hold');
third[0].run();
emitList({ ids: ['session-1'], byId: { 'session-1': { running: true } } });
const afterRunning = JSON.parse(storage.get('dsh.status-lamp.hold.v1'));
assert.deepEqual(afterRunning.explicit, [], 'a running Session must release its hold mark');
assert.equal(action.resolve({ sessionId: 'session-1' }).length, 0, 'running Sessions offer no hold action');

emitList({ ids: ['session-1'], byId: { 'session-1': { running: false } } });
assert.equal(action.resolve({ sessionId: 'session-1' })[0].id, 'hold', 'an idle Session can be put on hold again');

assert.ok(localeDicts !== null, 'locale dictionaries were not registered');
const zhKeys = Object.keys(localeDicts.zh).sort();
const enKeys = Object.keys(localeDicts.en).sort();
assert.deepEqual(zhKeys, enKeys, 'zh/en dictionaries must share the same keys');

const filterCss = styleTags.map((tag) => tag.textContent).find((text) => /data-status-lamp-filter/.test(text));
assert.ok(filterCss, 'filter stylesheet was not injected');
assert.match(filterCss, /data-row-key\^="session:"/, 'filter stylesheet must target session rows');
assert.match(filterCss, /_archived/, 'filter stylesheet must target archived rows');
assert.match(filterCss, /hold/, 'filter stylesheet must target hold rows');

assert.equal(rootAttributes.get('data-status-lamp-filter'), 'show');
assert.ok(localeListeners.length > 0, 'locale change listener was not installed');

for (const cleanup of cleanups) cleanup();

console.log('PASS seats:', registeredIds.join(', '));
console.log('PASS menu action:', action.id);
console.log('PASS hold/resume round trip and persistence');
console.log('PASS running Session releases its hold mark');
console.log('PASS zh/en dictionary key parity:', zhKeys.length, 'keys');
console.log('PASS filter stylesheet and root attribute');
console.log('PASS locale listener installed');
console.log('smoke: ok');
