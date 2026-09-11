/* --------------------------------------------------------------------------
 * Live presence for a shared board.
 *
 * Separate from the saved board on purpose. "Aapo is dragging that picture
 * right now" is worth seeing at 20 frames a second and worth nothing a second
 * later, so none of it is written to the database — it rides Supabase
 * Realtime's Presence (who is here) and Broadcast (what they are doing this
 * instant), both of which are pure message passing.
 *
 * That keeps the saved board small and keeps the merge in syncState.js dealing
 * only with things people meant to keep.
 * ------------------------------------------------------------------------ */
import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

// 20 updates a second: smooth to watch, and nothing is stored, so the only
// cost is a small websocket message.
const BROADCAST_MS = 50;
// Someone whose phone slept or whose tab closed mid-drag stops sending. Drop
// their marker rather than leaving a ghost stuck on the board forever.
const ACTIVITY_TTL_MS = 4000;

export function useLiveBoard(room, me, color, where) {
  const [peers, setPeers] = useState([]);       // everyone else on this board
  const [activity, setActivity] = useState({}); // peerId -> what they're doing

  const selfIdRef = useRef(null);
  if (!selfIdRef.current) selfIdRef.current = Math.random().toString(36).slice(2, 10);
  const channelRef = useRef(null);
  const activityRef = useRef({});
  const lastSentRef = useRef(0);
  const doingRef = useRef(null);
  // Read inside callbacks that must not be rebuilt every time these change.
  const meRef = useRef({ me, color, where });
  meRef.current = { me, color, where };

  // Expire anything that stopped updating.
  useEffect(() => {
    const sweep = () => {
      const now = Date.now();
      const kept = {};
      let dropped = false;
      for (const [id, act] of Object.entries(activityRef.current)) {
        if (now - act.at < ACTIVITY_TTL_MS) kept[id] = act;
        else dropped = true;
      }
      if (dropped) { activityRef.current = kept; setActivity(kept); }
    };
    // Browsers all but stop timers in a tab nobody is looking at, so a marker
    // can still be sitting there at the moment you come back to it. Sweep on
    // the way in as well, not just on the clock.
    const onVisible = () => { if (!document.hidden) sweep(); };
    const timer = setInterval(sweep, 1000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!me) return undefined;
    const selfId = selfIdRef.current;
    const channel = supabase.channel(`live:${room}`, { config: { presence: { key: selfId } } });
    channelRef.current = channel;

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const list = [];
        for (const [id, metas] of Object.entries(state)) {
          if (id === selfId) continue;
          const meta = metas[metas.length - 1] || {};
          list.push({ id, name: meta.name, color: meta.color, where: meta.where ?? null });
        }
        // Same person on a phone and a laptop is two entries; show one.
        list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        setPeers(list);
      })
      .on("broadcast", { event: "act" }, ({ payload }) => {
        if (!payload || !payload.id || payload.id === selfId) return;
        const next = { ...activityRef.current };
        if (payload.kind === "idle") delete next[payload.id];
        else next[payload.id] = { ...payload, at: Date.now() };
        activityRef.current = next;
        setActivity(next);
      })
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        const m = meRef.current;
        channel.track({ name: m.me, color: m.color, where: m.where }).catch(() => {});
      });

    return () => {
      channelRef.current = null;
      activityRef.current = {};
      supabase.removeChannel(channel);
    };
  }, [room, me]);

  // Opening or leaving a folder moves you to a different part of the board.
  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || channel.state !== "joined") return;
    channel.track({ name: me, color, where }).catch(() => {});
  }, [me, color, where]);

  // Tell everyone what this screen is doing. `throttled` for a stream of
  // positions, immediate for the one that starts or ends it — a dropped
  // "finished" message is what leaves a marker hanging.
  const signal = (payload, throttled = false) => {
    if (payload.kind !== "idle") doingRef.current = payload;
    const channel = channelRef.current;
    if (!channel || channel.state !== "joined") return;
    const now = Date.now();
    if (throttled && now - lastSentRef.current < BROADCAST_MS) return;
    lastSentRef.current = now;
    const m = meRef.current;
    channel
      .send({ type: "broadcast", event: "act", payload: { ...payload, id: selfIdRef.current, name: m.me, color: m.color, where: m.where } })
      .catch(() => { /* a lost frame just means one skipped tick */ });
  };

  const stop = () => {
    doingRef.current = null;
    signal({ kind: "idle" });
  };

  // Repeat whatever this screen is doing every couple of seconds. Peers drop a
  // marker that has gone quiet, which is what clears it when a phone sleeps or
  // a tab closes mid-drag — but someone holding an item still, or pausing in
  // the middle of a sentence, has not stopped, and shouldn't flicker away.
  useEffect(() => {
    const timer = setInterval(() => {
      if (doingRef.current) signal(doingRef.current);
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { peers, activity, signal, stop };
}
