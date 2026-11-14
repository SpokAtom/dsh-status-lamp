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
    /** Re-evaluate relative times once a minute; five days needs no finer grain. */
    const CLOCK_MS = 60 * 1000;

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'state.idle': '空闲',
      'state.parked': '已挂起',
      'state.parked.auto': '已挂起 · 5 天无对话',
      'state.archived': '已归档',
      'menu.park': '挂起会话',
      'menu.unpark': '取消挂起',
    };
    const en = {
      'state.idle': 'Idle',
      'state.parked': 'Parked',
      'state.parked.auto': 'Parked · 5 days quiet',
      'state.archived': 'Archived',
      'menu.park': 'Park session',
      'menu.unpark': 'Unpark session',
    };

    // ---------------------------------------------------------------- store --
    // `explicit` holds user-marked sessions. `awake` remembers the Session's
    // updatedAt at the moment the user woke it, so the five-day rule does not
    // immediately re-park a session the user just unparked.
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
      /** Drop ids the Host no longer lists, so dead Sessions do not accumulate. */
      prune(knownIds) {
        const known = new Set(knownIds);
        const next = { explicit: new Set(stored.explicit), awake: new Map(stored.awake) };
        for (const id of [...next.explicit]) if (!known.has(id)) next.explicit.delete(id);
        for (const id of [...next.awake.keys()]) if (!known.has(id)) next.awake.delete(id);
        publish(next);
      },
    };

    // ---------------------------------------------------------------- clock --
    // One shared minute clock; getSnapshot returns a cached value so every row
    // re-renders at most once a minute and never loops inside React.
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
              const reason = parkedBy(parkedStore.getSnapshot(), sessionId, row, Date.now());
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
    }

    return { inject, apply };
  },
});
