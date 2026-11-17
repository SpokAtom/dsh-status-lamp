/**
 * Status lamp — the Client half.
 *
 * DSH already owns four native session-row states (pending interaction, running,
 * unread completion, idle) through ui-workspace's own StateDot, and its row
 * reserves the leading 16px cell for exactly one decoration while the row's
 * primary state is idle. This plugin adds the three states the native lamp does
 * not express:
 *
 * - idle     → blue filled 6px dot (the native lamp renders nothing)
 * - on hold   → hollow grey 6px ring; an on-hold row is either an explicit mark or
 *              automatic after AUTO_HOLD_MS without conversation activity
 * - archived → solid grey 6px dot (native archived rows keep the cell blank,
 *              so the mark renders in the trailing seat instead)
 *
 * Pending interaction, running, running subagents and unread completion are left
 * exactly as shipped: the row's higher-priority dot replaces the leading seat, so
 * this plugin never fights the native lamp.
 */
window.__ModuleLoader__.load({
  id: 'dsh-status-lamp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'status.lamp';
    const STORAGE_KEY = 'dsh.status-lamp.hold.v1';
    /** Older keys, newest first: the v2 object shape, then the v1 id array. */
    const LEGACY_STORAGE_KEYS = ['dsh.status-lamp.holded.v3', 'dsh.status-lamp.parked.v2', 'dsh.status-lamp.parked.v1'];
    /** A session with no conversation activity for this long holds by itself. */
    const AUTO_HOLD_MS = 5 * 24 * 60 * 60 * 1000;
    /** Re-evaluate relative times every five minutes; a five-day bar needs no finer grain. */
    const CLOCK_MS = 5 * 60 * 1000;

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'state.idle': '空闲',
      'state.hold': '已挂起',
      'state.hold.auto': '已挂起 · 5 天无对话',
      'state.archived': '已归档',
      'menu.hold': '挂起会话',
      'menu.resume': '取消挂起',
      'filter.label': '隐藏已归档及挂起',
      'filter.tip.on': '已开启：点击显示归档和挂起的会话',
      'filter.tip.off': '已关闭：点击隐藏归档和挂起的会话',
      'filter.holdOnly': '仅显示已挂起',
      'filter.holdOnly.on': '已开启：只显示挂起的会话，再点一次恢复',
      'filter.holdOnly.off': '只显示挂起的会话',
    };
    const en = {
      'state.idle': 'Idle',
      'state.hold': 'On hold',
      'state.hold.auto': 'On hold · 5 days quiet',
      'state.archived': 'Archived',
      'menu.hold': 'Hold session',
      'menu.resume': 'Resume session',
      'filter.label': 'Hide archived and on hold',
      'filter.tip.on': 'On — click to show archived and on-hold sessions',
      'filter.tip.off': 'Off — click to hide archived and on-hold sessions',
      'filter.holdOnly': 'Show only on hold',
      'filter.holdOnly.on': 'On — showing on-hold sessions only; click to restore',
      'filter.holdOnly.off': 'Show on-hold sessions only',
    };

    // ---------------------------------------------------------------- store --
    // `explicit` holds user-marked sessions. `awake` remembers the Session's
    // updatedAt at the moment the user woke it, so the five-day rule does not
    // immediately re-hold a session the user just resumed.
    /** A fresh empty hold state; each read returns new containers for reference comparison. */
    const emptyState = () => ({ explicit: new Set(), awake: new Map() });

    /** Coerce any persisted shape (object or legacy id array) into containers. */
    function restore(parsed) {
      const explicit = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.explicit) ? parsed.explicit : [];
      const awake =
        !Array.isArray(parsed) && parsed?.awake !== null && typeof parsed?.awake === 'object' ? parsed.awake : {};
      return {
        explicit: new Set(explicit.filter((id) => typeof id === 'string' && id !== '')),
        awake: new Map(
          Object.entries(awake).filter(
            ([id, at]) => typeof id === 'string' && typeof at === 'number' && Number.isFinite(at),
          ),
        ),
      };
    }

    /** Read the persisted state, migrating older shapes and tolerating garbage. */
    function readStored() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw !== null) return restore(JSON.parse(raw));
        for (const legacyKey of LEGACY_STORAGE_KEYS) {
          const legacy = window.localStorage.getItem(legacyKey);
          if (legacy !== null) return restore(JSON.parse(legacy));
        }
      } catch {
        /* A read-only or corrupt storage starts from the empty state. */
      }
      return emptyState();
    }

    let stored = readStored();
    const storeListeners = new Set();

    function publish(next) {
      stored = next;
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ explicit: [...next.explicit], awake: Object.fromEntries(next.awake) }),
        );
      } catch {
        /* In-memory marking still works when storage refuses writes. */
      }
      for (const listener of [...storeListeners]) listener();
    }

    /** The shared hold-set source: row seats read it, the menu action writes it. */
    const holdStore = {
      getSnapshot: () => stored,
      subscribe: (listener) => {
        storeListeners.add(listener);
        return () => {
          storeListeners.delete(listener);
        };
      },
      hold(sessionId) {
        const next = { explicit: new Set(stored.explicit), awake: new Map(stored.awake) };
        next.explicit.add(sessionId);
        next.awake.delete(sessionId);
        publish(next);
      },
      resume(sessionId, updatedAt) {
        const next = { explicit: new Set(stored.explicit), awake: new Map(stored.awake) };
        next.explicit.delete(sessionId);
        if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) next.awake.set(sessionId, updatedAt);
        else next.awake.delete(sessionId);
        publish(next);
      },
      /**
       * Drop ids the Host no longer lists; no-op (and no publish) when clean.
       * An empty known-id list means the snapshot is not ready yet, not that every
       * Session disappeared, so it is ignored instead of wiping the marks.
       */
      prune(knownIds) {
        if (!Array.isArray(knownIds) || knownIds.length === 0) return;
        const known = new Set(knownIds);
        const explicit = new Set();
        const awake = new Map();
        let changed = false;
        for (const id of stored.explicit) {
          if (known.has(id)) explicit.add(id);
          else changed = true;
        }
        for (const [id, at] of stored.awake) {
          if (known.has(id)) awake.set(id, at);
          else changed = true;
        }
        if (!changed) return;
        publish({ explicit, awake });
      },
      /**
       * Holding ends the moment a Session runs again: clear its explicit mark and
       * wake record so the row returns to the plain idle/native state.
       */
      releaseRunning(runningIds) {
        if (runningIds.size === 0) return;
        const explicit = new Set();
        const awake = new Map();
        let changed = false;
        for (const id of stored.explicit) {
          if (runningIds.has(id)) changed = true;
          else explicit.add(id);
        }
        for (const [id, at] of stored.awake) {
          if (runningIds.has(id)) changed = true;
          else awake.set(id, at);
        }
        if (!changed) return;
        publish({ explicit, awake });
      },
    };

    // ---------------------------------------------------------------- clock --
    // One shared clock; getSnapshot returns a cached value so every row
    // re-renders at most once per CLOCK_MS and never loops inside React.
    const clock = (() => {
      let value = Date.now();
      const listeners = new Set();
      let timer = null;
      const tick = () => {
        value = Date.now();
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          if (timer === null) timer = setInterval(tick, CLOCK_MS);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0 && timer !== null) {
              clearInterval(timer);
              timer = null;
            }
          };
        },
      };
    })();

    // ------------------------------------------------------------- deriving --
    /** Why a session is on hold: 'manual', 'auto', or null when it is awake. */
    function holdBy(snapshot, sessionId, row, now) {
      // A running Session is by definition not on hold: running releases the mark.
      if (row !== undefined && row.running === true) return null;
      if (snapshot.explicit.has(sessionId)) return 'manual';
      if (row === undefined || row.blank === true) return null;
      if (row.updatedAt <= 0) return null;
      if (now - row.updatedAt < AUTO_HOLD_MS) return null;
      const wokeAt = snapshot.awake.get(sessionId);
      if (typeof wokeAt === 'number' && wokeAt >= row.updatedAt) return null;
      return 'auto';
    }

    const IDLE_DOT = {
      display: 'block',
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: 'var(--dsw-static-blue-500)',
    };
    const HOLD_RING = {
      display: 'block',
      width: 6,
      height: 6,
      borderRadius: '50%',
      boxSizing: 'border-box',
      border: '1.5px solid var(--dsw-alias-state-idle-primary)',
    };
    const ARCHIVED_DOT = {
      display: 'block',
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: 'var(--dsw-alias-state-idle-primary)',
    };
    const CELL = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none',
      width: 10,
      height: 10,
    };

    /**
     * Build one lamp indicator.
     * @param kind - `data-status-lamp` value used by the filter stylesheet.
     * @param label - accessible name and tooltip, already localized.
     * @param dot - geometry/colour for the inner dot or ring.
     * @returns the centered 10px cell that the row seat expects.
     */
    function lampFrame(kind, label, dot) {
      return h(
        'span',
        {
          role: 'img',
          'aria-label': label,
          title: label,
          'data-status-lamp': kind,
          style: CELL,
        },
        h('span', { style: dot }),
      );
    }

    /**
     * Leading seat occupant: mounted by the row only while its primary state is
     * idle, so it draws the on hold ring when marked (explicitly or by the five-day
     * rule) and the blue idle dot otherwise.
     *
     * @param props.sessionId - Session this row shows.
     * @param props.holdStore - Shared hold-set source.
     * @param props.useSessions - Session list selector hook.
     * @param props.t - Locale seat for this plugin's namespace.
     */
    function IdleStateLamp({ sessionId, holdStore, useSessions, t }) {
      const row = useSessions((list) => {
        const summary = list.byId[sessionId];
        if (summary === undefined) return undefined;
        return `${typeof summary.updatedAt === 'number' ? summary.updatedAt : 0}|${summary.blank === true ? 'b' : ''}`;
      });
      const snapshot = React.useSyncExternalStore(holdStore.subscribe, holdStore.getSnapshot);
      const now = React.useSyncExternalStore(clock.subscribe, clock.getSnapshot);

      const parsed = row === undefined ? undefined : { updatedAt: Number(row.split('|')[0]), blank: row.endsWith('|b') };
      if (parsed !== undefined && !Number.isFinite(parsed.updatedAt)) parsed.updatedAt = 0;
      const reason = holdBy(snapshot, sessionId, parsed, now);
      if (reason === 'auto') return lampFrame('hold-auto', t('state.hold.auto'), HOLD_RING);
      if (reason === 'manual') return lampFrame('hold', t('state.hold'), HOLD_RING);
      return lampFrame('idle', t('state.idle'), IDLE_DOT);
    }

    /**
     * Trailing seat occupant: archived rows reserve no leading cell at all, so the
     * settled grey dot renders beside the row's time instead.
     *
     * @param props.sessionId - Session this row shows.
     * @param props.useWorkspaces - Workspace snapshot selector hook.
     * @param props.t - Locale seat for this plugin's namespace.
     */
    function ArchivedStateLamp({ sessionId, useWorkspaces, t }) {
      const archived = useWorkspaces((snapshot) => (snapshot.archivedSessionIds ?? []).includes(sessionId));
      if (!archived) return null;
      return lampFrame('archived', t('state.archived'), ARCHIVED_DOT);
    }

    // -------------------------------------------------------------- filter --
    // The view-options dropdown belongs to ui-workspace and exposes no slot, so
    // this is a DOM-level enhancement: every time that menu opens, one extra row
    // is cloned from a shipped item and inserted at its top. The row toggles a
    // stylesheet rule that hides on-hold and archived session rows. Everything
    // fails open — no menu found, no rule matched, no hiding — and the shipped UI
    // keeps working unchanged.
    const FILTER_KEY = 'dsh.status-lamp.filter.v1';
    const FILTER_ATTR = 'data-status-lamp-filter';
    /** The shipped menu's CSS-module class suffix; the hash prefix may change. */
    const FILTER_MENU_SELECTOR = '[class*="viewOptionsMenu"]';
    const FILTER_ITEM_ATTR = 'data-status-lamp-filter-item';
    const FILTER_STYLE_ID = 'dsh-status-lamp-filter-css';
    const EYE_ON =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12c1.4-4.1 4.7-7 9-7s7.6 2.9 9 7c-1.4 4.1-4.7 7-9 7s-7.6-2.9-9-7Z"/><circle cx="12" cy="12" r="2.6"/></svg>';
    const EYE_OFF =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 5 14 14"/><path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c4.3 0 7.6 2.9 9 7a11.6 11.6 0 0 1-2.4 3.5"/><path d="M5.4 7.4A11.8 11.8 0 0 0 3 12c1.4 4.1 4.7 7 9 7 1.1 0 2.1-.2 3.1-.6"/><path d="M10.5 10.5a2.1 2.1 0 0 0 3 3"/></svg>';
    const HOLD_ONLY_ICON =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.6"/></svg>';
    const FILTER_CSS = [
      `html[${FILTER_ATTR}="hide"] [data-row-key^="session:"][class*="_archived"],`,
      `html[${FILTER_ATTR}="hide"] [data-row-key^="session:"]:has([data-status-lamp="hold"]),`,
      `html[${FILTER_ATTR}="hide"] [data-row-key^="session:"]:has([data-status-lamp="hold-auto"]){display:none !important}`,
      `html[${FILTER_ATTR}="hold"] [data-row-key^="session:"]:not(:has([data-status-lamp="hold"])):not(:has([data-status-lamp="hold-auto"])){display:none !important}`,
    ].join('');

    /** Supported view modes: default, hide archived+on-hold, or only on-hold rows. */
    const FILTER_MODES = ['show', 'hide', 'hold'];

    /** Read the persisted view mode, falling back to the default. */
    function readFilterMode() {
      try {
        const raw = window.localStorage.getItem(FILTER_KEY);
        return FILTER_MODES.includes(raw) ? raw : 'show';
      } catch {
        return 'show';
      }
    }

    const normalizeFilterMode = (raw) => (FILTER_MODES.includes(raw) ? raw : 'show');
    /** Next mode when the "hide archived and on hold" toggle is used. */
    const nextHideMode = (mode) => (mode === 'hide' ? 'show' : 'hide');
    /** Next mode when the "show only on hold" row is used. */
    const nextHoldOnlyMode = (mode) => (mode === 'hold' ? 'show' : 'hold');
    /** Drop a trailing parenthetical shipped with a label, e.g. 全部对话（显示已归档） → 全部对话. */
    const stripParenthetical = (text) => text.replace(/\s*[（(][^（()）]*[)）]\s*$/u, '').trim();

    let filterMode = readFilterMode();

    /** Mirror the stored mode onto the root element; the stylesheet keys off it. */
    function applyFilterAttribute() {
      document.documentElement.setAttribute(FILTER_ATTR, filterMode);
    }

    const inject = ['slots', 'locale', 'contextMenus', 'sessions'];

    /**
     * Register the dictionaries, the two row seats and the hold menu action.
     * @param ctx - Client Cordis context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'status-lamp: dictionaries');
      const t = ctx.locale.bind(NS);

      // Read one Session row without subscribing; menu resolution is outside React.
      const rowOf = (sessionId) => {
        const list = ctx.sessions.list.getSnapshot();
        const summary = list.byId[sessionId];
        if (summary === undefined) return undefined;
        return {
          updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
          blank: summary.blank === true,
          running: summary.running === true,
        };
      };

      ctx.slots.inject('sidebar.session.row.leading', () =>
        ctx.slots.register(
          {
            name: 'sidebar.session.row.leading',
            id: 'status-lamp',
            order: 0,
            label: () => t('state.idle'),
            locale: NS,
            inject: () => ({ holdStore }),
          },
          IdleStateLamp,
        ),
      );

      ctx.slots.inject('sidebar.session.row.trailing', () =>
        ctx.slots.register(
          {
            name: 'sidebar.session.row.trailing',
            id: 'status-lamp-archive',
            order: 0,
            label: () => t('state.archived'),
            locale: NS,
          },
          ArchivedStateLamp,
        ),
      );

      ctx.effect(
        () =>
          ctx.contextMenus.register({
            id: 'status-lamp.hold',
            target: 'session',
            order: 550,
            resolve: ({ sessionId }) => {
              const row = rowOf(sessionId);
              // A running Session cannot stay on hold: running always releases the
              // mark, so offering hold/resume here would be misleading.
              if (row !== undefined && row.running) return [];
              // Same clock the row seats read, so the menu and the lamp never
              // disagree about the five-day boundary by an instant.
              const reason = holdBy(holdStore.getSnapshot(), sessionId, row, clock.getSnapshot());
              return [
                {
                  id: reason === null ? 'hold' : 'resume',
                  label: t(reason === null ? 'menu.hold' : 'menu.resume'),
                  run: () => {
                    if (reason === null) holdStore.hold(sessionId);
                    else holdStore.resume(sessionId, row?.updatedAt);
                    holdStore.prune(ctx.sessions.list.getSnapshot().ids);
                  },
                },
              ];
            },
          }),
        'status-lamp: hold menu action',
      );

      // ---- view-options filter rows (DOM-level, see the constants above) ----
      const ROW_ROLE_ATTR = 'data-status-lamp-filter-role';
      const NATIVE_ATTR = 'data-status-lamp-native-filter';
      const hideLabel = () => t('filter.label');
      const hideTip = () => t(filterMode === 'hide' ? 'filter.tip.on' : 'filter.tip.off');
      const holdOnlyLabel = () => t('filter.holdOnly');
      const holdOnlyTip = () => t(filterMode === 'hold' ? 'filter.holdOnly.on' : 'filter.holdOnly.off');

      /**
       * Persist and apply one view mode, then repaint both injected rows so their
       * icon and tooltip always describe the mode that is actually active.
       */
      const setFilterMode = (next) => {
        filterMode = normalizeFilterMode(next);
        try {
          window.localStorage.setItem(FILTER_KEY, filterMode);
        } catch {
          /* Filtering still works for this page load without storage. */
        }
        try {
          applyFilterAttribute();
          refreshFilterRows();
          refreshMenuItemState();
        } catch (error) {
          console.warn('[dsh-status-lamp] filter mode change failed', error);
        }
      };

      /** Repaint one injected row (label, tooltip, icon); writes only when changed. */
      const refreshRow = (role, label, tip, icon) => {
        const node = document.querySelector(`[${ROW_ROLE_ATTR}="${role}"]`);
        if (node === null) return;
        if (node.getAttribute('aria-label') !== label) node.setAttribute('aria-label', label);
        if (node.title !== tip) node.title = tip;
        const iconHost = node.querySelector('[class*="itemIcon"]');
        if (iconHost !== null && iconHost.innerHTML !== icon) iconHost.innerHTML = icon;
        const labelHost = node.querySelector('[class*="itemLabel"]');
        if (labelHost !== null && labelHost.textContent !== label) labelHost.textContent = label;
      };

      /** Repaint both injected rows from the current mode. */
      const refreshFilterRows = () => {
        refreshRow('hide-toggle', hideLabel(), hideTip(), filterMode === 'hide' ? EYE_OFF : EYE_ON);
        refreshRow('hold-only', holdOnlyLabel(), holdOnlyTip(), HOLD_ONLY_ICON);
      };

      /** Shipped filter rows carry selected paint; keep our own rows' checked state exact. */
      const refreshMenuItemState = () => {
        const selected = filterMode !== 'show';
        for (const row of document.querySelectorAll('[' + FILTER_ITEM_ATTR + ']')) {
          const checked = selected && row.getAttribute(ROW_ROLE_ATTR) === 'hide-toggle' ? 'true' : 'false';
          if (row.getAttribute('aria-checked') !== checked) row.setAttribute('aria-checked', checked);
        }
      };

      /**
       * Clone a shipped row so both injected rows inherit the native styling.
       * Shipped items are wrapped in a per-item element, so the wrapper is cloned
       * when present and the real row is the button inside it.
       */
      const WRAP_ATTR = 'data-status-lamp-filter-wrap';
      const buildRow = (anchor, parent, role) => {
        const wrapper = anchor.parentElement !== null && anchor.parentElement !== parent ? anchor.parentElement : null;
        const node = (wrapper ?? anchor).cloneNode(true);
        for (const element of [node, ...node.querySelectorAll('*')]) {
          if (!element.classList) continue;
          for (const name of [...element.classList]) {
            if (/_selected|_danger/.test(name)) element.classList.remove(name);
          }
          if (/_check/i.test(String(element.className))) element.style.display = 'none';
        }
        const row = wrapper === null ? node : node.querySelector('button[role="menuitem"]') ?? node;
        for (const name of [
          'id',
          'aria-haspopup',
          'aria-current',
          'aria-keyshortcuts',
          'aria-describedby',
          'aria-selected',
          'aria-checked',
        ]) {
          row.removeAttribute(name);
        }
        row.setAttribute(FILTER_ITEM_ATTR, '');
        row.setAttribute(ROW_ROLE_ATTR, role);
        if (wrapper !== null) node.setAttribute(WRAP_ATTR, '');
        return node;
      };

      /** True while the rect is on screen; a menu sliding out of view fails this. */
      const onScreen = (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
        rect.top < (window.innerHeight || document.documentElement.clientHeight);

      /** The bottom-most visible section label of the open view-options menu. */
      const visibleFilterSection = () => {
        const labels = [...document.querySelectorAll('[role="presentation"]')].filter(
          (element) => /label/i.test(String(element.className)) && onScreen(element.getBoundingClientRect()),
        );
        let section = null;
        let lowest = -Infinity;
        for (const label of labels) {
          const parent = label.parentElement;
          if (parent === null) continue;
          const hasVisibleItem = [...parent.querySelectorAll('button[role="menuitem"]')].some((button) =>
            onScreen(button.getBoundingClientRect()),
          );
          if (!hasVisibleItem) continue;
          const top = label.getBoundingClientRect().top;
          if (top > lowest) {
            lowest = top;
            section = label;
          }
        }
        return section;
      };

      /** Mark the shipped rows and drop parenthetical suffixes such as 全部对话（显示已归档）. */
      const tidyNativeRows = (parent) => {
        for (const button of parent.querySelectorAll('button[role="menuitem"]')) {
          if (button.hasAttribute(FILTER_ITEM_ATTR)) continue;
          button.setAttribute(NATIVE_ATTR, '');
          for (const label of button.querySelectorAll('[class*="itemLabel"]')) {
            const text = label.textContent ?? '';
            const tidy = stripParenthetical(text);
            if (tidy !== '' && tidy !== text) label.textContent = tidy;
          }
        }
      };

      /**
       * Insert both plugin rows into the visible filter section: the hide toggle as
       * the first row, and "show only on hold" as the last row. The shipped rows
       * keep their positions in between.
       */
      const ensureFilterSection = () => {
        const section = visibleFilterSection();
        if (section === null) return;
        const parent = section.parentElement;
        if (parent === null) return;
        tidyNativeRows(parent);
        const nativeButtons = [...parent.querySelectorAll('button[role="menuitem"]')].filter(
          (button) => !button.hasAttribute(FILTER_ITEM_ATTR),
        );
        if (nativeButtons.length === 0) return;
        // Insert as siblings of the shipped wrappers, never inside them.
        const siblingOf = (element) => {
          let node = element;
          while (node.parentElement !== null && node.parentElement !== parent) node = node.parentElement;
          return node;
        };
        if (parent.querySelector(`[${ROW_ROLE_ATTR}="hide-toggle"]`) === null) {
          siblingOf(section).after(buildRow(nativeButtons[0], parent, 'hide-toggle'));
        }
        if (parent.querySelector(`[${ROW_ROLE_ATTR}="hold-only"]`) === null) {
          siblingOf(nativeButtons[nativeButtons.length - 1]).after(
            buildRow(nativeButtons[0], parent, 'hold-only'),
          );
        }
        refreshFilterRows();
        refreshMenuItemState();
      };

      /**
       * Insert once the menu is positioned: a menu that just mounted still sits at
       * its pre-layout position, so retry briefly until the row lands or the menu
       * goes away. A failure here must never surface — the native menu keeps
       * working without the extra row.
       */
      let retryTimer = null;
      const clearRetry = () => {
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
      };
      const ensureWithRetry = (attempt = 0) => {
        clearRetry();
        try {
          ensureFilterSection();
          const visibleRows = [...document.querySelectorAll('[' + FILTER_ITEM_ATTR + ']')].filter((node) =>
            onScreen(node.getBoundingClientRect()),
          );
          if (visibleRows.length >= 2) return;
          if (attempt >= 6) return;
          retryTimer = window.setTimeout(() => ensureWithRetry(attempt + 1), 80);
        } catch (error) {
          console.warn('[dsh-status-lamp] filter row injection failed', error);
        }
      };

      /**
       * Coalesce observer bursts into one injection pass: React can add dozens of
       * nodes in a render, and re-running the DOM walk for each is wasteful.
       */
      let ensureTimer = null;
      const scheduleEnsure = () => {
        if (ensureTimer !== null) return;
        ensureTimer = window.setTimeout(() => {
          ensureTimer = null;
          ensureWithRetry();
        }, 50);
      };

      /** Re-insert the rows when a menu appears or re-renders while it is open. */
      const menuObserver = new MutationObserver((records) => {
        try {
          let added = false;
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType !== 1 || !(node instanceof Element)) continue;
              added = true;
              if (node.matches(FILTER_MENU_SELECTOR) || node.querySelector(FILTER_MENU_SELECTOR) !== null) {
                scheduleEnsure();
                return;
              }
            }
          }
          // A React re-render inside an open menu can drop the injected rows.
          if (added && document.querySelector(FILTER_MENU_SELECTOR) !== null) scheduleEnsure();
        } catch (error) {
          console.warn('[dsh-status-lamp] view-options observer failed', error);
        }
      });

      /**
       * One capture-phase click handler for every row: it survives React replacing
       * the cloned nodes, which per-node listeners did not.
       */
      const onDocumentClick = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const ownRow = target.closest('[' + FILTER_ITEM_ATTR + ']');
        if (ownRow !== null) {
          event.preventDefault();
          event.stopPropagation();
          const role = ownRow.getAttribute(ROW_ROLE_ATTR);
          setFilterMode(role === 'hold-only' ? nextHoldOnlyMode(filterMode) : nextHideMode(filterMode));
          return;
        }
        const nativeRow = target.closest('button[' + NATIVE_ATTR + ']');
        if (nativeRow !== null && !nativeRow.hasAttribute(FILTER_ITEM_ATTR) && filterMode !== 'show') {
          // A shipped filter wins: clear the plugin's own mode so they cannot stack.
          setFilterMode('show');
        }
      };

      ctx.effect(() => {
        applyFilterAttribute();
        let style = document.getElementById(FILTER_STYLE_ID);
        const created = style === null;
        if (style === null) {
          style = document.createElement('style');
          style.id = FILTER_STYLE_ID;
          document.head.appendChild(style);
        }
        style.textContent = FILTER_CSS;
        return () => {
          if (created) style.remove();
          document.documentElement.removeAttribute(FILTER_ATTR);
        };
      }, 'status-lamp: filter styles');

      ctx.effect(() => {
        menuObserver.observe(document.body, { childList: true, subtree: true });
        ensureWithRetry();
        return () => {
          menuObserver.disconnect();
          clearRetry();
          if (ensureTimer !== null) window.clearTimeout(ensureTimer);
          for (const node of document.querySelectorAll(`[${FILTER_ITEM_ATTR}],[${WRAP_ATTR}]`)) node.remove();
        };
      }, 'status-lamp: filter menu row');

      // Capture-phase delegation survives React replacing the cloned rows.
      ctx.effect(() => {
        document.addEventListener('click', onDocumentClick, true);
        return () => document.removeEventListener('click', onDocumentClick, true);
      }, 'status-lamp: filter row clicks');

      // A language switch rebuilds the injected row with the active locale's copy.
      ctx.effect(
        () =>
          ctx.locale.subscribe(() => {
            try {
              for (const node of document.querySelectorAll(`[${FILTER_ITEM_ATTR}],[${WRAP_ATTR}]`)) node.remove();
              ensureWithRetry();
            } catch (error) {
              console.warn('[dsh-status-lamp] filter row locale refresh failed', error);
            }
          }),
        'status-lamp: filter row locale',
      );

      // Keep stored marks in step with the Host's list: drop dead ids once the
      // list is ready, and release marks for Sessions that are running again.
      ctx.effect(() => {
        let pruned = false;
        const reconcile = () => {
          try {
            const snapshot = ctx.sessions.list.getSnapshot();
            const ids = Array.isArray(snapshot.ids) ? snapshot.ids : [];
            if (!pruned && ids.length > 0) {
              pruned = true;
              holdStore.prune(ids);
            }
            const running = new Set();
            const byId = snapshot.byId === undefined ? {} : snapshot.byId;
            for (const id of ids) if (byId[id]?.running === true) running.add(id);
            holdStore.releaseRunning(running);
          } catch (error) {
            console.warn('[dsh-status-lamp] hold mark reconcile failed', error);
          }
        };
        reconcile();
        const source = ctx.sessions.list;
        const off = typeof source.subscribe === 'function' ? source.subscribe(reconcile) : undefined;
        return () => {
          if (typeof off === 'function') off();
        };
      }, 'status-lamp: reconcile hold marks');
    }

    return {
      inject,
      apply,
      /** Pure helpers exposed for the smoke test; no behaviour depends on them. */
      __test: { readFilterMode, normalizeFilterMode, nextHideMode, nextHoldOnlyMode, stripParenthetical },
    };
  },
});
