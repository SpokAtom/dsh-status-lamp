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
      'filter.hold': '已挂起',
      'filter.hold.tip': '勾选显示已挂起的会话；不勾选则隐藏',
      'filter.archived': '已归档',
      'filter.archived.tip': '勾选显示已归档的会话；不勾选则隐藏',
    };
    const en = {
      'state.idle': 'Idle',
      'state.hold': 'On hold',
      'state.hold.auto': 'On hold · 5 days quiet',
      'state.archived': 'Archived',
      'menu.hold': 'Hold session',
      'menu.resume': 'Resume session',
      'filter.hold': 'On hold',
      'filter.hold.tip': 'Checked: show on-hold sessions; unchecked: hide them',
      'filter.archived': 'Archived',
      'filter.archived.tip': 'Checked: show archived sessions; unchecked: hide them',
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
    // this is a DOM-level enhancement: every time that menu opens, the shipped
    // filter rows are hidden and replaced by two multi-select rows — `hold` and
    // `archived`. Neither checked means only the remaining sessions are shown;
    // each checked token adds that group back. Everything fails open.
    const FILTER_KEY = 'dsh.status-lamp.show.v1';
    /** Pre-release key from the previous single-choice design, migrated on read. */
    const LEGACY_FILTER_KEY = 'dsh.status-lamp.filter.v1';
    const FILTER_ATTR = 'data-status-lamp-show';
    /** The shipped menu's CSS-module class suffix; the hash prefix may change. */
    const FILTER_MENU_SELECTOR = '[class*="viewOptionsMenu"]';
    const FILTER_ITEM_ATTR = 'data-status-lamp-filter-item';
    const FILTER_STYLE_ID = 'dsh-status-lamp-filter-css';
    const SHOW_TOKENS = ['hold', 'archived'];
    const HOLD_ICON =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/></svg>';
    const ARCHIVED_ICON =
      '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/></svg>';
    /**
     * Neither token present hides the matching rows. The attribute is always set
     * (possibly empty), and `[attr~="token"]` treats "hold archived" as two tokens.
     */
    const FILTER_CSS = [
      `html:not([${FILTER_ATTR}~="archived"]) [data-row-key^="session:"][class*="_archived"]{display:none !important}`,
      `html:not([${FILTER_ATTR}~="hold"]) [data-row-key^="session:"]:has([data-status-lamp="hold"]){display:none !important}`,
      `html:not([${FILTER_ATTR}~="hold"]) [data-row-key^="session:"]:has([data-status-lamp="hold-auto"]){display:none !important}`,
    ].join('');

    /** Read the persisted set of extra groups to show ('hold' and/or 'archived'). */
    function readShowSet() {
      try {
        const raw = window.localStorage.getItem(FILTER_KEY);
        if (raw === null) {
          // Migrate the pre-release single-choice value instead of losing it.
          const legacy = window.localStorage.getItem(LEGACY_FILTER_KEY);
          if (legacy === 'show') return new Set(SHOW_TOKENS);
          if (legacy === 'hold') return new Set(['hold']);
          return new Set();
        }
        const parsed = JSON.parse(raw);
        return new Set(
          Array.isArray(parsed) ? parsed.filter((token) => SHOW_TOKENS.includes(token)) : [],
        );
      } catch {
        return new Set();
      }
    }

    /** Toggle one group in the show set, returning a new set. */
    const toggleShowToken = (set, token) => {
      const next = new Set(set);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    };

    /** Space-separated attribute value, stable order so CSS and tests can rely on it. */
    const showAttrValue = (set) => SHOW_TOKENS.filter((token) => set.has(token)).join(' ');

    let showSet = readShowSet();

    /** Mirror the show set onto the root element; the stylesheet keys off it. */
    function applyFilterAttribute() {
      document.documentElement.setAttribute(FILTER_ATTR, showAttrValue(showSet));
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
      const WRAP_ATTR = 'data-status-lamp-filter-wrap';

      /** Localized label for one show token. */
      const tokenLabel = (token) => t(token === 'hold' ? 'filter.hold' : 'filter.archived');
      /** Localized tooltip for one show token. */
      const tokenTip = (token) => t(token === 'hold' ? 'filter.hold.tip' : 'filter.archived.tip');
      /** Icon for one show token. */
      const tokenIcon = (token) => (token === 'hold' ? HOLD_ICON : ARCHIVED_ICON);

      /** Persist and apply the show set, then repaint both rows. */
      const setShowSet = (next) => {
        showSet = new Set(next);
        try {
          window.localStorage.setItem(FILTER_KEY, JSON.stringify([...showSet]));
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

      /** One injected row: checkbox row for a single group. */
      const refreshRow = (token) => {
        const node = document.querySelector(`[${ROW_ROLE_ATTR}="${token}"]`);
        if (node === null) return;
        const checked = showSet.has(token);
        const label = tokenLabel(token);
        const tip = tokenTip(token);
        if (node.getAttribute('aria-label') !== label) node.setAttribute('aria-label', label);
        if (node.title !== tip) node.title = tip;
        const iconHost = node.querySelector('[class*="itemIcon"]');
        const icon = tokenIcon(token);
        if (iconHost !== null && iconHost.innerHTML !== icon) iconHost.innerHTML = icon;
        const labelHost = node.querySelector('[class*="itemLabel"]');
        if (labelHost !== null && labelHost.textContent !== label) labelHost.textContent = label;
        for (const check of node.querySelectorAll('[class*="_check"]')) {
          const display = checked ? '' : 'none';
          if (check.style.display !== display) check.style.display = display;
        }
        const ariaChecked = checked ? 'true' : 'false';
        if (node.getAttribute('aria-checked') !== ariaChecked) node.setAttribute('aria-checked', ariaChecked);
      };

      /** Repaint both checkbox rows from the current show set. */
      const refreshFilterRows = () => {
        for (const token of SHOW_TOKENS) refreshRow(token);
      };

      /** Repaint the rows' checked state only (used after a re-render). */
      const refreshMenuItemState = () => {
        for (const token of SHOW_TOKENS) {
          const row = document.querySelector(`[${ROW_ROLE_ATTR}="${token}"]`);
          if (row === null) continue;
          const checked = showSet.has(token);
          for (const check of row.querySelectorAll('[class*="_check"]')) {
            const display = checked ? '' : 'none';
            if (check.style.display !== display) check.style.display = display;
          }
        }
      };

      /**
       * Clone a shipped row so both injected rows inherit the native styling.
       * Shipped items are wrapped in a per-item element, so the wrapper is cloned
       * when present and the real row is the button inside it.
       */
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

      /** The direct child of `parent` that contains `element` (shipped rows sit in wrappers). */
      const siblingOf = (element, parent) => {
        let node = element;
        while (node.parentElement !== null && node.parentElement !== parent) node = node.parentElement;
        return node;
      };

      /** Hide the shipped filter rows: the section is replaced by our two checkboxes. */
      const hideNativeRows = (parent, nativeButtons) => {
        for (const button of nativeButtons) {
          const sibling = siblingOf(button, parent);
          if (sibling !== null && 'style' in sibling) sibling.style.display = 'none';
        }
      };

      /**
       * A shipped filter can persist a non-default choice from an earlier session
       * (for example "only archived"); reset it to "all conversations" so the two
       * checkboxes stay accurate. The middle shipped row is that default.
       */
      const resetShippedFilter = (nativeButtons) => {
        const defaultRow = nativeButtons[1] ?? null;
        if (defaultRow === null) return;
        const selected = nativeButtons.find((button) => /_selected/.test(String(button.className)));
        if (selected === undefined || selected === defaultRow) return;
        try {
          defaultRow.click();
        } catch {
          /* A failing reset only leaves the shipped filter as the user left it. */
        }
      };

      /**
       * Replace the shipped rows with the two checkbox rows. Both are inserted right
       * after the section label, in SHOW_TOKENS order.
       */
      const ensureFilterSection = () => {
        const section = visibleFilterSection();
        if (section === null) return;
        const parent = section.parentElement;
        if (parent === null) return;
        for (const stale of parent.querySelectorAll('[' + FILTER_ITEM_ATTR + ']')) {
          const role = stale.getAttribute(ROW_ROLE_ATTR);
          if (SHOW_TOKENS.includes(role)) continue;
          const wrap = stale.closest('[' + WRAP_ATTR + ']');
          (wrap ?? stale).remove();
          stale.remove();
        }
        const nativeButtons = [...parent.querySelectorAll('button[role="menuitem"]')].filter(
          (button) => !button.hasAttribute(FILTER_ITEM_ATTR),
        );
        if (nativeButtons.length === 0) return;
        for (const button of nativeButtons) button.setAttribute(NATIVE_ATTR, '');
        resetShippedFilter(nativeButtons);
        hideNativeRows(parent, nativeButtons);
        let anchorNode = siblingOf(section, parent);
        for (const token of SHOW_TOKENS) {
          if (parent.querySelector(`[${ROW_ROLE_ATTR}="${token}"]`) === null) {
            anchorNode.after(buildRow(nativeButtons[0], parent, token));
          }
          const row = parent.querySelector(`[${ROW_ROLE_ATTR}="${token}"]`);
          if (row !== null) anchorNode = siblingOf(row, parent);
        }
        refreshFilterRows();
        refreshMenuItemState();
      };

      /**
       * Insert once the menu is positioned: a menu that just mounted still sits at
       * its pre-layout position, so retry briefly until both rows land or the menu
       * goes away. A failure here must never surface.
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
          if (visibleRows.length >= SHOW_TOKENS.length) return;
          if (attempt >= 6) return;
          retryTimer = window.setTimeout(() => ensureWithRetry(attempt + 1), 80);
        } catch (error) {
          console.warn('[dsh-status-lamp] filter row injection failed', error);
        }
      };

      /** Coalesce observer bursts into one injection pass. */
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
          if (added && document.querySelector(FILTER_MENU_SELECTOR) !== null) scheduleEnsure();
        } catch (error) {
          console.warn('[dsh-status-lamp] view-options observer failed', error);
        }
      });

      /** Capture-phase toggle handler: survives React replacing the cloned rows. */
      const onDocumentClick = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const ownRow = target.closest('[' + FILTER_ITEM_ATTR + ']');
        if (ownRow === null) return;
        event.preventDefault();
        event.stopPropagation();
        const token = ownRow.getAttribute(ROW_ROLE_ATTR);
        if (!SHOW_TOKENS.includes(token)) return;
        setShowSet(toggleShowToken(showSet, token));
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
      }, 'status-lamp: filter menu rows');

      // Capture-phase delegation survives React replacing the cloned rows.
      ctx.effect(() => {
        document.addEventListener('click', onDocumentClick, true);
        return () => document.removeEventListener('click', onDocumentClick, true);
      }, 'status-lamp: filter row clicks');

      // A language switch rebuilds the rows with the active locale's copy.
      ctx.effect(
        () =>
          ctx.locale.subscribe(() => {
            try {
              for (const node of document.querySelectorAll(`[${FILTER_ITEM_ATTR}],[${WRAP_ATTR}]`)) node.remove();
              ensureWithRetry();
            } catch (error) {
              console.warn('[dsh-status-lamp] filter rows locale refresh failed', error);
            }
          }),
        'status-lamp: filter rows locale',
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
      __test: { readShowSet, toggleShowToken, showAttrValue },
    };
  },
});
