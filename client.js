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
 * - parked   → hollow grey 6px ring; parked is either an explicit mark or
 *              automatic after AUTO_PARK_MS without conversation activity
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
    const STORAGE_KEY = 'dsh.status-lamp.parked.v2';
    const LEGACY_STORAGE_KEY = 'dsh.status-lamp.parked.v1';
    /** A session with no conversation activity for this long parks by itself. */
    const AUTO_PARK_MS = 5 * 24 * 60 * 60 * 1000;
    /** Re-evaluate relative times every five minutes; a five-day bar needs no finer grain. */
    const CLOCK_MS = 5 * 60 * 1000;

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'state.idle': '空闲',
      'state.parked': '已挂起',
      'state.parked.auto': '已挂起 · 5 天无对话',
      'state.archived': '已归档',
      'menu.park': '挂起会话',
      'menu.unpark': '取消挂起',
      'filter.label': '隐藏已归档及挂起',
      'filter.tip.on': '已开启：点击显示归档和挂起的会话',
      'filter.tip.off': '已关闭：点击隐藏归档和挂起的会话',
    };
    const en = {
      'state.idle': 'Idle',
      'state.parked': 'Parked',
      'state.parked.auto': 'Parked · 5 days quiet',
      'state.archived': 'Archived',
      'menu.park': 'Park session',
      'menu.unpark': 'Unpark session',
      'filter.label': 'Hide archived and parked',
      'filter.tip.on': 'On — click to show archived and parked sessions',
      'filter.tip.off': 'Off — click to hide archived and parked sessions',
    };

    // ---------------------------------------------------------------- store --
    // `explicit` holds user-marked sessions. `awake` remembers the Session's
    // updatedAt at the moment the user woke it, so the five-day rule does not
    // immediately re-park a session the user just unparked.
    /** A fresh empty park state; each read returns new containers for reference comparison. */
    const emptyState = () => ({ explicit: new Set(), awake: new Map() });

    /** Read the persisted state, migrating the v1 id array and tolerating garbage. */
    function readStored() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          const explicit = Array.isArray(parsed?.explicit) ? parsed.explicit : [];
          const awake = parsed?.awake !== null && typeof parsed?.awake === 'object' ? parsed.awake : {};
          return {
            explicit: new Set(explicit.filter((id) => typeof id === 'string' && id !== '')),
            awake: new Map(
              Object.entries(awake).filter(
                ([id, at]) => typeof id === 'string' && typeof at === 'number' && Number.isFinite(at),
              ),
            ),
          };
        }
        const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy !== null) {
          const parsed = JSON.parse(legacy);
          if (Array.isArray(parsed)) {
            return {
              explicit: new Set(parsed.filter((id) => typeof id === 'string' && id !== '')),
              awake: new Map(),
            };
          }
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

    /** The shared parked-set source: row seats read it, the menu action writes it. */
    const parkedStore = {
      getSnapshot: () => stored,
      subscribe: (listener) => {
        storeListeners.add(listener);
        return () => {
          storeListeners.delete(listener);
        };
      },
      park(sessionId) {
        const next = { explicit: new Set(stored.explicit), awake: new Map(stored.awake) };
        next.explicit.add(sessionId);
        next.awake.delete(sessionId);
        publish(next);
      },
      unpark(sessionId, updatedAt) {
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
    /** Why a session is parked: 'manual', 'auto', or null when it is awake. */
    function parkedBy(snapshot, sessionId, row, now) {
      if (snapshot.explicit.has(sessionId)) return 'manual';
      if (row === undefined || row.blank === true) return null;
      if (row.updatedAt <= 0) return null;
      if (now - row.updatedAt < AUTO_PARK_MS) return null;
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
    const PARKED_RING = {
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
     * idle, so it draws the parked ring when marked (explicitly or by the five-day
     * rule) and the blue idle dot otherwise.
     *
     * @param props.sessionId - Session this row shows.
     * @param props.parkedStore - Shared parked-set source.
     * @param props.useSessions - Session list selector hook.
     * @param props.t - Locale seat for this plugin's namespace.
     */
    function IdleStateLamp({ sessionId, parkedStore, useSessions, t }) {
      const row = useSessions((list) => {
        const summary = list.byId[sessionId];
        if (summary === undefined) return undefined;
        return `${typeof summary.updatedAt === 'number' ? summary.updatedAt : 0}|${summary.blank === true ? 'b' : ''}`;
      });
      const snapshot = React.useSyncExternalStore(parkedStore.subscribe, parkedStore.getSnapshot);
      const now = React.useSyncExternalStore(clock.subscribe, clock.getSnapshot);

      const parsed = row === undefined ? undefined : { updatedAt: Number(row.split('|')[0]), blank: row.endsWith('|b') };
      if (parsed !== undefined && !Number.isFinite(parsed.updatedAt)) parsed.updatedAt = 0;
      const reason = parkedBy(snapshot, sessionId, parsed, now);
      if (reason === 'auto') return lampFrame('parked-auto', t('state.parked.auto'), PARKED_RING);
      if (reason === 'manual') return lampFrame('parked', t('state.parked'), PARKED_RING);
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
    // stylesheet rule that hides parked and archived session rows. Everything
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
    const FILTER_CSS =
      'html[' +
      FILTER_ATTR +
      '="hide"] [data-row-key^="session:"][class*="_archived"],' +
      'html[' +
      FILTER_ATTR +
      '="hide"] [data-row-key^="session:"]:has([data-status-lamp="parked"]),' +
      'html[' +
      FILTER_ATTR +
      '="hide"] [data-row-key^="session:"]:has([data-status-lamp="parked-auto"]){' +
      'display:none !important}';

    /** Persisted filter mode: 'hide' hides parked + archived rows, 'show' keeps them. */
    function readFilterMode() {
      try {
        return window.localStorage.getItem(FILTER_KEY) === 'hide' ? 'hide' : 'show';
      } catch {
        return 'show';
      }
    }

    let filterMode = readFilterMode();

    /** Mirror the stored mode onto the root element; the stylesheet keys off it. */
    function applyFilterAttribute() {
      document.documentElement.setAttribute(FILTER_ATTR, filterMode);
    }

    const inject = ['slots', 'locale', 'contextMenus', 'sessions'];

    /**
     * Register the dictionaries, the two row seats and the park menu action.
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
            inject: () => ({ parkedStore }),
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
            id: 'status-lamp.park',
            target: 'session',
            order: 550,
            resolve: ({ sessionId }) => {
              const row = rowOf(sessionId);
              // Same clock the row seats read, so the menu and the lamp never
              // disagree about the five-day boundary by an instant.
              const reason = parkedBy(parkedStore.getSnapshot(), sessionId, row, clock.getSnapshot());
              return [
                {
                  id: reason === null ? 'park' : 'unpark',
                  label: t(reason === null ? 'menu.park' : 'menu.unpark'),
                  run: () => {
                    if (reason === null) parkedStore.park(sessionId);
                    else parkedStore.unpark(sessionId, row?.updatedAt);
                    parkedStore.prune(ctx.sessions.list.getSnapshot().ids);
                  },
                },
              ];
            },
          }),
        'status-lamp: park menu action',
      );

      // ---- view-options filter row (DOM-level, see the constants above) ----
      const filterLabel = () => t('filter.label');
      const filterTip = () => t(filterMode === 'hide' ? 'filter.tip.on' : 'filter.tip.off');

      /**
       * Repaint the injected row after the mode changed: same node, new label,
       * tooltip and state icon, so the menu does not have to be rebuilt.
       */
      const refreshFilterItem = () => {
        try {
          const node = document.querySelector('[' + FILTER_ITEM_ATTR + ']');
          if (node === null) return;
          node.setAttribute('aria-label', filterLabel());
          node.title = filterTip();
          const icon = node.querySelector('[class*="itemIcon"]');
          if (icon !== null) icon.innerHTML = filterMode === 'hide' ? EYE_OFF : EYE_ON;
        } catch (error) {
          console.warn('[dsh-status-lamp] filter row refresh failed', error);
        }
      };

      /**
       * Flip the filter mode: persist it, repaint the row, and let the stylesheet
       * attribute hide or show parked and archived rows.
       */
      const toggleFilter = () => {
        filterMode = filterMode === 'hide' ? 'show' : 'hide';
        try {
          window.localStorage.setItem(FILTER_KEY, filterMode);
        } catch {
          /* Filtering still works for this page load without storage. */
        }
        try {
          applyFilterAttribute();
          refreshFilterItem();
        } catch (error) {
          console.warn('[dsh-status-lamp] filter toggle failed', error);
        }
      };

      /** Clone a shipped menu row so the extra row inherits its exact styling. */
      const buildFilterItem = (anchor) => {
        const node = anchor.cloneNode(true);
        for (const name of [
          'id',
          'aria-haspopup',
          'aria-current',
          'aria-keyshortcuts',
          'aria-describedby',
          'aria-selected',
          'aria-checked',
        ]) {
          node.removeAttribute(name);
        }
        // A clone of the selected row would keep the selected paint; strip it
        // from the row and its children so the extra row reads as neutral.
        for (const element of [node, ...node.querySelectorAll('*')]) {
          if (!element.classList) continue;
          for (const name of [...element.classList]) {
            if (/_selected|_danger/.test(name)) element.classList.remove(name);
          }
        }
        node.setAttribute(FILTER_ITEM_ATTR, '');
        node.setAttribute('aria-label', filterLabel());
        node.title = filterTip();
        const icon = node.querySelector('[class*="itemIcon"]');
        if (icon !== null) icon.innerHTML = filterMode === 'hide' ? EYE_OFF : EYE_ON;
        for (const check of node.querySelectorAll('[class*="_check"]')) check.style.display = 'none';
        const label = node.querySelector('[class*="itemLabel"]');
        if (label !== null) label.textContent = filterLabel();
        node.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleFilter();
        });
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

      /**
       * Insert the filter row as the first row of the visible menu's last section
       * (筛选会话). Section labels are the `role="presentation"` rows carrying a
       * `*label*` class; the filter section is the bottom-most visible one. The
       * menu's own wrapper class is not used to locate the list, because a closing
       * menu keeps an off-screen copy of the same class.
       */
      const ensureFilterItem = () => {
        const labels = [...document.querySelectorAll('[role="presentation"]')].filter(
          (element) =>
            /label/i.test(String(element.className)) && onScreen(element.getBoundingClientRect()),
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
        if (section === null) return;
        const parent = section.parentElement;
        if (parent === null) return;
        if (parent.querySelector('[' + FILTER_ITEM_ATTR + ']') !== null) return;
        const anchor = parent.querySelector('button[role="menuitem"]');
        if (anchor === null) return;
        section.after(buildFilterItem(anchor));
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
          ensureFilterItem();
          const placed = [...document.querySelectorAll('[' + FILTER_ITEM_ATTR + ']')].some((node) =>
            onScreen(node.getBoundingClientRect()),
          );
          if (placed) return;
          if (attempt >= 6) return;
          retryTimer = window.setTimeout(() => ensureWithRetry(attempt + 1), 80);
        } catch (error) {
          console.warn('[dsh-status-lamp] filter row injection failed', error);
        }
      };

      /** Re-insert the row whenever a view-options menu appears. */
      const menuObserver = new MutationObserver((records) => {
        try {
          for (const record of records) {
            for (const added of record.addedNodes) {
              if (added.nodeType !== 1 || !(added instanceof Element)) continue;
              if (added.matches(FILTER_MENU_SELECTOR) || added.querySelector(FILTER_MENU_SELECTOR) !== null) {
                ensureWithRetry();
                return;
              }
            }
          }
        } catch (error) {
          console.warn('[dsh-status-lamp] view-options observer failed', error);
        }
      });

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
          for (const node of document.querySelectorAll('[' + FILTER_ITEM_ATTR + ']')) node.remove();
        };
      }, 'status-lamp: filter menu row');

      // A language switch rebuilds the injected row with the active locale's copy.
      ctx.effect(
        () =>
          ctx.locale.subscribe(() => {
            try {
              for (const node of document.querySelectorAll('[' + FILTER_ITEM_ATTR + ']')) node.remove();
              ensureWithRetry();
            } catch (error) {
              console.warn('[dsh-status-lamp] filter row locale refresh failed', error);
            }
          }),
        'status-lamp: filter row locale',
      );

      // Drop marks for sessions the Host no longer lists, once the list is ready.
      ctx.effect(() => {
        let pruned = false;
        const pruneOnce = () => {
          try {
            if (pruned) return;
            const ids = ctx.sessions.list.getSnapshot().ids;
            if (!Array.isArray(ids) || ids.length === 0) return;
            pruned = true;
            parkedStore.prune(ids);
          } catch (error) {
            console.warn('[dsh-status-lamp] park mark prune failed', error);
          }
        };
        pruneOnce();
        const source = ctx.sessions.list;
        const off = typeof source.subscribe === 'function' ? source.subscribe(pruneOnce) : undefined;
        return () => {
          if (typeof off === 'function') off();
        };
      }, 'status-lamp: prune park marks');
    }

    return { inject, apply };
  },
});
