import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabaseClient";
import { mergeState, deepEqual } from "./syncState";
import { useLiveBoard } from "./livePresence";
import Analytics, { AnalyticsIcon } from "./Analytics";
// Only pulled in when someone actually exports, so the 200KB doesn't sit in
// the bundle everyone downloads just to look at the board.
const loadHtml2Canvas = () => import("html2canvas").then((m) => m.default || m);
// Several megabytes of model, so it is fetched the first time somebody asks
// for it and never as part of opening the app. It runs on the phone or laptop
// itself: nothing is uploaded anywhere, and there is no per-image cost.
const loadBackgroundRemover = () => import("@imgly/background-removal").then((m) => m.removeBackground || m.default);
import {
  LayoutDashboard, ListChecks, CalendarDays, StickyNote, Video, Lightbulb,
  BookOpen, Plus, X, ChevronLeft, ChevronRight, ThumbsUp, MessageSquare,
  Trash2, CheckCircle2, Clock, AlertTriangle, Link2, Menu, Flame,
  Radio, Users, Pin, ExternalLink, Send, User, Pencil, Settings, Copy, Check, Lock, Shield, RotateCw, RotateCcw, ChevronUp, ChevronDown, Bell, Image, Layers, Upload, Play, Globe, Palette, Type as TypeIcon, Folder, FolderOpen,
  Minus, ArrowRight, Square, Circle, Bold, Italic, AlignLeft, AlignCenter, AlignRight, Smile, Crop, ClipboardPaste, Pipette, Search, Play as PlayIcon, Maximize2, Scissors, PenTool
} from "lucide-react";

/* ---------------------------------- helpers ---------------------------------- */

// Saving on every keystroke was pushing the whole shared board to Supabase per
// character, and the realtime echo racing back mid-typing could overwrite what
// was just typed — text would visibly flicker/revert. This buffers the value
// locally (so typing itself is instant) and only writes after a short pause.
function useDebouncedCallback(callback, delay) {
  const timer = useRef(null);
  const cbRef = useRef(callback);
  cbRef.current = callback;
  return (...args) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => cbRef.current(...args), delay);
  };
}

// Drag-to-reposition for the Idea Bank board — tracks a live position while
// the pointer moves, but only persists once (on release), so dragging never
// hammers the shared board with saves the way typing-per-keystroke did.
// Also tells clicks (no real movement) apart from drags, so a tap can open
// something instead of "moving" it by a pixel.
//
// onDragMove, if given, is called with every position while the drag is live
// and with null when it ends. Nothing is saved from it — it exists so other
// people's screens can show the thing moving as it moves.
function useDraggable(onDragEnd, onClick, onDragMove, getScale, snapTo) {
  const [dragging, setDragging] = useState(null); // { id, x, y }
  const posRef = useRef(null);
  const movedRef = useRef(false);
  const cleanupRef = useRef(null);

  // Navigating away mid-drag would otherwise leave window listeners attached.
  useEffect(() => () => { if (cleanupRef.current) cleanupRef.current(); }, []);

  const startDrag = (e, id, origX, origY) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const point = e.touches ? e.touches[0] : e;
    const startX = point.clientX;
    const startY = point.clientY;
    movedRef.current = false;
    posRef.current = { id, x: origX, y: origY };
    const box = e.currentTarget && e.currentTarget.getBoundingClientRect
      ? e.currentTarget.getBoundingClientRect()
      : null;
    const size = box ? { w: Math.round(box.width), h: Math.round(box.height) } : null;

    const move = (ev) => {
      const p = ev.touches ? ev.touches[0] : ev;
      // Once the board can be zoomed, a hundred pixels of mouse movement is no
      // longer a hundred pixels of board. Everything stored is in board
      // coordinates, so the screen distance is divided back down here — one
      // place, rather than at every call site.
      const scale = getScale ? getScale() || 1 : 1;
      const dx = (p.clientX - startX) / scale;
      const dy = (p.clientY - startY) / scale;
      if (Math.abs(dx * scale) > 4 || Math.abs(dy * scale) > 4) movedRef.current = true;
      let next = { id, x: Math.max(0, Math.round(origX + dx)), y: Math.max(0, Math.round(origY + dy)) };
      // The board gets to nudge the position onto a neighbour's edge. Holding
      // Alt turns that off, for the times the thing genuinely belongs slightly
      // off-line and the snapping is fighting you.
      if (snapTo && !ev.altKey) {
        const landed = snapTo(id, next.x, next.y, size);
        if (landed) next = { id, x: landed.x, y: landed.y };
      }
      posRef.current = next;
      setDragging(next);
      if (onDragMove) onDragMove({ id, x: next.x, y: next.y, ...(size || {}) });
    };
    const detach = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
      cleanupRef.current = null;
    };
    const end = () => {
      detach();
      if (snapTo) snapTo(null);   // take the guides off the board
      if (movedRef.current && posRef.current) onDragEnd(posRef.current.id, posRef.current.x, posRef.current.y, posRef.current.x - origX, posRef.current.y - origY);
      else if (!movedRef.current && onClick) onClick(id, e);
      posRef.current = null;
      setDragging(null);
      if (onDragMove) onDragMove(null);
    };
    cleanupRef.current = detach;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
  };

  return { dragging, startDrag };
}

const IDEA_COLORS = ["#F5D76E", "#F2A65A", "#F2789F", "#B79CED", "#7EC8E3", "#8FD9A8"];

// Every drawn shape is defined by the box you dragged, so they all share one
// description: two corners. These turn that box into the points each shape
// needs. Shapes saved before fill/width/opacity existed simply have none of
// those fields, and the defaults below are what they were being drawn with.
// Undo covers a mistake you notice straight away. This covers the other kind:
// someone clears a board on Tuesday and on Thursday you want it back. Kept in
// its own table — see supabase-history-schema.sql for why.
const HISTORY_EVERY_MS = 20 * 60 * 1000;   // at most one snapshot per 20 minutes
const HISTORY_KEEP = 60;
// The parts of the board the Idea Bank owns, so a board can be put back without
// dragging the calendar and the chat back with it.
const IDEA_BANK_KEYS = ["ideas", "ideaFolders", "boardItems", "ideaDrawings", "boardComments", "boardPalette", "boardSurfaces"];

async function takeSnapshot(board, who, note) {
  try {
    await supabase.from("hub_history").insert({ snapshot: board, taken_by: who || null, note: note || null });
    // Keep the newest, let the rest go. Done here rather than on a schedule so
    // there's nothing extra to deploy or remember.
    const { data: old } = await supabase
      .from("hub_history").select("id").order("taken_at", { ascending: false }).range(HISTORY_KEEP, HISTORY_KEEP + 40);
    if (old && old.length) await supabase.from("hub_history").delete().in("id", old.map((r) => r.id));
    return true;
  } catch {
    // A missing table just means the SQL hasn't been run yet; the board itself
    // must not care.
    return false;
  }
}

const SHAPE_DEFAULTS = { width: 3, fill: "none", opacity: 1 };

// What the board itself looks like behind everything. Dots are the default the
// board has always had; the plain and grid options are for when the dots fight
// with what's on top, and paper is for boards that get exported.
const BOARD_SURFACES = [
  { id: "dots", label: "Dots", ink: "#EDEBE3", paper: "var(--panel)", image: "radial-gradient(rgba(237,235,227,0.06) 1px, transparent 1px)", size: "22px 22px" },
  { id: "grid", label: "Grid", ink: "#EDEBE3", paper: "var(--panel)", image: "linear-gradient(rgba(237,235,227,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(237,235,227,0.055) 1px, transparent 1px)", size: "44px 44px" },
  { id: "plain", label: "Plain", ink: "#EDEBE3", paper: "var(--panel)", image: "none", size: "auto" },
  { id: "paper", label: "Paper", ink: "#22232b", paper: "#F4F1E8", image: "none", size: "auto" },
  { id: "slate", label: "Slate", ink: "#EDEBE3", paper: "#1B2430", image: "none", size: "auto" },
];
const surfaceOf = (id) => BOARD_SURFACES.find((sf) => sf.id === id) || BOARD_SURFACES[0];

// Three of these were already being loaded for the app's own chrome, so only
// the last two cost anything. Each is a different job: something to read,
// something with a bit of weight, something that looks handwritten, something
// that shouts.
const BOARD_FONTS = [
  { id: "sans", label: "Sans", stack: "'Inter', sans-serif" },
  { id: "serif", label: "Serif", stack: "'Fraunces', serif" },
  { id: "mono", label: "Mono", stack: "'IBM Plex Mono', monospace" },
  { id: "hand", label: "Hand", stack: "'Caveat', cursive" },
  { id: "poster", label: "Poster", stack: "'Anton', 'Inter', sans-serif" },
];
const fontStack = (id) => (BOARD_FONTS.find((f) => f.id === id) || BOARD_FONTS[0]).stack;
const TEXT_SIZES = [13, 16, 22, 30, 44];

// Emoji rather than image files: they need no upload, no storage, no Drive
// quota, and they render on every phone the team owns. Grouped the way people
// reach for them on a planning board.
const STICKER_GROUPS = [
  { label: "Marks", items: ["✅", "❌", "⭐", "❗", "❓", "🔥", "💡", "📌", "🎯", "⚡", "💯", "🚫"] },
  { label: "Making", items: ["🎬", "📷", "🎥", "🎙️", "✏️", "🎨", "💻", "📱", "🖼️", "🎞️", "🔊", "📝"] },
  { label: "People", items: ["🙂", "😎", "🤔", "🥳", "😅", "👀", "👏", "🙌", "🤝", "💪", "🧠", "☕"] },
  { label: "Time", items: ["📅", "⏰", "⏳", "🔁", "➡️", "⬅️", "⬆️", "⬇️", "🔝", "🏁", "📈", "📉"] },
];
const TEXT_DEFAULTS = { fontSize: 15, font: "sans", align: "left", bold: false, italic: false };

// Photo adjustment, the same way crop works: numbers recorded against the
// picture, never a change to the file in Drive. The browser does the work with
// CSS filters, which costs nothing, applies instantly and can be taken off
// again — and because it is only numbers, one photo's look can be copied onto
// another, and it all rides through undo like any other edit.
const PHOTO_DEFAULTS = { exposure: 0, contrast: 0, saturation: 0, warmth: 0, blur: 0, spin: 0 };
const PHOTO_SLIDERS = [
  { key: "exposure", label: "Exposure", min: -60, max: 60 },
  { key: "contrast", label: "Contrast", min: -60, max: 60 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
  { key: "warmth", label: "Warmth", min: -60, max: 60 },
  { key: "blur", label: "Blur", min: 0, max: 12 },
];
const PHOTO_PRESETS = [
  { id: "none", label: "Original", look: {} },
  { id: "bw", label: "B&W", look: { saturation: -100, contrast: 12 } },
  { id: "faded", label: "Faded", look: { contrast: -22, saturation: -25, exposure: 10 } },
  { id: "punchy", label: "Punchy", look: { contrast: 28, saturation: 30 } },
  { id: "warm", label: "Warm", look: { warmth: 34, exposure: 6, saturation: 10 } },
  { id: "cold", label: "Cold", look: { warmth: -34, saturation: -8, contrast: 8 } },
];

// How an element sits against what's behind it. Multiply darkens through,
// screen lightens through, overlay does both — the three that actually get used
// for laying a texture or a colour wash over a photo.
const BLEND_MODES = [
  { id: "normal", label: "Normal" },
  { id: "multiply", label: "Multiply" },
  { id: "screen", label: "Screen" },
  { id: "overlay", label: "Overlay" },
  { id: "soft-light", label: "Soft light" },
  { id: "difference", label: "Difference" },
];
// Cutting a picture to a shape without touching the file: the browser clips it.
const MASK_SHAPES = [
  { id: "none", label: "Square", css: null },
  { id: "circle", label: "Circle", css: "circle(50% at 50% 50%)" },
  { id: "rounded", label: "Rounded", css: "inset(0 round 18px)" },
  { id: "bubble", label: "Bubble", css: "inset(0 round 40% 40% 40% 8px)" },
  { id: "diamond", label: "Diamond", css: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)" },
  { id: "arch", label: "Arch", css: "inset(0 round 50% 50% 6px 6px)" },
];
const maskCss = (id) => (MASK_SHAPES.find((m) => m.id === id) || MASK_SHAPES[0]).css;

// A curve through a run of points. Catmull-Rom converted to cubic Béziers, so
// every point the person placed is actually on the line — which is what they
// expect, and is not true of a plain Bézier where the middle points only pull
// at it. It also means each point can be dragged afterwards and the curve
// simply re-forms, with no separate handles to understand.
const curveThrough = (pts) => {
  if (!pts || pts.length < 2) return "";
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  const at = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
};
const SHADOWS = [
  { id: "none", label: "None", css: "none" },
  { id: "soft", label: "Soft", css: "drop-shadow(0 6px 14px rgba(0,0,0,0.45))" },
  { id: "hard", label: "Hard", css: "drop-shadow(5px 5px 0 rgba(0,0,0,0.65))" },
  { id: "glow", label: "Glow", css: "drop-shadow(0 0 12px rgba(255,255,255,0.55))" },
  { id: "outline", label: "Outline", css: "drop-shadow(0 0 1px #000) drop-shadow(0 0 1px #000) drop-shadow(0 0 1px #000)" },
];
const shadowCss = (id) => (SHADOWS.find((sh) => sh.id === id) || SHADOWS[0]).css;

const photoLook = (b) => ({ ...PHOTO_DEFAULTS, ...(b && b.look ? b.look : {}) });
const hasLook = (b) => {
  const look = photoLook(b);
  return PHOTO_SLIDERS.some(({ key }) => look[key] !== PHOTO_DEFAULTS[key]);
};
// Percentages rather than raw filter values, so a slider at zero is genuinely
// "leave it alone" and the numbers mean something when read back.
const photoFilter = (b) => {
  const l = photoLook(b);
  const parts = [];
  if (l.exposure) parts.push(`brightness(${1 + l.exposure / 100})`);
  if (l.contrast) parts.push(`contrast(${1 + l.contrast / 100})`);
  if (l.saturation) parts.push(`saturate(${Math.max(0, 1 + l.saturation / 100)})`);
  // Warmth has no filter of its own: a little hue rotation plus sepia leans an
  // image warm or cold convincingly enough for a mood board.
  if (l.warmth > 0) parts.push(`sepia(${l.warmth / 160}) saturate(${1 + l.warmth / 200})`);
  if (l.warmth < 0) parts.push(`hue-rotate(${l.warmth / 6}deg) saturate(${1 + -l.warmth / 300})`);
  if (l.blur) parts.push(`blur(${l.blur / 4}px)`);
  return parts.length ? parts.join(" ") : "none";
};

// Starter layouts. Each returns plain board items and shapes — nothing a
// person couldn't have placed by hand — so a template can be rearranged,
// restyled and undone like anything else rather than being a special object
// with its own rules.
const heading = (text, x, y, size = 30) => ({ type: "text", x, y, w: 320, text, font: "poster", fontSize: size, color: "#EDEBE3", align: "left" });
const note = (text, x, y, bg) => ({ type: "text", x, y, w: 170, text, bg, color: "#22232b", font: "hand", fontSize: 17, align: "left" });
const label = (text, x, y) => ({ type: "text", x, y, w: 200, text, font: "sans", fontSize: 16, bold: true, color: "#EDEBE3", align: "left" });
const frame = (x, y, w, h, color) => ({ tool: "rect", x1: x, y1: y, x2: x + w, y2: y + h, color, width: 2, fill: "none", opacity: 0.9 });

const BOARD_TEMPLATES = [
  {
    id: "mood", name: "Mood board", blurb: "Three panels to drop reference shots into, with room for notes.",
    build: () => ({
      items: [
        heading("MOOD", 40, 30),
        label("Look", 60, 110), label("Colour", 500, 110), label("Type", 940, 110),
        note("What feeling are we after?", 60, 470, IDEA_COLORS[0]),
        note("What are we avoiding?", 260, 470, IDEA_COLORS[2]),
      ],
      shapes: [frame(50, 140, 400, 300, IDEA_COLORS[4]), frame(490, 140, 400, 300, IDEA_COLORS[5]), frame(930, 140, 400, 300, IDEA_COLORS[3])],
    }),
  },
  {
    id: "storyboard", name: "Storyboard", blurb: "Six frames in a row of three, each with a line for the beat.",
    build: () => {
      const items = [heading("STORYBOARD", 40, 30)];
      const shapes = [];
      for (let i = 0; i < 6; i++) {
        const x = 50 + (i % 3) * 440, y = 120 + Math.floor(i / 3) * 350;
        shapes.push(frame(x, y, 400, 225, IDEA_COLORS[4]));
        items.push({ type: "text", x, y: y + 235, w: 400, text: `${i + 1}. `, font: "sans", fontSize: 15, color: "#EDEBE3", align: "left" });
      }
      return { items, shapes };
    },
  },
  {
    id: "campaign", name: "Campaign plan", blurb: "Idea to posted, as four columns you move notes across.",
    build: () => {
      const cols = ["IDEA", "SHOOT", "EDIT", "POST"];
      const items = [heading("CAMPAIGN", 40, 30)];
      const shapes = [];
      cols.forEach((c, i) => {
        const x = 50 + i * 330;
        items.push(label(c, x + 12, 115));
        shapes.push(frame(x, 105, 300, 680, IDEA_COLORS[i % IDEA_COLORS.length]));
      });
      items.push(note("Drag notes across as they move along", 62, 160, IDEA_COLORS[0]));
      return { items, shapes };
    },
  },
  {
    id: "shotlist", name: "Shot list", blurb: "A numbered column to fill in before a shoot day.",
    build: () => {
      const items = [heading("SHOT LIST", 40, 30), label("Shot", 60, 110), label("Who / where", 420, 110)];
      for (let i = 0; i < 6; i++) {
        items.push(note(`${i + 1}.`, 60, 150 + i * 105, IDEA_COLORS[i % IDEA_COLORS.length]));
        items.push({ type: "text", x: 420, y: 160 + i * 105, w: 300, text: "", font: "sans", fontSize: 15, color: "#EDEBE3", align: "left" });
      }
      return { items, shapes: [] };
    },
  },
];

// Everything a text box needs to look the same while you're editing it as it
// does when you're done — used by both the textarea and the finished box, so
// the two can't drift apart.
const textStyleOf = (b) => ({
  fontFamily: fontStack(b.font),
  fontSize: typeof b.fontSize === "number" ? b.fontSize : TEXT_DEFAULTS.fontSize,
  fontWeight: b.bold ? 800 : b.font === "poster" ? 400 : 500,
  fontStyle: b.italic ? "italic" : "normal",
  textAlign: b.align || TEXT_DEFAULTS.align,
  lineHeight: b.font === "hand" ? 1.25 : 1.4,
});
const STROKE_WIDTHS = [1, 3, 6, 12];

const shapeBox = (s) => ({
  left: Math.min(s.x1, s.x2), top: Math.min(s.y1, s.y2),
  w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1),
});

// Body plus a tail hanging off the bottom-left, the way a comment bubble reads.
const bubblePath = (s) => {
  const { left, top, w, h } = shapeBox(s);
  const bodyH = Math.max(h * 0.75, 1);
  const r = Math.min(10, w / 2, bodyH / 2);
  const tailX = left + Math.min(w * 0.3, 40);
  return [
    `M ${left + r} ${top}`,
    `H ${left + w - r} A ${r} ${r} 0 0 1 ${left + w} ${top + r}`,
    `V ${top + bodyH - r} A ${r} ${r} 0 0 1 ${left + w - r} ${top + bodyH}`,
    `H ${tailX + 18}`,
    `L ${tailX} ${top + h}`,
    `L ${tailX + 4} ${top + bodyH}`,
    `H ${left + r} A ${r} ${r} 0 0 1 ${left} ${top + bodyH - r}`,
    `V ${top + r} A ${r} ${r} 0 0 1 ${left + r} ${top} Z`,
  ].join(" ");
};

// The head sits at the end you dragged to, turned to face the way you dragged.
const arrowHeadPoints = (s, width) => {
  const size = Math.max(9, width * 3);
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const wing = 2.6;
  const p = (a, len) => `${s.x2 - Math.cos(a) * len},${s.y2 - Math.sin(a) * len}`;
  return `${s.x2},${s.y2} ${p(angle - Math.PI / wing, size)} ${p(angle + Math.PI / wing, size)}`;
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Links people paste into a message should be tappable rather than something
// you have to select and copy by hand on a phone.
//
// The match is deliberately narrow — http://, https://, or a bare www. — and
// the trailing character class drops the full stop or bracket that ends a
// sentence rather than swallowing it into the URL. Nothing else can become an
// href, so a "javascript:" someone types stays plain text.
const LINK_RE = new RegExp("((?:https?://|www\\.)[^\\s<>()]*[^\\s<>().,;:!?'\"])", "gi");

function Linkify({ text }) {
  // split() on a regex with one capture group alternates plain, match, plain…
  const parts = String(text == null ? "" : text).split(LINK_RE);
  return parts.map((part, i) => {
    if (i % 2 === 0) return part;
    const href = part.toLowerCase().startsWith("www.") ? `https://${part}` : part;
    return (
      <a
        key={i}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(ev) => ev.stopPropagation()}
        style={{ color: "inherit", textDecoration: "underline", wordBreak: "break-word" }}
      >
        {part}
      </a>
    );
  });
}

// Votes are a list of who voted, not a tally. A bare number meant one person
// could tap the button ten times, and — because two screens both read "4" and
// both wrote "5" — two people voting at once counted as one. A list of names
// has neither problem: the merge in syncState.js keeps both names, and tapping
// again takes your own name back off.
const voteList = (idea) => (Array.isArray(idea.votes) ? idea.votes : []);
const voteCount = (idea) =>
  Array.isArray(idea.votes) ? idea.votes.length
  : typeof idea.votes === "number" ? Math.max(0, Math.floor(idea.votes))
  : 0;
const hasVoted = (idea, profile) => voteList(idea).some((v) => v.id === profile);
// An idea saved back when votes were a number keeps its score: each one becomes
// an anonymous entry so the count nobody expects to change doesn't drop. They
// can't be un-cast, which is right — there's no record of whose they were.
const withVoteList = (idea) => {
  if (Array.isArray(idea.votes)) return idea;
  const count = voteCount(idea);
  return { ...idea, votes: Array.from({ length: count }, (_, i) => ({ id: `earlier-${i + 1}`, legacy: true })) };
};
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const daysUntil = (iso) => {
  const d = new Date(iso + "T00:00:00");
  const t = new Date(todayISO() + "T00:00:00");
  return Math.round((d - t) / 86400000);
};
const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const STATUS = [
  { id: "todo", label: "To Do", color: "var(--muted)" },
  { id: "progress", label: "In Progress", color: "var(--gold)" },
  { id: "review", label: "In Review", color: "var(--teal)" },
  { id: "done", label: "Done", color: "var(--good)" },
];
const PRIORITY = [
  { id: "low", label: "Low", color: "var(--teal)" },
  { id: "medium", label: "Medium", color: "var(--gold)" },
  { id: "high", label: "High", color: "var(--alert)" },
];
const CONTENT_STATUS = [
  { id: "draft", label: "Draft", color: "var(--muted)" },
  { id: "review", label: "Needs Review", color: "var(--gold)" },
  { id: "approved", label: "Approved", color: "var(--teal)" },
  { id: "published", label: "Published", color: "var(--good)" },
];
const CAL_STATUS = [
  // Comes first because it's the earliest a thing can be: the time is spoken
  // for, but what happens in it hasn't been decided yet.
  { id: "toplan", label: "Not planned yet", color: "var(--muted)", unplanned: true },
  { id: "planned", label: "Planned", color: "var(--muted)" },
  { id: "ready", label: "Ready to post", color: "var(--gold)" },
  { id: "posted", label: "Done / posted", color: "var(--good)", done: true },
  { id: "skipped", label: "Skipped", color: "var(--alert)", dismissed: true },
];
// Named rather than "the first one", so adding a status ahead of it can't
// silently reclassify every event that predates the field.
const CAL_STATUS_FALLBACK = CAL_STATUS.find((s) => s.id === "planned");
const calStatus = (e) => CAL_STATUS.find((s) => s.id === e.status) || CAL_STATUS_FALLBACK;

// The status used to be a 6px dot, which told you there was a status but not
// which one unless you remembered what each colour meant. Something finished
// now gets a tick and fades back; something skipped gets a cross and is struck
// through. Both stay in place rather than disappearing, so the day still reads
// as what was planned for it.
function EventMark({ status, size = 12, onToggle }) {
  const mark = status.done ? (
    <Check size={size} strokeWidth={3.5} style={{ flexShrink: 0 }} />
  ) : status.dismissed ? (
    <X size={size - 1} strokeWidth={3} style={{ flexShrink: 0 }} />
  ) : status.unplanned ? (
    // A hollow ring: something is pencilled in here, but nothing is decided.
    <span style={{ width: 7, height: 7, borderRadius: "50%", border: "1.5px solid currentColor", opacity: 0.65, flexShrink: 0, display: "inline-block" }} />
  ) : (
    <span className="evt-dot" style={{ background: status.color, width: 6, height: 6 }} />
  );
  if (!onToggle) return mark;
  // Ticking something off was three taps — open it, change the dropdown, save —
  // which is enough friction that nobody does it and the marks stay meaningless.
  // The mark itself is the button. The padding/negative-margin pair buys a
  // finger-sized hit area without moving anything around it.
  return (
    <button
      type="button"
      title={status.done ? "Mark as not done" : "Mark as done"}
      aria-label={status.done ? "Mark as not done" : "Mark as done"}
      onClick={(ev) => { ev.stopPropagation(); onToggle(); }}
      onMouseDown={(ev) => ev.stopPropagation()}
      style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 7, margin: -7, display: "inline-flex", alignItems: "center", flexShrink: 0 }}
    >
      {mark}
    </button>
  );
}
// Finished work shouldn't shout as loudly as what's still to do, and something
// with nothing planned in it yet shouldn't read as a commitment.
const doneStyle = (status) => ({
  opacity: status.done ? 0.72 : status.dismissed ? 0.5 : 1,
  textDecoration: status.dismissed ? "line-through" : "none",
  fontStyle: status.unplanned ? "italic" : "normal",
});
const TASK_TYPES = [
  { id: "film", label: "Film", verb: "Film", icon: Video, color: "var(--gold)" },
  { id: "edit", label: "Edit", verb: "Edit", icon: Pencil, color: "var(--teal)" },
  { id: "write", label: "Write", verb: "Write", icon: StickyNote, color: "var(--good)" },
  { id: "post", label: "Post", verb: "Post", icon: Send, color: "var(--alert)" },
  { id: "review", label: "Review", verb: "Review", icon: CheckCircle2, color: "var(--muted)" },
  { id: "other", label: "Other", verb: "Do", icon: ListChecks, color: "var(--muted)" },
];

const STEP_TEMPLATES = {
  film: ["Check the brief or idea reference", "Charge batteries & pack gear", "Confirm location or subject", "Shoot the footage"],
  edit: ["Import and organize footage", "Build a rough cut", "Add captions, music, or graphics", "Export and share the draft"],
  write: ["Outline the key points", "Write a first draft", "Edit for tone and length", "Get a second pair of eyes"],
  post: ["Do a final review of the asset", "Write the caption", "Add hashtags or tags", "Schedule or publish"],
  review: ["Watch or read through fully", "Note specific timestamps or lines", "Leave clear feedback", "Confirm the status update"],
  other: ["Break this into one small first step", "Do that step", "Check in if you get stuck"],
};
const defaultSteps = (type) => (STEP_TEMPLATES[type] || STEP_TEMPLATES.other).map((text) => ({ id: uid(), text, done: false }));

const CONTENT_FORMATS = [
  { id: "video", label: "Video / Reel", icon: Video, color: "var(--gold)" },
  { id: "photo", label: "Photo", icon: Image, color: "var(--teal)" },
  { id: "graphic", label: "Graphic", icon: Layers, color: "var(--good)" },
];

const CONTENT_STEP_TEMPLATES = {
  video: [
    { text: "Plan the shot list or script", tip: "Keep it to 3–5 beats — over-planning slows down filming." },
    { text: "Film the footage", tip: "Grab a bit more footage than you think you need for the edit." },
    { text: "Edit the rough cut", tip: "Cut the first 1.5 seconds hard — that's where people scroll past." },
    { text: "Add captions, music, or graphics", tip: "Auto-captions first, then clean up typos by hand." },
    { text: "Write the caption", tip: "Lead with a question or a bold claim, not a summary." },
    { text: "Final review", tip: "Watch it once with sound off — does it still make sense?" },
    { text: "Schedule or publish", tip: "Check the platform's peak times before posting." },
  ],
  photo: [
    { text: "Plan the shot or set", tip: "One clear focal point beats a busy frame." },
    { text: "Shoot the photo(s)", tip: "Take a few angles — cropping later can save an average shot." },
    { text: "Select and edit the best shot", tip: "Consistent color grading keeps the feed cohesive." },
    { text: "Write the caption", tip: "A photo carries less context than video — the caption does more work." },
    { text: "Final review", tip: "Check it at thumbnail size — does it still read clearly?" },
    { text: "Schedule or publish", tip: "Pair with a handful of relevant tags, not dozens." },
  ],
  graphic: [
    { text: "Sketch the layout or message", tip: "One key message per graphic — resist adding more." },
    { text: "Design the graphic", tip: "Stick to the brand fonts and colors from Guidelines." },
    { text: "Proofread all text on it", tip: "Get a second pair of eyes — typos on graphics are highly visible." },
    { text: "Write the caption", tip: "The caption can add context the graphic doesn't have room for." },
    { text: "Final review", tip: "Export at the right size for the platform before uploading." },
    { text: "Schedule or publish", tip: "Save the source file somewhere the team can find it later." },
  ],
};
const defaultContentSteps = (format) => (CONTENT_STEP_TEMPLATES[format] || CONTENT_STEP_TEMPLATES.video).map((s) => ({ id: uid(), text: s.text, tip: s.tip, done: false }));

function makeNotification({ toProfile, type, text, link, fromProfile }) {
  return { id: uid(), toProfile: toProfile || null, type, text, link, date: todayISO(), readBy: fromProfile ? [fromProfile] : [] };
}

// Fires a real lock-screen push notification via the /api/send-push serverless function.
// toProfile: a profile name to target one person, or null to notify everyone subscribed.
// fromProfile: who triggered this — excluded from a broadcast so people don't get
// pushed a lock-screen alert about their own message/announcement.
function sendPush(toProfile, title, body, fromProfile) {
  try {
    fetch("/api/send-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toProfile, title, body, fromProfile }),
    }).catch(() => {});
  } catch {
    // push is best-effort — never block the app if it fails
  }
}

function buildExamples() {
  return {
    tasks: [
      { id: uid(), title: "Example: Reels for this week's post", description: "This is what a duty looks like — reassign it to a teammate and drag it through the board.", assignee: "Example", dueDate: todayISO(), status: "progress", priority: "high", type: "edit", steps: [{ id: uid(), text: "Import and organize footage", done: true }, ...defaultSteps("edit").slice(1)] },
      { id: uid(), title: "Example: Caption copy", description: "Duties move through columns: To Do → In Progress → In Review → Done.", assignee: "Example", dueDate: addDays(1), status: "todo", priority: "medium", type: "write", steps: defaultSteps("write") },
      { id: uid(), title: "Example: Approve final thumbnail", description: "", assignee: "Example", dueDate: addDays(2), status: "review", priority: "low", type: "review", steps: defaultSteps("review") },
      { id: uid(), title: "Example: Publish launch post", description: "Overdue duties show up in red, like this one.", assignee: "Example", dueDate: addDays(-1), status: "todo", priority: "high", type: "post", steps: defaultSteps("post") },
    ],
    calendarEvents: [
      { id: uid(), title: "Example: Publish product post", date: todayISO(), time: "09:00", type: "post", status: "ready", notes: "Caption is drafted, waiting on final approval." },
      { id: uid(), title: "Example: Content sync", date: todayISO(), time: "14:00", type: "meeting", status: "planned", notes: "Weekly check-in on what's shipping." },
      { id: uid(), title: "Example: Script due", date: addDays(1), time: "18:00", type: "deadline", status: "planned", notes: "" },
      { id: uid(), title: "Example: Behind-the-scenes story", date: addDays(2), time: "11:00", type: "post", status: "posted", notes: "Posted — this dot turns green once it's live." },
      { id: uid(), title: "Example: Shoot day", date: addDays(3), time: "16:00", type: "other", status: "planned", notes: "Bring the extra battery packs." },
    ],
    notes: [
      { id: uid(), text: "This is a pinned note — use these for reminders the whole team should see the moment they open the app.", author: "Example", date: todayISO(), color: "gold", pinned: true },
      { id: uid(), text: "Notes are quick and shared — good for context, not full documents. Longer references belong in Guidelines.", author: "Example", date: todayISO(), color: "teal", pinned: false },
    ],
    content: [
      {
        id: uid(), title: "Example: Launch teaser", platform: "TikTok", link: "", assignee: "Example", status: "review", format: "video",
        caption: "", steps: defaultContentSteps("video").map((s, i) => ({ ...s, done: i < 2 })),
        comments: [{ id: uid(), author: "Example", text: "This is what feedback looks like — click into a content card to leave notes like this one.", date: todayISO() }],
      },
    ],
    ideas: [
      { id: uid(), title: "Example idea: Behind-the-scenes series", description: "Anyone can pitch an idea here — the team upvotes what to make next.", tags: ["Example"], votes: 3, author: "Example" },
    ],
    resources: [
      { id: uid(), title: "Brand Voice Guide", description: "Tone, vocabulary, and phrases to avoid across every channel.", link: "", category: "Guidelines" },
      { id: uid(), title: "Posting Checklist", description: "Alt text, captions, hashtags, link-in-bio — the pre-publish pass.", link: "", category: "Guidelines" },
      { id: uid(), title: "Hashtag Bank", description: "Approved tag sets by content pillar, updated monthly.", link: "", category: "Assets" },
      { id: uid(), title: "Brand Asset Library", description: "Logos, fonts, colour codes, lower-third templates.", link: "", category: "Assets" },
    ],
  };
}

const seedData = () => ({
  adminCode: "",
  profiles: [],
  deletedTasks: [],
  messages: [],
  projects: [],
  notifications: [],
  tasks: [
    { id: uid(), title: "Reels for product launch", description: "3 vertical cuts from the studio B-roll, captions burned in.", assignee: "Jordan", dueDate: todayISO(), status: "progress", priority: "high", type: "edit", steps: [{ id: uid(), text: "Import and organize footage", done: true }, { id: uid(), text: "Build a rough cut", done: false }, { id: uid(), text: "Add captions, music, or graphics", done: false }, { id: uid(), text: "Export and share the draft", done: false }] },
    { id: uid(), title: "Carousel copy — Q3 recap", description: "10-slide carousel, tone: confident, data-forward.", assignee: "Sam", dueDate: todayISO(), status: "review", priority: "medium", type: "write", steps: defaultSteps("write") },
    { id: uid(), title: "Community reply sweep", description: "Clear comment queue across IG + TikTok.", assignee: "Priya", dueDate: todayISO(), status: "todo", priority: "low", type: "other", steps: defaultSteps("other") },
    { id: uid(), title: "Thumbnail set — creator interview", description: "3 thumbnail options, A/B test on YouTube.", assignee: "Alex", dueDate: todayISO(), status: "done", priority: "medium", type: "edit", steps: defaultSteps("edit").map((s) => ({ ...s, done: true })) },
    { id: uid(), title: "Posting calendar — next sprint", description: "Two-week grid across all channels.", assignee: "Jordan", dueDate: todayISO(), status: "todo", priority: "high", type: "write", steps: defaultSteps("write") },
  ],
  calendarEvents: [
    { id: uid(), title: "Product launch post — all channels", date: todayISO(), time: "09:00", type: "post", assignee: "Jordan", status: "planned" },
    { id: uid(), title: "Content review sync", date: todayISO(), time: "18:00", type: "meeting", assignee: "", status: "planned" },
  ],
  meetingItems: [
    { id: uid(), text: "Review the new hook format results before next sprint", author: "Team Lead", date: todayISO(), done: false },
  ],
  announcements: [
    { id: uid(), text: "Welcome to Broadcast Desk — this is where team news and heads-up messages will show.", author: "Team Lead", date: todayISO() },
  ],
  goals: {
    teamWeeklyTarget: 6,
    individualTargets: {},
  },
  notes: [
    { id: uid(), text: "Reminder: new hook format is testing well on Reels — keep the first 1.5s a question or a bold claim.", author: "Team Lead", date: todayISO(), color: "gold", pinned: true },
    { id: uid(), text: "Client wants fewer stock transitions, more handheld feel for BTS content.", author: "Sam", date: todayISO(), color: "teal", pinned: false },
  ],
  content: [
    {
      id: uid(), title: "Launch teaser — 15s cut", platform: "TikTok", format: "video", caption: "",
      link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", assignee: "Jordan", status: "review",
      steps: defaultContentSteps("video").map((s, i) => ({ ...s, done: i < 3 })),
      comments: [
        { id: uid(), author: "Team Lead", text: "Great pacing. Trim the last 2 seconds and boost the audio on the hook line.", date: todayISO() },
      ],
    },
    {
      id: uid(), title: "Founder story — carousel", platform: "Instagram", format: "photo", caption: "",
      link: "", assignee: "Sam", status: "draft", steps: defaultContentSteps("photo"), comments: [],
    },
  ],
  ideas: [
    { id: uid(), title: "Day-in-the-life of the editing team", description: "Behind the scenes of how a post goes from brief to published.", tags: ["BTS", "Reels"], votes: 4, author: "Priya", link: "" },
    { id: uid(), title: "Myth-busting series for our category", description: "Short-form series knocking down 5 common misconceptions.", tags: ["Series", "Educational"], votes: 6, author: "Alex", link: "" },
    { id: uid(), title: "Duet reaction to top comment each week", description: "Turns community feedback into content, builds loyalty.", tags: ["Community"], votes: 2, author: "Jordan", link: "" },
  ],
  resources: [
    { id: uid(), title: "Brand Voice Guide", description: "Tone, vocabulary, and phrases to avoid across every channel.", link: "", category: "Guidelines" },
    { id: uid(), title: "Posting Checklist", description: "Alt text, captions, hashtags, link-in-bio — the pre-publish pass.", link: "", category: "Guidelines" },
    { id: uid(), title: "Hashtag Bank", description: "Approved tag sets by content pillar, updated monthly.", link: "", category: "Assets" },
    { id: uid(), title: "Brand Asset Library", description: "Logos, fonts, colour codes, lower-third templates.", link: "", category: "Assets" },
  ],
});

/* ---------------------------------- CSS ---------------------------------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Caveat:wght@500;700&family=Anton&display=swap');

:root{
  --ink:#12141B; --panel:#191C25; --panel-raised:#20232D; --hair: rgba(237,235,227,0.09);
  --text:#EDEBE3; --muted:#8B8E9C; --gold:#C9A24B; --gold-soft:rgba(201,162,75,0.16);
  --teal:#4FB8A6; --teal-soft:rgba(79,184,166,0.14); --alert:#D9564B; --alert-soft:rgba(217,86,75,0.15);
  --good:#6FBE7A; --good-soft:rgba(111,190,122,0.14);
}
html, body{ overflow-x:hidden; max-width:100%; }
body{ font-family:'Inter',sans-serif; color:var(--text); background:var(--ink); margin:0; }
.hub{
  font-family:'Inter',sans-serif; color:var(--text); background:var(--ink);
  min-height:100vh; display:flex; position:relative; isolation:isolate; overflow-x:hidden;
}
.hub *{ box-sizing:border-box; }
.hub .display{ font-family:'Fraunces',serif; }
.hub .mono{ font-family:'IBM Plex Mono',monospace; }
.hub::before{
  content:''; position:fixed; inset:0; pointer-events:none; z-index:0; opacity:0.5;
  background-image: radial-gradient(rgba(237,235,227,0.045) 1px, transparent 1px);
  background-size: 3px 3px;
}
.hub button{ font-family:inherit; cursor:pointer; }
.hub input, .hub textarea, .hub select{ font-family:inherit; }
.hub ::selection{ background:var(--gold-soft); color:var(--text); }

/* ---- sidebar ---- */
.sidebar{
  width:230px; flex-shrink:0; background:var(--panel); border-right:1px solid var(--hair);
  display:flex; flex-direction:column; padding:22px 14px; position:sticky; top:0; height:100vh; z-index:5;
  overflow-y:auto;
}
.brand{ display:flex; align-items:center; gap:9px; padding:4px 8px 22px; border-bottom:1px solid var(--hair); margin-bottom:14px; }
.brand-dot{ width:9px; height:9px; border-radius:50%; background:var(--alert); box-shadow:0 0 8px var(--alert); flex-shrink:0; }
.brand-text{ font-size:14.5px; letter-spacing:0.02em; font-weight:600; }
.brand-sub{ font-size:10px; color:var(--muted); letter-spacing:0.14em; text-transform:uppercase; margin-top:1px; }
.nav-item{
  display:flex; align-items:center; gap:11px; padding:9px 10px; border-radius:7px; border:none;
  background:transparent; color:var(--muted); font-size:13.5px; font-weight:500; text-align:left; width:100%;
  transition:background .15s, color .15s; margin-bottom:2px;
}
.nav-item:hover{ background:var(--panel-raised); color:var(--text); }
.nav-item.active{ background:var(--gold-soft); color:var(--gold); }
.nav-item svg{ flex-shrink:0; }
.sidebar-foot{ margin-top:auto; padding:12px 8px 2px; border-top:1px solid var(--hair); font-size:10.5px; color:var(--muted); }
.live-tag{ display:inline-flex; align-items:center; gap:5px; color:var(--alert); font-weight:600; letter-spacing:0.08em; }
.live-tag .dot{ width:6px; height:6px; border-radius:50%; background:var(--alert); animation:pulse 1.8s infinite; }
@keyframes pulse{ 0%,100%{opacity:1;} 50%{opacity:.35;} }

/* ---- main ---- */
.main{ flex:1; min-width:0; padding:30px 38px 60px; position:relative; z-index:1; }
.topbar{ display:flex; align-items:center; justify-content:space-between; margin-bottom:26px; gap:16px; flex-wrap:wrap; }
.page-title{ font-size:26px; font-weight:600; }
.page-sub{ color:var(--muted); font-size:13px; margin-top:3px; }
.btn{
  display:inline-flex; align-items:center; gap:7px; padding:9px 15px; border-radius:7px; border:1px solid var(--hair);
  background:var(--panel-raised); color:var(--text); font-size:13px; font-weight:600; transition:border-color .15s, transform .1s;
}
.btn:hover{ border-color:var(--gold); }
.btn:active{ transform:scale(0.97); }
.btn-gold{ background:var(--gold); color:#171812; border-color:var(--gold); }
.btn-gold:hover{ opacity:0.92; border-color:var(--gold); }
.btn-ghost{ background:transparent; border-color:transparent; color:var(--muted); padding:7px 9px; }
.btn-ghost:hover{ color:var(--text); background:var(--panel-raised); }

.card{ background:var(--panel); border:1px solid var(--hair); border-radius:12px; padding:20px; }
.grid{ display:grid; gap:16px; }

/* ---- dashboard ---- */
.hero{ background:linear-gradient(135deg, var(--panel) 0%, var(--panel-raised) 100%); border:1px solid var(--hair); border-radius:14px; padding:28px 30px; display:flex; align-items:center; gap:34px; flex-wrap:wrap; margin-bottom:22px; position:relative; overflow:hidden; }
.ring-wrap{ position:relative; width:118px; height:118px; flex-shrink:0; }
.ring-num{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
.ring-num .n{ font-size:26px; font-weight:700; font-family:'Fraunces',serif; }
.ring-num .l{ font-size:9.5px; color:var(--muted); letter-spacing:0.1em; text-transform:uppercase; margin-top:2px; }
.hero-stats{ display:flex; gap:30px; flex-wrap:wrap; }
.hstat .n{ font-size:24px; font-weight:700; font-family:'Fraunces',serif; line-height:1; }
.hstat .l{ font-size:11px; color:var(--muted); margin-top:5px; letter-spacing:0.03em; }

.stat-grid{ grid-template-columns:repeat(auto-fit, minmax(220px,1fr)); margin-bottom:22px; }
.stat-card{ display:flex; flex-direction:column; gap:8px; }
.stat-card .top{ display:flex; align-items:center; justify-content:space-between; }
.stat-card .label{ font-size:11.5px; color:var(--muted); text-transform:uppercase; letter-spacing:0.07em; font-weight:600; }
.progress-track{ height:7px; border-radius:4px; background:var(--panel-raised); overflow:hidden; }
.progress-fill{ height:100%; border-radius:4px; transition:width .4s ease; }

.two-col{ grid-template-columns:1.3fr 1fr; align-items:start; }
@media (max-width: 900px){ .two-col{ grid-template-columns:1fr; } }
.section-title{ font-size:15px; font-weight:600; margin-bottom:14px; display:flex; align-items:center; gap:8px; }
.deadline-row{ display:flex; align-items:center; gap:11px; padding:10px 0; border-bottom:1px solid var(--hair); }
.deadline-row:last-child{ border-bottom:none; }
.deadline-badge{ font-size:10.5px; font-weight:600; padding:3px 8px; border-radius:5px; white-space:nowrap; }
.member-row{ margin-bottom:14px; }
.member-row:last-child{ margin-bottom:0; }
.member-row .mtop{ display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:6px; }
.member-row .mtop .name{ font-weight:600; }
.member-row .mtop .frac{ color:var(--muted); }

/* ---- board ---- */
.filter-row{ display:flex; gap:8px; margin-bottom:18px; flex-wrap:wrap; }
.chip{ padding:6px 13px; border-radius:20px; border:1px solid var(--hair); background:var(--panel); color:var(--muted); font-size:12px; font-weight:600; }
.chip.active{ border-color:var(--gold); color:var(--gold); background:var(--gold-soft); }
.board{ display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; align-items:start; }
@media (max-width: 1050px){ .board{ grid-template-columns:1fr 1fr; } }
@media (max-width: 620px){ .board{ grid-template-columns:1fr; } }
.col{ background:var(--panel); border:1px solid var(--hair); border-radius:12px; padding:14px; min-height:80px; }
.col-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
.col-head .t{ font-size:12.5px; font-weight:700; letter-spacing:0.03em; }
.col-head .c{ font-size:11px; color:var(--muted); background:var(--panel-raised); padding:2px 7px; border-radius:10px; }
.task-card{ background:var(--panel-raised); border:1px solid var(--hair); border-radius:9px; padding:12px; margin-bottom:10px; position:relative; border-left-width:3px; }
.task-card:last-child{ margin-bottom:0; }
.task-card .tt{ font-size:13px; font-weight:600; margin-bottom:5px; line-height:1.35; }
.task-card .td{ font-size:11.5px; color:var(--muted); line-height:1.4; margin-bottom:10px; }
.task-meta{ display:flex; align-items:center; justify-content:space-between; gap:6px; }
.avatar{ width:22px; height:22px; border-radius:50%; background:var(--gold-soft); color:var(--gold); font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.due-tag{ font-size:10.5px; font-weight:600; }
.status-select{ margin-top:9px; width:100%; background:var(--panel); border:1px solid var(--hair); color:var(--text); font-size:11px; padding:6px 8px; border-radius:6px; }

/* ---- calendar ---- */
.cal-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.cal-nav{ display:flex; align-items:center; gap:10px; }
.cal-month{ font-size:16px; font-weight:600; min-width:150px; text-align:center; font-family:'Fraunces',serif; }
.cal-grid{ display:grid; grid-template-columns:repeat(7,1fr); gap:6px; }
.cal-dow{ font-size:10.5px; color:var(--muted); text-transform:uppercase; text-align:center; padding-bottom:4px; letter-spacing:0.06em; }
.cal-cell{ min-width:0; min-height:82px; border:1px solid var(--hair); border-radius:8px; padding:6px; background:var(--panel); font-size:11.5px; cursor:pointer; transition:border-color .15s; }
.cal-cell:hover{ border-color:var(--gold); }
.cal-cell.out{ opacity:0.32; }
.cal-cell.today{ border-color:var(--gold); background:var(--gold-soft); }
.cal-cell .dnum{ font-weight:700; margin-bottom:4px; }
.cal-evt{ font-size:9.5px; background:var(--panel-raised); border-radius:4px; padding:2px 5px; margin-bottom:3px; overflow:hidden; border-left:2px solid var(--gold); cursor:pointer; display:flex; align-items:center; gap:4px; }
.cal-evt .evt-text{ min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.evt-dot{ width:6px; height:6px; border-radius:50%; flex-shrink:0; display:inline-block; }
.evt-dot.light{ box-shadow:0 0 0 1px rgba(0,0,0,0.25); }

/* ---- notes ---- */
.notes-grid{ grid-template-columns:repeat(auto-fill, minmax(240px,1fr)); }
.note-card{ border-radius:10px; padding:16px; position:relative; min-height:130px; display:flex; flex-direction:column; border:1px solid var(--hair); }
.note-card.gold{ background:linear-gradient(160deg, var(--gold-soft), var(--panel)); }
.note-card.teal{ background:linear-gradient(160deg, var(--teal-soft), var(--panel)); }
.note-card.alert{ background:linear-gradient(160deg, var(--alert-soft), var(--panel)); }
.note-card.plain{ background:var(--panel); }
.note-text{ font-size:13px; line-height:1.5; flex:1; white-space:pre-wrap; }
.note-foot{ display:flex; align-items:center; justify-content:space-between; margin-top:12px; font-size:10.5px; color:var(--muted); }

/* ---- content review ---- */
.content-list{ display:flex; flex-direction:column; gap:12px; }
.content-item{ background:var(--panel); border:1px solid var(--hair); border-radius:12px; overflow:hidden; }
.content-head{ padding:16px 18px; display:flex; align-items:center; gap:14px; cursor:pointer; flex-wrap:wrap; }
.content-thumb{ width:44px; height:44px; border-radius:8px; background:var(--panel-raised); display:flex; align-items:center; justify-content:center; color:var(--gold); flex-shrink:0; }
.content-title{ font-size:14px; font-weight:600; }
.content-tags{ display:flex; gap:7px; margin-top:5px; flex-wrap:wrap; }
.pill{ font-size:10px; font-weight:700; padding:3px 9px; border-radius:20px; letter-spacing:0.03em; }
.content-body{ border-top:1px solid var(--hair); padding:16px 18px; }
.comment{ display:flex; gap:10px; margin-bottom:14px; }
.comment .avatar{ margin-top:1px; }
.comment-text{ font-size:12.5px; line-height:1.5; background:var(--panel-raised); padding:9px 12px; border-radius:9px; border-top-left-radius:3px; }
.comment-meta{ font-size:10.5px; color:var(--muted); margin-top:5px; }
.comment-form{ display:flex; gap:8px; margin-top:8px; }
.comment-form textarea{ flex:1; resize:none; background:var(--panel-raised); border:1px solid var(--hair); border-radius:8px; padding:9px 11px; color:var(--text); font-size:12.5px; min-height:38px; }

/* ---- idea bank ---- */
.vote-btn{ display:flex; align-items:center; gap:6px; padding:6px 11px; border-radius:20px; background:var(--panel-raised); border:1px solid var(--hair); font-size:12px; font-weight:700; color:var(--gold); }
.vote-btn:hover{ border-color:var(--gold); }

/* ---- guidelines ---- */
.res-grid{ grid-template-columns:repeat(auto-fill, minmax(250px,1fr)); }
.res-card{ display:flex; flex-direction:column; gap:8px; }
.cat-tag{ font-size:10px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.08em; }

/* ---- shared bits ---- */
.empty{ text-align:center; padding:40px 20px; color:var(--muted); font-size:13px; }
.modal-overlay{ position:fixed; inset:0; background:rgba(10,11,14,0.7); backdrop-filter:blur(3px); display:flex; align-items:center; justify-content:center; z-index:50; padding:20px; }
.modal{ background:var(--panel); border:1px solid var(--hair); border-radius:14px; padding:26px; width:100%; max-width:440px; max-height:88vh; overflow-y:auto; }
.modal-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; }
.modal-head h3{ font-size:17px; font-weight:600; font-family:'Fraunces',serif; }
.field{ margin-bottom:14px; }
.field label{ display:block; font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.06em; font-weight:600; margin-bottom:6px; }
.field input, .field textarea, .field select{
  width:100%; background:var(--panel-raised); border:1px solid var(--hair); color:var(--text); font-size:13px; padding:9px 11px; border-radius:8px; outline:none;
}
.field input:focus, .field textarea:focus, .field select:focus{ border-color:var(--gold); }
.field textarea{ resize:vertical; min-height:70px; }
.field-row{ display:flex; gap:10px; }
.field-row .field{ flex:1; }
.modal-actions{ display:flex; justify-content:flex-end; gap:10px; margin-top:18px; }
.icon-btn{ background:transparent; border:none; color:var(--muted); padding:4px; border-radius:6px; }
.icon-btn:hover{ color:var(--alert); background:var(--panel-raised); }
.loading-screen{ min-height:100vh; width:100%; display:flex; align-items:center; justify-content:center; background:var(--ink); color:var(--muted); font-family:'IBM Plex Mono',monospace; font-size:12px; letter-spacing:0.08em; }
/* ---- profile bar ---- */
.profile-box{ padding:10px 8px; border-bottom:1px solid var(--hair); margin-bottom:10px; }
.profile-label{ font-size:9.5px; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:6px; }
.profile-input{ width:100%; background:var(--panel-raised); border:1px solid var(--hair); color:var(--text); font-size:12.5px; padding:7px 9px; border-radius:7px; outline:none; }
.profile-input:focus{ border-color:var(--gold); }
.profile-chip{ display:flex; align-items:center; gap:8px; padding:8px 9px; background:var(--gold-soft); border-radius:8px; }
.profile-chip .av{ width:26px; height:26px; border-radius:50%; background:var(--gold); color:#171812; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.profile-chip .info{ flex:1; min-width:0; }
.profile-chip .name{ font-size:12.5px; font-weight:700; color:var(--text); }
.profile-chip .change{ font-size:10px; color:var(--muted); background:none; border:none; text-decoration:underline; padding:0; }

/* ---- calendar view toggle + week grid ---- */
.view-toggle{ display:flex; background:var(--panel-raised); border:1px solid var(--hair); border-radius:8px; padding:3px; gap:2px; }
.view-toggle button{ background:transparent; border:none; color:var(--muted); font-size:12px; font-weight:600; padding:6px 12px; border-radius:6px; }
.view-toggle button.active{ background:var(--gold); color:#171812; }
.week-grid{ display:grid; grid-template-columns:52px repeat(7,1fr); border:1px solid var(--hair); border-radius:10px; overflow:hidden; }
.week-head-cell{ background:var(--panel-raised); padding:8px 4px; text-align:center; border-left:1px solid var(--hair); border-bottom:1px solid var(--hair); }
.week-head-cell .dow{ font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.06em; }
.week-head-cell .dnum{ font-size:15px; font-weight:700; font-family:'Fraunces',serif; margin-top:2px; }
.week-head-cell.today{ background:var(--gold-soft); }
.week-head-cell.today .dnum{ color:var(--gold); }
.week-corner{ background:var(--panel-raised); border-bottom:1px solid var(--hair); }

/* ---- editable workload ---- */
.member-add{ display:flex; gap:6px; margin-top:8px; }
.member-add input{ flex:1; background:var(--panel-raised); border:1px solid var(--hair); color:var(--text); font-size:11.5px; padding:6px 9px; border-radius:6px; outline:none; }
.member-add input:focus{ border-color:var(--gold); }
.member-add button{ background:var(--gold); color:#171812; border:none; border-radius:6px; padding:0 10px; font-weight:700; }
.mini-task{ font-size:11px; color:var(--muted); padding:4px 0 4px 2px; border-left:2px solid var(--hair); padding-left:8px; margin-top:4px; }
.mini-task.done{ text-decoration:line-through; opacity:0.55; }

/* ---- personal tracker ---- */
.streak-row{ display:flex; gap:6px; margin-top:10px; }
.streak-dot{ width:22px; height:22px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:700; color:var(--muted); background:var(--panel-raised); border:1px solid var(--hair); }
.streak-dot.hit{ background:var(--good-soft); color:var(--good); border-color:var(--good); }
.personal-task-row{ display:flex; align-items:center; gap:11px; padding:11px 0; border-bottom:1px solid var(--hair); }
.personal-task-row:last-child{ border-bottom:none; }
.check-btn{ width:20px; height:20px; border-radius:6px; border:1.5px solid var(--hair); background:transparent; flex-shrink:0; display:flex; align-items:center; justify-content:center; color:transparent; }
.check-btn.done{ background:var(--good); border-color:var(--good); color:#0e1410; }

/* ---- login screen ---- */
.login-wrap{ min-height:100vh; width:100%; display:flex; align-items:center; justify-content:center; background:var(--ink); position:relative; padding:24px; }
.login-wrap::before{
  content:''; position:fixed; inset:0; pointer-events:none; opacity:0.5;
  background-image: radial-gradient(rgba(237,235,227,0.045) 1px, transparent 1px); background-size: 3px 3px;
}
.login-card{
  position:relative; z-index:1; width:100%; max-width:460px;
  background:linear-gradient(160deg, var(--panel) 0%, var(--panel-raised) 100%);
  border:1px solid var(--hair); border-radius:18px; padding:38px 36px;
  box-shadow:0 24px 60px -20px rgba(0,0,0,0.55);
}
.login-brand-row{ display:flex; align-items:center; justify-content:center; gap:9px; margin-bottom:18px; }
.login-brand-row .brand-dot{ width:9px; height:9px; }
.login-brand-row .b-name{ font-size:13px; font-weight:600; letter-spacing:0.02em; }
.login-brand-row .b-sub{ font-size:9.5px; color:var(--muted); letter-spacing:0.14em; text-transform:uppercase; }
.login-title{ font-family:'Fraunces',serif; font-size:30px; font-weight:600; text-align:center; line-height:1.15; }
.login-sub{ font-size:13.5px; color:var(--muted); text-align:center; margin-top:8px; margin-bottom:28px; display:flex; align-items:center; justify-content:center; gap:6px; }

.profile-grid{ display:grid; grid-template-columns:repeat(auto-fill, minmax(118px, 1fr)); gap:12px; margin-bottom:6px; }
.profile-card{
  display:flex; flex-direction:column; align-items:center; gap:10px; padding:18px 8px;
  border-radius:12px; border:1px solid var(--hair); background:var(--panel);
  transition:border-color .15s, transform .12s, background .15s;
}
.profile-card:hover{ border-color:var(--gold); transform:translateY(-2px); background:var(--panel-raised); }
.profile-avatar-lg{ width:52px; height:52px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:17px; font-weight:700; font-family:'Fraunces',serif; }
.profile-card .pname{ font-size:12.5px; font-weight:600; }

.pin-dots{ display:flex; gap:12px; justify-content:center; margin:20px 0 22px; }
.pin-dot{ width:15px; height:15px; border-radius:50%; border:1.5px solid var(--hair); background:transparent; transition:background .12s, border-color .12s; }
.pin-dot.filled{ background:var(--gold); border-color:var(--gold); }
.pin-error{ text-align:center; color:var(--alert); font-size:12.5px; margin-top:-12px; margin-bottom:16px; font-weight:500; }
.pinpad{ display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; max-width:260px; margin:0 auto; }
.pinpad button{
  width:100%; aspect-ratio:1; border-radius:50%; border:1px solid var(--hair); background:var(--panel);
  font-family:'Fraunces',serif; font-size:18px; font-weight:600; color:var(--text);
  display:flex; align-items:center; justify-content:center; transition:border-color .12s, background .12s;
}
.pinpad button:hover{ border-color:var(--gold); background:var(--panel-raised); }
.pinpad button.ghost{ border-color:transparent; background:transparent; }

.color-pick{ display:flex; gap:9px; justify-content:center; margin-bottom:6px; }
.color-swatch{ width:26px; height:26px; border-radius:50%; border:2px solid transparent; }
.color-swatch.selected{ border-color:var(--text); }

.login-eyebrow{ text-align:center; font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:0.18em; color:var(--gold); text-transform:uppercase; margin-bottom:16px; }
.manage-link{
  display:flex; align-items:center; justify-content:center; gap:8px; margin-top:26px; width:100%;
  background:transparent; border:1px dashed var(--hair); color:var(--muted); font-size:12.5px; font-weight:600;
  padding:12px; border-radius:10px; transition:border-color .15s, color .15s;
}
.manage-link:hover{ color:var(--gold); border-color:var(--gold); }
.manage-caption{ text-align:center; font-size:10.5px; color:var(--muted); margin-top:8px; }

.admin-list{ display:flex; flex-direction:column; gap:8px; margin-bottom:20px; max-height:280px; overflow-y:auto; }
.admin-row{ display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--hair); border-radius:10px; background:var(--panel); }
.admin-row .code{ font-family:'IBM Plex Mono',monospace; font-size:13px; color:var(--gold); letter-spacing:0.1em; margin-left:auto; }
.code-btn{ background:var(--gold-soft); border:1px solid transparent; border-radius:7px; padding:4px 10px; cursor:pointer; }
.code-btn:hover{ border-color:var(--gold); }
.mono-input{ font-family:'IBM Plex Mono',monospace; letter-spacing:0.1em; text-align:center; }
.code-input{
  width:180px; margin:16px auto 0; display:block; text-align:center;
  font-family:'IBM Plex Mono',monospace; font-size:30px; font-weight:600; letter-spacing:0.2em;
  color:var(--gold); background:var(--panel); border:1px solid var(--gold-soft); border-radius:12px; padding:14px; outline:none;
}
.code-input:focus{ border-color:var(--gold); }
.code-reveal{ text-align:center; padding:10px 6px 6px; }
.code-big{
  font-family:'IBM Plex Mono',monospace; font-size:38px; font-weight:600; letter-spacing:0.18em; color:var(--gold);
  margin:16px 0; background:var(--panel); border:1px solid var(--gold-soft); border-radius:12px; padding:16px;
}
.copy-row{ display:flex; align-items:center; justify-content:center; gap:8px; margin-top:4px; flex-wrap:wrap; }

.menu-toggle{ display:none; }
@media (max-width: 820px){
  .sidebar{ position:fixed; left:0; top:0; height:100vh; transform:translateX(-100%); transition:transform .2s; }
  .sidebar.open{ transform:translateX(0); }
  .menu-toggle{ display:flex; }
  .main{ padding:22px 18px 50px; }

  /* A seventh of a phone screen is about 35px, which fits three characters —
     wrapping inside that just breaks words in half. So the month grid keeps a
     usable column width and the card scrolls sideways instead, the same way
     the week view already does, and a title gets two real lines. */
  .cal-grid{ min-width:600px; gap:5px; }
  .cal-cell{ min-height:84px; padding:5px 5px; }
  .cal-evt{ align-items:flex-start; line-height:1.3; padding:3px 5px; }
  .cal-evt .evt-dot{ margin-top:3px; }
  .cal-evt .evt-text{
    white-space:normal;
    text-overflow:clip;
    overflow-wrap:anywhere;
    display:-webkit-box;
    -webkit-line-clamp:4;
    -webkit-box-orient:vertical;
  }
}
`;

/* ---------------------------------- small UI pieces ---------------------------------- */

function ProgressBar({ pct, color = "var(--gold)" }) {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

function Avatar({ name }) {
  const initials = (name || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return <div className="avatar">{initials || "?"}</div>;
}

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Full-screen viewer for a photo or video attached anywhere in the app — tap a
// thumbnail to see it properly instead of squinting at a preview.
function MediaLightbox({ fileId, kind, name, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(8,9,13,0.94)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <button className="icon-btn" onClick={onClose} style={{ position: "absolute", top: 16, right: 16, color: "var(--text)" }}><X size={22} /></button>
      {kind === "image" ? (
        <img src={driveThumbSrc(fileId, "s1600")} onError={hideBrokenThumb} alt={name || ""} onClick={(e) => e.stopPropagation()} style={{ maxWidth: "100%", maxHeight: "90vh", objectFit: "contain", borderRadius: 8 }} />
      ) : (
        <video src={driveMediaSrc(fileId)} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} style={{ maxWidth: "100%", maxHeight: "90vh", borderRadius: 8, background: "#000" }} />
      )}
      {name && <div style={{ position: "absolute", bottom: 16, left: 0, right: 0, textAlign: "center", fontSize: 12, color: "var(--muted)" }}>{name}</div>}
    </div>,
    document.body
  );
}

/* ---------------------------------- Dashboard ---------------------------------- */

function Dashboard({ data, saveData, profile, setView, isEmployer }) {
  const { tasks, calendarEvents, notes, content } = data;
  const [quickAdd, setQuickAdd] = useState({});
  const [showGoals, setShowGoals] = useState(false);
  const [goalForm, setGoalForm] = useState({ team: 6, mine: 0 });

  const openGoals = () => {
    setGoalForm({
      team: (data.goals && data.goals.teamWeeklyTarget) || 0,
      mine: profile ? ((data.goals && data.goals.individualTargets && data.goals.individualTargets[profile]) || 0) : 0,
    });
    setShowGoals(true);
  };
  const saveGoals = () => {
    saveData({
      ...data,
      goals: {
        teamWeeklyTarget: Number(goalForm.team) || 0,
        individualTargets: { ...((data.goals && data.goals.individualTargets) || {}), ...(profile ? { [profile]: Number(goalForm.mine) || 0 } : {}) },
      },
    });
    setShowGoals(false);
  };

  const addQuickTask = (member) => {
    const title = (quickAdd[member] || "").trim();
    if (!title) return;
    const task = { id: uid(), title, description: "", assignee: member, dueDate: todayISO(), status: "todo", priority: "medium" };
    saveData({ ...data, tasks: [task, ...data.tasks] });
    setQuickAdd({ ...quickAdd, [member]: "" });
  };
  const done = tasks.filter((t) => t.status === "done").length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const overdueTasks = tasks.filter((t) => t.status !== "done" && daysUntil(t.dueDate) < 0);
  const overdue = overdueTasks.length;

  const myPlate = profile
    ? tasks
        .filter((t) => t.assignee === profile && t.status !== "done" && daysUntil(t.dueDate) <= 0)
        .sort((a, b) => daysUntil(a.dueDate) - daysUntil(b.dueDate))
    : [];
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Still up," : hour < 12 ? "Good morning," : hour < 18 ? "Good afternoon," : "Good evening,";
  const inProgress = tasks.filter((t) => t.status === "progress").length;
  const pendingReview = tasks.filter((t) => t.status === "review").length + content.filter(c=>c.status==="review").length;

  const upcoming = [...calendarEvents]
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((e) => daysUntil(e.date) >= -1)
    .slice(0, 5);

  const members = [...new Set(tasks.map((t) => t.assignee).filter(Boolean))];
  const memberStats = members.map((m) => {
    const mine = tasks.filter((t) => t.assignee === m);
    const mdone = mine.filter((t) => t.status === "done").length;
    return { name: m, done: mdone, total: mine.length, pct: mine.length ? Math.round((mdone / mine.length) * 100) : 0 };
  });

  const recentNotes = [...notes].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)).slice(0, 3);
  const circumference = 2 * Math.PI * 50;

  const weekStart = startOfWeek(new Date());
  const weekStartIso = isoOf(weekStart);
  const weekEndDate = new Date(weekStart); weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekEndIso = isoOf(weekEndDate);
  const postedThisWeek = calendarEvents.filter((e) => e.type === "post" && e.status === "posted" && e.date >= weekStartIso && e.date <= weekEndIso);
  const teamTarget = (data.goals && data.goals.teamWeeklyTarget) || 0;
  const teamPosted = postedThisWeek.length;
  const myTarget = profile ? ((data.goals && data.goals.individualTargets && data.goals.individualTargets[profile]) || 0) : 0;
  const myPosted = profile ? postedThisWeek.filter((e) => e.assignee === profile).length : 0;

  return (
    <div>
      <div className="hero" style={{ display: "block", padding: "24px 28px", marginBottom: 16 }}>
        <div className="display" style={{ fontSize: 21, fontWeight: 600 }}>{greeting} {profile || "there"}</div>
        <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4, marginBottom: myPlate.length ? 14 : 0 }}>
          {!profile ? "Sign in to see your own plate for today." : myPlate.length === 0 ? "Nothing due today or overdue — you're clear." : "Here's what's on your plate today:"}
        </div>
        {myPlate.map((t) => {
          const ty = TASK_TYPES.find((x) => x.id === t.type) || TASK_TYPES[TASK_TYPES.length - 1];
          const TyIcon = ty.icon;
          const late = daysUntil(t.dueDate) < 0;
          const nextStep = (t.steps || []).find((s) => !s.done);
          return (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 0", borderBottom: "1px solid var(--hair)" }}>
              <span style={{ width: 28, height: 28, borderRadius: 7, background: ty.color + "1f", color: ty.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><TyIcon size={14} /></span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{ty.verb} — {t.title}</div>
                {nextStep ? (
                  <div style={{ fontSize: 11.5, color: "var(--gold)", marginTop: 2 }}>Next: {nextStep.text}</div>
                ) : t.description ? (
                  <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{t.description}</div>
                ) : null}
              </div>
              {late && <span className="pill" style={{ background: "var(--alert-soft)", color: "var(--alert)" }}>Overdue</span>}
            </div>
          );
        })}
      </div>

      {isEmployer && overdueTasks.length > 0 && (
        <div className="card" style={{ border: "1px solid rgba(217,86,75,0.35)", marginBottom: 16 }}>
          <div className="section-title" style={{ color: "var(--alert)" }}><AlertTriangle size={16} color="var(--alert)" /> Needs attention · {overdueTasks.length} overdue</div>
          {overdueTasks.map((t) => (
            <div key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid var(--hair)", fontSize: 13 }}>
              <span>{t.title}</span><span style={{ color: "var(--muted)" }}>{t.assignee || "Unassigned"}</span>
            </div>
          ))}
        </div>
      )}

      {isEmployer ? (
        <div className="card" style={{ marginBottom: 16, padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap", padding: "22px 24px" }}>
            <div className="ring-wrap" style={{ width: 88, height: 88 }}>
              <svg width="88" height="88" viewBox="0 0 118 118">
                <circle cx="59" cy="59" r="50" fill="none" stroke="var(--panel-raised)" strokeWidth="10" />
                <circle
                  cx="59" cy="59" r="50" fill="none" stroke="var(--gold)" strokeWidth="10" strokeLinecap="round"
                  strokeDasharray={circumference} strokeDashoffset={circumference - (pct / 100) * circumference}
                  transform="rotate(-90 59 59)" style={{ transition: "stroke-dashoffset .5s ease" }}
                />
              </svg>
              <div className="ring-num"><div className="n" style={{ fontSize: 19 }}>{pct}%</div><div className="l" style={{ fontSize: 8.5 }}>On track</div></div>
            </div>
            <div className="hero-stats" style={{ gap: 22 }}>
              <div className="hstat"><div className="n" style={{ fontSize: 19 }}>{tasks.length}</div><div className="l">Active duties</div></div>
              <div className="hstat"><div className="n" style={{ fontSize: 19, color: inProgress ? "var(--gold)" : "var(--text)" }}>{inProgress}</div><div className="l">In progress</div></div>
              <div className="hstat"><div className="n" style={{ fontSize: 19, color: pendingReview ? "var(--teal)" : "var(--text)" }}>{pendingReview}</div><div className="l">Awaiting review</div></div>
              <div className="hstat"><div className="n" style={{ fontSize: 19, color: overdue ? "var(--alert)" : "var(--text)" }}>{overdue}</div><div className="l">Overdue</div></div>
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--hair)", padding: "18px 24px" }}>
            <div style={{ fontSize: 11.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 10 }}>Content pipeline</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
              {CONTENT_STATUS.map((s) => (
                <div key={s.id} style={{ background: "var(--panel-raised)", borderRadius: 9, padding: "10px 8px", textAlign: "center" }}>
                  <div style={{ fontFamily: "Fraunces, serif", fontSize: 19, fontWeight: 700, color: s.color }}>{content.filter((c) => c.status === s.id).length}</div>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--hair)", padding: "18px 24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>This week's goals</div>
              <button className="btn" style={{ padding: "5px 11px", fontSize: 11.5 }} onClick={openGoals}>Edit goals</button>
            </div>
            <div className="member-row">
              <div className="mtop"><span style={{ fontWeight: 600 }}>Team</span><span style={{ color: "var(--muted)" }}>{teamPosted}/{teamTarget || "—"} posts</span></div>
              <ProgressBar pct={teamTarget ? (teamPosted / teamTarget) * 100 : 0} color={teamTarget && teamPosted >= teamTarget ? "var(--good)" : "var(--gold)"} />
            </div>
            {profile && (
              <div className="member-row" style={{ marginBottom: 0 }}>
                <div className="mtop"><span style={{ fontWeight: 600 }}>{profile}</span><span style={{ color: "var(--muted)" }}>{myPosted}/{myTarget || "—"} posts</span></div>
                <ProgressBar pct={myTarget ? (myPosted / myTarget) * 100 : 0} color={myTarget && myPosted >= myTarget ? "var(--good)" : "var(--teal)"} />
              </div>
            )}
          </div>
        </div>
      ) : (
        profile && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="topbar" style={{ marginBottom: 10 }}>
              <div className="section-title" style={{ marginBottom: 0 }}>Your goal this week</div>
              <button className="btn" style={{ padding: "5px 11px", fontSize: 11.5 }} onClick={openGoals}>Edit</button>
            </div>
            <div className="member-row" style={{ marginBottom: 0 }}>
              <div className="mtop"><span style={{ fontWeight: 600 }}>{profile}</span><span style={{ color: "var(--muted)" }}>{myPosted}/{myTarget || "—"} posts</span></div>
              <ProgressBar pct={myTarget ? (myPosted / myTarget) * 100 : 0} color={myTarget && myPosted >= myTarget ? "var(--good)" : "var(--teal)"} />
            </div>
          </div>
        )
      )}

      <div className={`grid ${isEmployer ? "two-col" : ""}`}>
        <div className="card">
          <div className="section-title"><CalendarDays size={16} color="var(--gold)" /> Upcoming on the calendar</div>
          {upcoming.length === 0 && <div className="empty">Nothing scheduled yet — add something on the Calendar page.</div>}
          {upcoming.map((e) => {
            const d = daysUntil(e.date);
            const label = d < 0 ? "Past" : d === 0 ? "Today" : d === 1 ? "Tomorrow" : `In ${d}d`;
            const badgeColor = d <= 0 ? "var(--alert)" : d <= 2 ? "var(--gold)" : "var(--teal)";
            return (
              <div className="deadline-row" key={e.id}>
                <span className="deadline-badge" style={{ background: badgeColor + "22", color: badgeColor }}>{label}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{e.title}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{fmtDate(e.date)}</div>
                </div>
              </div>
            );
          })}
        </div>

        {isEmployer && (
        <div className="card">
          <div className="section-title"><Users size={16} color="var(--gold)" /> Team workload</div>
          {memberStats.length === 0 && <div className="empty">Assign a duty to see workload here.</div>}
          {memberStats.map((m) => {
            const openTasks = tasks.filter((t) => t.assignee === m.name && t.status !== "done");
            return (
              <div className="member-row" key={m.name}>
                <div className="mtop"><span className="name">{m.name}</span><span className="frac">{m.done}/{m.total}</span></div>
                <ProgressBar pct={m.pct} color={m.pct === 100 ? "var(--good)" : "var(--gold)"} />
                {openTasks.slice(0, 3).map((t) => (
                  <div className="mini-task" key={t.id}>{t.title}</div>
                ))}
                <div className="member-add">
                  <input
                    placeholder={`Add a task for ${m.name}…`}
                    value={quickAdd[m.name] || ""}
                    onChange={(e) => setQuickAdd({ ...quickAdd, [m.name]: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") addQuickTask(m.name); }}
                  />
                  <button onClick={() => addQuickTask(m.name)}><Plus size={13} /></button>
                </div>
              </div>
            );
          })}
          <div className="member-row" style={{ marginTop: memberStats.length ? 16 : 0, paddingTop: memberStats.length ? 14 : 0, borderTop: memberStats.length ? "1px solid var(--hair)" : "none" }}>
            <div className="mtop"><span className="name" style={{ color: "var(--muted)" }}>Add someone new</span></div>
            <div className="member-add">
              <input
                placeholder="Name — task title"
                value={quickAdd.__new || ""}
                onChange={(e) => setQuickAdd({ ...quickAdd, __new: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const [name, ...rest] = (quickAdd.__new || "").split("-");
                    const title = rest.join("-").trim();
                    if (name && title) {
                      saveData({ ...data, tasks: [{ id: uid(), title, description: "", assignee: name.trim(), dueDate: todayISO(), status: "todo", priority: "medium" }, ...data.tasks] });
                      setQuickAdd({ ...quickAdd, __new: "" });
                    }
                  }
                }}
              />
              <button onClick={() => {
                const [name, ...rest] = (quickAdd.__new || "").split("-");
                const title = rest.join("-").trim();
                if (name && title) {
                  saveData({ ...data, tasks: [{ id: uid(), title, description: "", assignee: name.trim(), dueDate: todayISO(), status: "todo", priority: "medium" }, ...data.tasks] });
                  setQuickAdd({ ...quickAdd, __new: "" });
                }
              }}><Plus size={13} /></button>
            </div>
          </div>
        </div>
        )}
      </div>

      {data.announcements && data.announcements.length > 0 && (
        <div className="card" style={{ marginTop: 16, borderColor: "var(--gold-soft)" }}>
          <div className="section-title"><Radio size={16} color="var(--gold)" /> Announcements</div>
          {[...data.announcements].reverse().slice(0, 3).map((a) => (
            <div key={a.id} style={{ padding: "9px 0", borderBottom: "1px solid var(--hair)", fontSize: 13 }}>
              {a.text}
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>{a.author} · {fmtDate(a.date)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-title"><Pin size={16} color="var(--gold)" /> Pinned & recent notes</div>
        <div className="grid notes-grid">
          {recentNotes.map((n) => (
            <div key={n.id} className={`note-card ${n.color || "plain"}`}>
              <div className="note-text">{n.text}</div>
              <div className="note-foot"><span>{n.author}</span><span>{fmtDate(n.date)}</span></div>
            </div>
          ))}
          {recentNotes.length === 0 && <div className="empty">No notes yet.</div>}
        </div>
      </div>

      {showGoals && (
        <Modal title="Edit weekly goals" onClose={() => setShowGoals(false)}>
          {isEmployer && (
            <div className="field"><label>Team weekly post target</label><input type="number" min="0" value={goalForm.team} onChange={(e) => setGoalForm({ ...goalForm, team: e.target.value })} /></div>
          )}
          {profile && (
            <div className="field"><label>{profile}'s personal weekly post target</label><input type="number" min="0" value={goalForm.mine} onChange={(e) => setGoalForm({ ...goalForm, mine: e.target.value })} /></div>
          )}
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
            Progress counts calendar events with type "Post" and status "Posted" this week (Sunday–Saturday).
          </div>
          <div className="modal-actions"><button className="btn" onClick={() => setShowGoals(false)}>Cancel</button><button className="btn btn-gold" onClick={saveGoals}>Save goals</button></div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------- Task detail (shared by Duties & My Duties) ---------------------------------- */

function TaskDetailModal({ data, saveData, taskId, onClose, profile, allAssignees, onDelete, onOpenTask }) {
  const task = data.tasks.find((t) => t.id === taskId);
  const [newStep, setNewStep] = useState("");
  const [editingStepId, setEditingStepId] = useState(null);
  const [editingStepText, setEditingStepText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [localTitle, setLocalTitle] = useState(task ? task.title : "");
  const [localDescription, setLocalDescription] = useState(task ? task.description || "" : "");
  const [newProjectName, setNewProjectName] = useState("");
  const [calTime, setCalTime] = useState("09:00");

  useEffect(() => {
    setLocalTitle(task ? task.title : "");
    setLocalDescription(task ? task.description || "" : "");
  }, [taskId]);

  const updateTask = (patch) => {
    saveData({ ...data, tasks: data.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) });
  };
  const debouncedUpdateTask = useDebouncedCallback(updateTask, 500);

  // A duty already knows its date and its owner, so putting it on the calendar
  // only needs the time of day. The event keeps the duty's id, which is what
  // stops a second tap adding it twice and lets it be taken off again.
  const scheduled = (data.calendarEvents || []).find((e) => e.taskId === taskId);
  const addToCalendar = () => {
    if (scheduled || !task) return;
    saveData({
      ...data,
      calendarEvents: [...data.calendarEvents, {
        id: uid(), taskId: task.id, title: task.title,
        date: task.dueDate || todayISO(), time: calTime, endTime: "",
        type: "deadline", assignee: task.assignee || "", status: "planned",
        notes: "Added from Duties",
      }],
    });
  };
  const removeFromCalendar = () => {
    if (!scheduled) return;
    saveData({ ...data, calendarEvents: data.calendarEvents.filter((e) => e.id !== scheduled.id) });
  };

  if (!task) return null;

  const addStep = () => {
    if (!newStep.trim()) return;
    updateTask({ steps: [...(task.steps || []), { id: uid(), text: newStep.trim(), done: false }] });
    setNewStep("");
  };
  const toggleStep = (id) => updateTask({ steps: (task.steps || []).map((s) => (s.id === id ? { ...s, done: !s.done } : s)) });
  const removeStep = (id) => updateTask({ steps: (task.steps || []).filter((s) => s.id !== id) });
  const startEditStep = (s) => { setEditingStepId(s.id); setEditingStepText(s.text); };
  const saveEditStep = () => {
    if (editingStepText.trim()) updateTask({ steps: (task.steps || []).map((s) => (s.id === editingStepId ? { ...s, text: editingStepText.trim() } : s)) });
    setEditingStepId(null);
  };
  const addNote = () => {
    if (!noteText.trim()) return;
    const newNotes = [...(task.notes || []), { id: uid(), author: profile || "Team", text: noteText.trim(), date: todayISO() }];
    const notifyAssignee = task.assignee && task.assignee !== profile;
    const notifications = notifyAssignee
      ? [...(data.notifications || []), makeNotification({ toProfile: task.assignee, type: "note", text: `${profile || "Someone"} left a note on: ${task.title}`, link: "myduties", fromProfile: profile })]
      : (data.notifications || []);
    saveData({ ...data, tasks: data.tasks.map((t) => (t.id === taskId ? { ...t, notes: newNotes } : t)), notifications });
    if (notifyAssignee) sendPush(task.assignee, "New note on your duty", `${profile || "Someone"} left a note on: ${task.title}`);
    setNoteText("");
  };

  const projects = data.projects || [];
  const currentProject = task.projectId ? projects.find((p) => p.id === task.projectId) : null;
  const siblingTasks = task.projectId ? data.tasks.filter((t) => t.projectId === task.projectId && t.id !== task.id) : [];
  const linkToProject = (projectId) => updateTask({ projectId });
  const unlinkProject = () => updateTask({ projectId: null });
  const createAndLinkProject = () => {
    if (!newProjectName.trim()) return;
    const np = { id: uid(), name: newProjectName.trim(), createdAt: todayISO() };
    saveData({ ...data, projects: [...projects, np], tasks: data.tasks.map((t) => (t.id === taskId ? { ...t, projectId: np.id } : t)) });
    setNewProjectName("");
  };

  const yt = youtubeId(task.link);
  const drive = !yt ? driveEmbedUrl(task.link) : null;
  const steps = task.steps || [];
  const stepsDone = steps.filter((s) => s.done).length;
  const nextStep = steps.find((s) => !s.done);
  const reloadSteps = () => {
    updateTask({ steps: defaultContentSteps(task.format || "video") });
  };

  return (
    <Modal title="Duty details" onClose={onClose}>
      <div className="field"><label>Title</label><input value={localTitle} onChange={(e) => { setLocalTitle(e.target.value); debouncedUpdateTask({ title: e.target.value }); }} /></div>
      <div className="field"><label>Details</label><textarea value={localDescription} onChange={(e) => { setLocalDescription(e.target.value); debouncedUpdateTask({ description: e.target.value }); }} placeholder="Any brief, links, or notes" /></div>
      <div className="field-row">
        <div className="field"><label>Action</label>
          <select value={task.type} onChange={(e) => updateTask({ type: e.target.value })}>
            {TASK_TYPES.map((t) => <option value={t.id} key={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div className="field"><label>Format</label>
          <select value={task.format || "video"} onChange={(e) => updateTask({ format: e.target.value })}>
            {CONTENT_FORMATS.map((f) => <option value={f.id} key={f.id}>{f.label}</option>)}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field"><label>Assignee</label>
          <input list="detail-assignee-list" value={task.assignee || ""} onChange={(e) => updateTask({ assignee: e.target.value })} placeholder="Name" />
          <datalist id="detail-assignee-list">{allAssignees.map((a) => <option value={a} key={a} />)}</datalist>
        </div>
        <div className="field"><label>Due date</label><input type="date" value={task.dueDate} onChange={(e) => updateTask({ dueDate: e.target.value })} /></div>
      </div>
      <div className="field"><label>Priority</label>
        <select value={task.priority} onChange={(e) => updateTask({ priority: e.target.value })}>
          {PRIORITY.map((p) => <option value={p.id} key={p.id}>{p.label}</option>)}
        </select>
      </div>
      <div className="field"><label>Reference link (optional)</label><input value={task.link || ""} onChange={(e) => updateTask({ link: e.target.value })} placeholder="YouTube, Drive, or an example link" /></div>
      {(yt || drive) && (
        <div style={{ position: "relative", paddingTop: "56.25%", marginBottom: 14, borderRadius: 8, overflow: "hidden" }}>
          <iframe src={yt ? `https://www.youtube.com/embed/${yt}` : drive} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }} allowFullScreen title={task.title} />
        </div>
      )}

      <div className="section-title" style={{ fontSize: 13 }}><Layers size={14} color="var(--gold)" /> Project</div>
      {currentProject ? (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--gold)" }}>{currentProject.name}</span>
            <button className="btn" style={{ padding: "4px 9px", fontSize: 10.5 }} onClick={unlinkProject}>Unlink</button>
          </div>
          {siblingTasks.length === 0 && <div className="empty" style={{ padding: "6px 0" }}>No other duties linked yet — link another one from its own detail page.</div>}
          {siblingTasks.map((t) => {
            const ty = TASK_TYPES.find((x) => x.id === t.type) || TASK_TYPES[TASK_TYPES.length - 1];
            const TyIcon = ty.icon;
            const st = STATUS.find((s) => s.id === t.status) || STATUS[0];
            return (
              <button
                key={t.id}
                onClick={() => onOpenTask && onOpenTask(t.id)}
                style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 8, padding: "8px 10px", marginBottom: 6 }}
              >
                <span style={{ width: 24, height: 24, borderRadius: 7, background: ty.color + "1f", color: ty.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><TyIcon size={12} /></span>
                <span style={{ flex: 1, fontSize: 12.5 }}>{ty.verb} — {t.title}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: st.color }}>{st.label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8, lineHeight: 1.4 }}>
            Not linked yet — connect this if it's one step of a bigger piece (e.g. Film → Edit → Post for the same video).
          </div>
          {projects.length > 0 && (
            <div className="field" style={{ marginBottom: 8 }}>
              <select defaultValue="" onChange={(e) => { if (e.target.value) linkToProject(e.target.value); }}>
                <option value="">Link to existing project…</option>
                {projects.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createAndLinkProject(); }}
              placeholder="Or name a new project…"
              style={{ flex: 1, background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 6, padding: "7px 9px", fontSize: 12.5, color: "var(--text)", outline: "none" }}
            />
            <button className="btn" onClick={createAndLinkProject}>Create & Link</button>
          </div>
        </div>
      )}

      <div className="section-title" style={{ fontSize: 13 }}><CalendarDays size={14} color="var(--gold)" /> Calendar</div>
      {scheduled ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", fontSize: 12.5, background: "var(--panel-raised)", borderRadius: 7, padding: "8px 10px", marginBottom: 18 }}>
          <span>On the calendar — {fmtDate(scheduled.date)}{scheduled.time ? ` at ${scheduled.time}` : ""}</span>
          <button className="btn" style={{ padding: "4px 9px", fontSize: 10.5 }} onClick={removeFromCalendar}>Take off</button>
        </div>
      ) : (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8, lineHeight: 1.4 }}>
            {task.dueDate
              ? `Puts this on ${fmtDate(task.dueDate)} — its due date — so it shows up alongside everything else that day.`
              : "This duty has no due date yet, so it'd land on today. Set a due date above to place it properly."}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="time" value={calTime} onChange={(e) => setCalTime(e.target.value)}
              style={{ background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 6, padding: "7px 9px", fontSize: 12.5, color: "var(--text)", outline: "none" }}
            />
            <button className="btn" onClick={addToCalendar}><Plus size={13} /> Add to calendar</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div className="section-title" style={{ fontSize: 13, marginBottom: 0 }}><ListChecks size={14} color="var(--gold)" /> Checklist · {stepsDone}/{steps.length}</div>
        <button className="btn" style={{ padding: "4px 9px", fontSize: 10.5 }} onClick={reloadSteps} title="Replace the checklist with the default for this format"><RotateCw size={11} /> Reset for format</button>
      </div>
      {nextStep ? (
        <div style={{ fontSize: 12.5, color: "var(--gold)", background: "var(--gold-soft)", borderRadius: 7, padding: "7px 10px", marginBottom: 10 }}>
          Next: {nextStep.text}
          {nextStep.tip && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3, fontStyle: "italic" }}>Tip: {nextStep.tip}</div>}
        </div>
      ) : steps.length > 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--good)", background: "var(--good-soft)", borderRadius: 7, padding: "7px 10px", marginBottom: 10, fontWeight: 600 }}>
          All steps done — ready for review.
        </div>
      ) : null}
      {steps.map((s) => (
        <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
          <button className={`check-btn ${s.done ? "done" : ""}`} style={{ width: 16, height: 16, flexShrink: 0 }} onClick={() => toggleStep(s.id)}><CheckCircle2 size={10} /></button>
          {editingStepId === s.id ? (
            <input
              autoFocus value={editingStepText} onChange={(e) => setEditingStepText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveEditStep(); }} onBlur={saveEditStep}
              style={{ flex: 1, background: "var(--panel-raised)", border: "1px solid var(--gold)", borderRadius: 6, padding: "4px 8px", fontSize: 12, color: "var(--text)", outline: "none" }}
            />
          ) : (
            <span onClick={() => startEditStep(s)} style={{ flex: 1, fontSize: 12.5, textDecoration: s.done ? "line-through" : "none", opacity: s.done ? 0.55 : 1, cursor: "pointer" }}>{s.text}</span>
          )}
          <button className="icon-btn" onClick={() => removeStep(s.id)}><Trash2 size={12} /></button>
        </div>
      ))}
      {steps.length === 0 && <div className="empty" style={{ padding: "8px 0" }}>No checklist yet — add the first step below.</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 18 }}>
        <input
          value={newStep} onChange={(e) => setNewStep(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addStep(); }}
          placeholder="Add a step…" style={{ flex: 1, background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 6, padding: "7px 9px", fontSize: 12.5, color: "var(--text)", outline: "none" }}
        />
        <button className="btn" onClick={addStep}><Plus size={13} /></button>
      </div>

      <div className="section-title" style={{ fontSize: 13 }}><MessageSquare size={14} color="var(--gold)" /> Notes</div>
      {(task.notes || []).map((n) => (
        <div key={n.id} style={{ fontSize: 12, padding: "7px 0", borderBottom: "1px solid var(--hair)" }}>
          <div>{n.text}</div>
          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{n.author} · {fmtDate(n.date)}</div>
        </div>
      ))}
      {(!task.notes || task.notes.length === 0) && <div className="empty" style={{ padding: "8px 0" }}>No notes yet.</div>}
      <div className="comment-form" style={{ marginTop: 8, marginBottom: 4 }}>
        <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addNote(); } }} placeholder="Leave a quick note for whoever's on this…" />
        <button className="btn btn-gold" style={{ alignSelf: "flex-end" }} onClick={addNote}><Send size={13} /></button>
      </div>

      <div className="modal-actions">
        <button className="btn" style={{ borderColor: "var(--alert)", color: "var(--alert)" }} onClick={() => { onDelete(task.id); onClose(); }}><Trash2 size={13} /> Delete duty</button>
        <button className="btn btn-gold" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

/* ---------------------------------- Duties board ---------------------------------- */

function Duties({ data, saveData, profile }) {
  const [filter, setFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", assignee: "", dueDate: todayISO(), priority: "medium", type: "other", format: "video" });
  const [expanded, setExpanded] = useState({});
  const [openTaskId, setOpenTaskId] = useState(null);

  const members = [...new Set(data.tasks.map((t) => t.assignee).filter(Boolean))];
  const filtered = filter === "all" ? data.tasks : data.tasks.filter((t) => t.assignee === filter);

  const addTask = () => {
    if (!form.title.trim()) return;
    const task = { id: uid(), status: "todo", steps: defaultContentSteps(form.format), link: "", notes: [], ...form };
    const notifyAssignee = task.assignee && task.assignee !== profile;
    const notifications = notifyAssignee
      ? [...(data.notifications || []), makeNotification({ toProfile: task.assignee, type: "task", text: `${profile || "Someone"} assigned you: ${task.title}`, link: "myduties", fromProfile: profile })]
      : (data.notifications || []);
    saveData({ ...data, tasks: [task, ...data.tasks], notifications });
    if (notifyAssignee) sendPush(task.assignee, "New duty assigned", `${profile || "Someone"} assigned you: ${task.title}`);
    setForm({ title: "", description: "", assignee: "", dueDate: todayISO(), priority: "medium", type: "other", format: "video" });
    setShowForm(false);
  };
  const toggleStep = (taskId, stepId) => {
    saveData({
      ...data,
      tasks: data.tasks.map((t) => (t.id === taskId ? { ...t, steps: (t.steps || []).map((s) => (s.id === stepId ? { ...s, done: !s.done } : s)) } : t)),
    });
  };
  const updateStatus = (id, status) => {
    saveData({
      ...data,
      tasks: data.tasks.map((t) => (t.id === id ? { ...t, status, completedAt: status === "done" ? todayISO() : null } : t)),
    });
  };
  const removeTask = (id) => {
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return;
    saveData({
      ...data,
      tasks: data.tasks.filter((t) => t.id !== id),
      // A duty put on the calendar leaves an event behind pointing at a duty
      // that no longer exists; take it with the duty rather than stranding it.
      calendarEvents: (data.calendarEvents || []).filter((e) => e.taskId !== id),
      deletedTasks: [{ ...task, deletedBy: profile || "Unknown", deletedAt: todayISO() }, ...(data.deletedTasks || [])],
    });
  };

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Duties</div><div className="page-sub">Assign work and track it through to done.</div></div>
        <button className="btn btn-gold" onClick={() => setShowForm(true)}><Plus size={15} /> Assign a duty</button>
      </div>

      <div className="filter-row">
        <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>Everyone</button>
        {members.map((m) => (
          <button key={m} className={`chip ${filter === m ? "active" : ""}`} onClick={() => setFilter(m)}>{m}</button>
        ))}
      </div>

      <div className="board">
        {STATUS.map((col) => {
          const items = filtered.filter((t) => t.status === col.id);
          return (
            <div className="col" key={col.id}>
              <div className="col-head">
                <span className="t" style={{ color: col.color }}>{col.label}</span>
                <span className="c">{items.length}</span>
              </div>
              {items.map((t) => {
                const p = PRIORITY.find((x) => x.id === t.priority) || PRIORITY[1];
                const ty = TASK_TYPES.find((x) => x.id === t.type) || TASK_TYPES[TASK_TYPES.length - 1];
                const TyIcon = ty.icon;
                const d = daysUntil(t.dueDate);
                const overdue = d < 0 && t.status !== "done";
                const steps = t.steps || [];
                const stepsDone = steps.filter((s) => s.done).length;
                const nextStep = steps.find((s) => !s.done);
                const isOpen = expanded[t.id];
                return (
                  <div className="task-card" style={{ borderLeftColor: p.color }} key={t.id}>
                    <button className="icon-btn" style={{ position: "absolute", top: 8, right: 8 }} onClick={() => removeTask(t.id)}>
                      <Trash2 size={13} />
                    </button>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: ty.color, background: ty.color + "1f", padding: "2px 7px", borderRadius: 5, marginBottom: 6, marginRight: 5 }}>
                      <TyIcon size={10} /> {ty.label}
                    </div>
                    {t.projectId && (() => {
                      const proj = (data.projects || []).find((p) => p.id === t.projectId);
                      return proj ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, color: "var(--gold)", background: "var(--gold-soft)", padding: "2px 7px", borderRadius: 5, marginBottom: 6 }}>
                          <Layers size={10} /> {proj.name}
                        </span>
                      ) : null;
                    })()}
                    <div className="tt" style={{ paddingRight: 18, cursor: "pointer" }} onClick={() => setOpenTaskId(t.id)}>{t.title}</div>
                    {t.description && <div className="td">{t.description}</div>}
                    {steps.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <button
                          onClick={() => setExpanded({ ...expanded, [t.id]: !isOpen })}
                          style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", background: "var(--panel)", border: "1px solid var(--hair)", borderRadius: 6, padding: "6px 8px", fontSize: 11, color: "var(--muted)", textAlign: "left" }}
                        >
                          <span style={{ flexShrink: 0, fontWeight: 700, color: stepsDone === steps.length ? "var(--good)" : "var(--gold)" }}>{stepsDone}/{steps.length}</span>
                          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nextStep ? `Next: ${nextStep.text}` : "All steps done"}</span>
                          <ChevronRight size={12} style={{ flexShrink: 0, transform: isOpen ? "rotate(90deg)" : "none" }} />
                        </button>
                        {isOpen && (
                          <div style={{ marginTop: 6, paddingLeft: 4 }}>
                            {steps.map((s) => (
                              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                                <button className={`check-btn ${s.done ? "done" : ""}`} style={{ width: 16, height: 16 }} onClick={() => toggleStep(t.id, s.id)}><CheckCircle2 size={10} /></button>
                                <span style={{ fontSize: 11.5, textDecoration: s.done ? "line-through" : "none", opacity: s.done ? 0.55 : 1 }}>{s.text}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="task-meta">
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <Avatar name={t.assignee} />
                        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{t.assignee || "Unassigned"}</span>
                      </div>
                      <span className="due-tag" style={{ color: overdue ? "var(--alert)" : "var(--muted)" }}>
                        {overdue ? "Overdue" : fmtDate(t.dueDate)}
                      </span>
                    </div>
                    <select className="status-select" value={t.status} onChange={(e) => updateStatus(t.id, e.target.value)}>
                      {STATUS.map((s) => <option value={s.id} key={s.id}>{s.label}</option>)}
                    </select>
                  </div>
                );
              })}
              {items.length === 0 && <div className="empty" style={{ padding: "18px 4px" }}>Nothing here</div>}
            </div>
          );
        })}
      </div>

      {showForm && (
        <Modal title="Assign a duty" onClose={() => setShowForm(false)}>
          <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Cut Reels for launch" autoFocus /></div>
          <div className="field"><label>Details</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Any brief, links, or notes" /></div>
          <div className="field-row">
            <div className="field"><label>Action</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TASK_TYPES.map((t) => <option value={t.id} key={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div className="field"><label>Format</label>
              <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
                {CONTENT_FORMATS.map((f) => <option value={f.id} key={f.id}>{f.label}</option>)}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field"><label>Assignee</label><input list="member-list" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} placeholder="Name" />
              <datalist id="member-list">{members.map((m) => <option value={m} key={m} />)}</datalist>
            </div>
            <div className="field"><label>Due date</label><input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></div>
          </div>
          <div className="field"><label>Priority</label>
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              {PRIORITY.map((p) => <option value={p.id} key={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-gold" onClick={addTask}>Assign duty</button>
          </div>
        </Modal>
      )}

      {openTaskId && (
        <TaskDetailModal
          data={data} saveData={saveData} taskId={openTaskId} onClose={() => setOpenTaskId(null)}
          profile={profile} allAssignees={members} onDelete={removeTask} onOpenTask={(id) => setOpenTaskId(id)}
        />
      )}
    </div>
  );
}

/* ---------------------------------- Calendar ---------------------------------- */

const WEEK_HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 07:00 - 21:00
const HOUR_HEIGHT = 48; // px per hour in the day/week timelines
// A block in the day and week views is only as tall as its event is long, and
// whatever doesn't fit is cut off. That's fine on a laptop, where a title sits
// on one line; on a phone the column is a third as wide, the same title wraps
// to three lines, and a half-hour event showed the first few words. Give each
// hour roughly twice the room there so the text has somewhere to go.
const HOUR_HEIGHT_NARROW = 88;
// And a floor, so even a 15-minute event gets more than a clipped line.
const MIN_EVENT_HEIGHT = { day: 20, week: 18 };
const MIN_EVENT_HEIGHT_NARROW = { day: 44, week: 38 };

// Phone-width, and keeps up when the window is resized or the phone turned.
function useIsNarrow(query = "(max-width: 820px)") {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setNarrow(e.matches);
    setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

// Uses the same colour already assigned to that person's profile (visible on
// their avatar everywhere else) so one person reads as one colour consistently
// across the whole app, not just within the calendar.
function personColor(name, profiles) {
  if (!name) return "var(--muted)";
  const p = (profiles || []).find((pr) => pr.name === name);
  if (p && p.color) return `var(--${p.color})`;
  const ramp = ["var(--gold)", "var(--teal)", "var(--alert)", "var(--good)"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 997;
  return ramp[hash % ramp.length];
}

// Start/end of an event in minutes-since-midnight — events without an end
// time get a default visible block instead of a sliver.
function eventMinutes(e) {
  const [sh, sm] = (e.time || "09:00").split(":").map(Number);
  const startMin = (sh || 0) * 60 + (sm || 0);
  let endMin;
  if (e.endTime) {
    const [eh, em] = e.endTime.split(":").map(Number);
    endMin = (eh || 0) * 60 + (em || 0);
  }
  if (!endMin || endMin <= startMin) endMin = startMin + 45;
  return { startMin, endMin };
}

// Lays same-day events into side-by-side columns wherever their times overlap,
// instead of stacking them awkwardly in one slot.
function layoutDayEvents(events) {
  const withMin = events.map((e) => ({ ...e, ...eventMinutes(e) })).sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const colEnds = [];
  const placed = withMin.map((e) => {
    let col = colEnds.findIndex((end) => end <= e.startMin);
    if (col === -1) { col = colEnds.length; colEnds.push(e.endMin); }
    else colEnds[col] = e.endMin;
    return { ...e, col };
  });
  const totalCols = Math.max(colEnds.length, 1);
  return placed.map((e) => ({ ...e, totalCols }));
}

function startOfWeek(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  dt.setDate(dt.getDate() - day);
  dt.setHours(0, 0, 0, 0);
  return dt;
}
function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function Calendar({ data, saveData, profile }) {
  // Tapping the mark flips just that event between done and planned. Going
  // back lands on "Planned" rather than whatever it was before — the previous
  // status isn't recorded anywhere, and guessing would be worse than saying so.
  const toggleDone = (event) => {
    const next = calStatus(event).done ? "planned" : "posted";
    saveData({ ...data, calendarEvents: data.calendarEvents.map((x) => (x.id === event.id ? { ...x, status: next } : x)) });
  };
  const isNarrow = useIsNarrow();
  const hourHeight = isNarrow ? HOUR_HEIGHT_NARROW : HOUR_HEIGHT;
  const minEventHeight = isNarrow ? MIN_EVENT_HEIGHT_NARROW : MIN_EVENT_HEIGHT;
  const [mode, setMode] = useState("week"); // "week" | "month" | "day"
  const [justMine, setJustMine] = useState(false);
  const [cursor, setCursor] = useState(new Date());
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", date: todayISO(), time: "09:00", endTime: "", type: "post", status: "planned", notes: "", assignee: "", remind: false, reminderMinutesBefore: 30 });
  const [editId, setEditId] = useState(null);

  const allAssignees = [...new Set([...(data.profiles || []).map((p) => p.name), ...data.calendarEvents.map((e) => e.assignee).filter(Boolean)])];

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = startOffset - 1; i >= 0; i--) cells.push({ day: daysInPrev - i, out: true, iso: null });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ day: d, out: false, iso });
  }
  while (cells.length % 7 !== 0) cells.push({ day: cells.length, out: true, iso: null });

  const visibleEvents = justMine && profile ? data.calendarEvents.filter((e) => e.assignee === profile) : data.calendarEvents;
  const eventsByDate = {};
  visibleEvents.forEach((e) => { (eventsByDate[e.date] = eventsByDate[e.date] || []).push(e); });

  const saveEvent = () => {
    if (!form.title.trim()) return;
    if (editId) {
      saveData({ ...data, calendarEvents: data.calendarEvents.map((e) => (e.id === editId ? { ...e, ...form, reminderSent: false } : e)) });
    } else {
      saveData({ ...data, calendarEvents: [...data.calendarEvents, { id: uid(), ...form }] });
    }
    setForm({ title: "", date: form.date, time: form.time, endTime: "", type: "post", status: "planned", notes: "", assignee: "", remind: false, reminderMinutesBefore: 30 });
    setEditId(null);
    setShowForm(false);
  };
  const removeEvent = (id) => {
    saveData({ ...data, calendarEvents: data.calendarEvents.filter((e) => e.id !== id) });
    if (editId === id) { setEditId(null); setForm({ ...form, title: "" }); }
  };

  const openAdd = (iso, time) => {
    setForm({ title: "", date: iso, time: time || "09:00", endTime: "", type: "post", status: "planned", notes: "", assignee: profile || "", remind: false, reminderMinutesBefore: 30 });
    setEditId(null);
    setShowForm(true);
  };
  const openEdit = (e) => {
    setForm({ title: e.title, date: e.date, time: e.time || "09:00", endTime: e.endTime || "", type: e.type || "post", status: e.status || "planned", notes: e.notes || "", assignee: e.assignee || "", remind: !!e.remind, reminderMinutesBefore: e.reminderMinutesBefore || 30 });
    setEditId(e.id);
    setShowForm(true);
  };

  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const weekStart = startOfWeek(cursor);
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
  const weekLabel = `${weekDays[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekDays[6].toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  const stepWeek = (dir) => { const d = new Date(cursor); d.setDate(d.getDate() + dir * 7); setCursor(d); };

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Calendar</div><div className="page-sub">Posting dates, deadlines, and meetings — by day and time.</div></div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div className="view-toggle">
            <button className={mode === "day" ? "active" : ""} onClick={() => setMode("day")}>Day</button>
            <button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>Week</button>
            <button className={mode === "month" ? "active" : ""} onClick={() => setMode("month")}>Month</button>
          </div>
          {profile && (
            <button className={`chip ${justMine ? "active" : ""}`} onClick={() => setJustMine(!justMine)}>Just mine</button>
          )}
          <button className="btn" onClick={() => saveData({ ...data, calendarEvents: [...data.calendarEvents, ...buildExamples().calendarEvents] })}>See example events</button>
          <button className="btn btn-gold" onClick={() => openAdd(todayISO())}><Plus size={15} /> Add event</button>
        </div>
      </div>

      {mode === "day" ? (
        <div className="card">
          <div className="cal-head">
            <div className="cal-month display">{cursor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
            <div className="cal-nav">
              <button className="btn-ghost btn" onClick={() => { const d = new Date(cursor); d.setDate(d.getDate() - 1); setCursor(d); }}><ChevronLeft size={16} /></button>
              <button className="btn-ghost btn" onClick={() => setCursor(new Date())}>Today</button>
              <button className="btn-ghost btn" onClick={() => { const d = new Date(cursor); d.setDate(d.getDate() + 1); setCursor(d); }}><ChevronRight size={16} /></button>
            </div>
          </div>
          {(() => {
            const dayIso = isoOf(cursor);
            const dayEvents = eventsByDate[dayIso] || [];
            const laidOut = layoutDayEvents(dayEvents);
            const totalHeight = WEEK_HOURS.length * hourHeight;
            const gridStartMin = WEEK_HOURS[0] * 60;
            return (
              <div style={{ display: "flex" }}>
                <div style={{ width: 52, flexShrink: 0 }}>
                  {WEEK_HOURS.map((h) => (
                    <div key={h} style={{ height: hourHeight, fontSize: 10.5, color: "var(--muted)", textAlign: "right", paddingRight: 8, borderTop: "1px solid var(--hair)" }}>{String(h).padStart(2, "0")}:00</div>
                  ))}
                </div>
                <div style={{ position: "relative", flex: 1, height: totalHeight, borderLeft: "1px solid var(--hair)" }}>
                  {WEEK_HOURS.map((h, hi) => (
                    <div
                      key={h}
                      onClick={() => openAdd(dayIso, `${String(h).padStart(2, "0")}:00`)}
                      style={{ position: "absolute", top: hi * hourHeight, left: 0, right: 0, height: hourHeight, borderTop: "1px solid var(--hair)", cursor: "pointer" }}
                    />
                  ))}
                  {laidOut.map((e) => {
                    const st = calStatus(e);
                    const top = ((e.startMin - gridStartMin) / 60) * hourHeight;
                    const height = Math.max(((e.endMin - e.startMin) / 60) * hourHeight - 2, minEventHeight.day);
                    const widthPct = 100 / e.totalCols;
                    return (
                      <div
                        key={e.id}
                        onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}
                        style={{ position: "absolute", top, height, left: `${e.col * widthPct}%`, width: `calc(${widthPct}% - 4px)`, background: personColor(e.assignee, data.profiles), color: "#171812", borderRadius: 6, padding: "5px 8px", fontSize: 11.5, fontWeight: 600, overflow: "hidden", cursor: "pointer", zIndex: 2, ...doneStyle(st) }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 4, verticalAlign: "-2px" }}><EventMark status={st} onToggle={() => toggleDone(e)} /></span>
                        {e.time}{e.endTime ? `–${e.endTime}` : ""} {e.title}
                        {e.assignee && <div style={{ fontSize: 10, fontWeight: 500, opacity: 0.75 }}>{e.assignee}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      ) : mode === "month" ? (
        <div className="card" style={{ overflowX: "auto" }}>
          <div className="cal-head">
            <div className="cal-month display">{monthLabel}</div>
            <div className="cal-nav">
              <button className="btn-ghost btn" onClick={() => setCursor(new Date(year, month - 1, 1))}><ChevronLeft size={16} /></button>
              <button className="btn-ghost btn" onClick={() => setCursor(new Date())}>Today</button>
              <button className="btn-ghost btn" onClick={() => setCursor(new Date(year, month + 1, 1))}><ChevronRight size={16} /></button>
            </div>
          </div>
          <div className="cal-grid">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div className="cal-dow" key={d}>{d}</div>)}
            {cells.map((c, i) => (
              <div
                key={i}
                className={`cal-cell ${c.out ? "out" : ""} ${c.iso === todayISO() ? "today" : ""}`}
                onClick={() => { if (c.iso) openAdd(c.iso); }}
              >
                <div className="dnum">{c.day}</div>
                {c.iso && (eventsByDate[c.iso] || []).sort((a, b) => (a.time || "").localeCompare(b.time || "")).slice(0, 3).map((e) => {
                  const st = calStatus(e);
                  return (
                    <div
                      className="cal-evt"
                      key={e.id}
                      title={`${e.title} — ${st.label}`}
                      style={{ borderLeftColor: personColor(e.assignee, data.profiles), borderLeftWidth: 3, background: st.done ? "var(--good-soft)" : undefined, ...doneStyle(st) }}
                      onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}
                    >
                      <EventMark status={st} size={10} onToggle={() => toggleDone(e)} />
                      <span className="evt-text">
                        {e.time ? `${e.time}${e.endTime ? `–${e.endTime}` : ""} · ` : ""}{e.title}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <div className="cal-head">
            <div className="cal-month display">{weekLabel}</div>
            <div className="cal-nav">
              <button className="btn-ghost btn" onClick={() => stepWeek(-1)}><ChevronLeft size={16} /></button>
              <button className="btn-ghost btn" onClick={() => setCursor(new Date())}>Today</button>
              <button className="btn-ghost btn" onClick={() => stepWeek(1)}><ChevronRight size={16} /></button>
            </div>
          </div>
          <div className="week-grid" style={{ minWidth: 640 }}>
            <div className="week-corner" />
            {weekDays.map((d) => {
              const iso = isoOf(d);
              return (
                <div key={iso} className={`week-head-cell ${iso === todayISO() ? "today" : ""}`}>
                  <div className="dow">{d.toLocaleDateString(undefined, { weekday: "short" })}</div>
                  <div className="dnum">{d.getDate()}</div>
                </div>
              );
            })}
            <div className="week-time-col">
              {WEEK_HOURS.map((h) => (
                <div key={h} style={{ height: hourHeight, fontSize: 9.5, color: "var(--muted)", textAlign: "right", paddingRight: 6, borderTop: "1px solid var(--hair)" }}>{String(h).padStart(2, "0")}:00</div>
              ))}
            </div>
            {weekDays.map((d) => {
              const iso = isoOf(d);
              const laidOut = layoutDayEvents(eventsByDate[iso] || []);
              const totalHeight = WEEK_HOURS.length * hourHeight;
              const gridStartMin = WEEK_HOURS[0] * 60;
              return (
                <div key={iso} style={{ position: "relative", height: totalHeight, borderLeft: "1px solid var(--hair)" }}>
                  {WEEK_HOURS.map((h, hi) => (
                    <div
                      key={h}
                      onClick={() => openAdd(iso, `${String(h).padStart(2, "0")}:00`)}
                      style={{ position: "absolute", top: hi * hourHeight, left: 0, right: 0, height: hourHeight, borderTop: "1px solid var(--hair)", cursor: "pointer" }}
                    />
                  ))}
                  {laidOut.map((e) => {
                    const st = calStatus(e);
                    const top = ((e.startMin - gridStartMin) / 60) * hourHeight;
                    const height = Math.max(((e.endMin - e.startMin) / 60) * hourHeight - 2, minEventHeight.week);
                    const widthPct = 100 / e.totalCols;
                    return (
                      <div
                        key={e.id}
                        title={`${e.time}${e.endTime ? `–${e.endTime}` : ""} · ${e.title}`}
                        onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}
                        style={{ position: "absolute", top, height, left: `${e.col * widthPct}%`, width: `calc(${widthPct}% - 3px)`, background: personColor(e.assignee, data.profiles), color: "#171812", borderRadius: 5, padding: "2px 5px", fontSize: 9.5, fontWeight: 700, lineHeight: 1.3, overflow: "hidden", cursor: "pointer", zIndex: 2, ...doneStyle(st) }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", marginRight: 3, verticalAlign: "-2px" }}><EventMark status={st} size={10} onToggle={() => toggleDone(e)} /></span>
                        {e.time} {e.title}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showForm && (
        <Modal title={editId ? "Edit calendar event" : "Add calendar event"} onClose={() => setShowForm(false)}>
          <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Product launch post" autoFocus /></div>
          <div className="field-row">
            <div className="field"><label>Date</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
            <div className="field"><label>Start</label><input type="time" value={form.time || "09:00"} onChange={(e) => setForm({ ...form, time: e.target.value })} /></div>
            <div className="field"><label>End (optional)</label><input type="time" value={form.endTime || ""} onChange={(e) => setForm({ ...form, endTime: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label>Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="post">Post</option><option value="photo">Photo</option><option value="graphic">Graphic</option><option value="deadline">Deadline</option><option value="meeting">Meeting</option><option value="other">Other</option>
              </select>
            </div>
            <div className="field"><label>Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {CAL_STATUS.map((s) => <option value={s.id} key={s.id}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div className="field"><label>Assignee</label>
            <input list="cal-assignee-list" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} placeholder="Who's responsible for this" />
            <datalist id="cal-assignee-list">{allAssignees.map((a) => <option value={a} key={a} />)}</datalist>
          </div>
          <div className="field"><label>Note (optional)</label><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Raw info, link, or anything quick to jot down" /></div>

          <div className="field">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={form.remind} onChange={(e) => setForm({ ...form, remind: e.target.checked })} style={{ width: "auto" }} />
              <Bell size={13} /> Remind {form.assignee || "the assignee"}
            </label>
            {form.remind && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <input type="number" min={0} value={form.reminderMinutesBefore} onChange={(e) => setForm({ ...form, reminderMinutesBefore: Math.max(0, Number(e.target.value) || 0) })} style={{ width: 70 }} />
                <span style={{ fontSize: 12, color: "var(--muted)" }}>minutes before it starts (plus a heads-up the morning of, either way)</span>
              </div>
            )}
          </div>

          {editId && (
            <button className="btn" style={{ borderColor: "var(--alert)", color: "var(--alert)", marginBottom: 14 }} onClick={() => removeEvent(editId)}><Trash2 size={13} /> Delete this event</button>
          )}
          {(eventsByDate[form.date] || []).filter((e) => e.id !== editId).length > 0 && (
            <div className="field">
              <label>Already on this day</label>
              {eventsByDate[form.date].filter((e) => e.id !== editId).sort((a, b) => (a.time || "").localeCompare(b.time || "")).map((e) => {
                const st = calStatus(e);
                return (
                  <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "6px 0", borderBottom: "1px solid var(--hair)", cursor: "pointer" }} onClick={() => openEdit(e)}>
                    <span>{e.time ? `${e.time} · ` : ""}{e.title}</span>
                    <span className="pill" style={{ background: st.color + "22", color: st.color }}>{st.label}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={() => setShowForm(false)}>Close</button>
            <button className="btn btn-gold" onClick={saveEvent}>{editId ? "Save changes" : "Add event"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------- Notes ---------------------------------- */

function Notes({ data, saveData }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ text: "", author: "", color: "gold" });

  const addNote = () => {
    if (!form.text.trim()) return;
    saveData({ ...data, notes: [{ id: uid(), date: todayISO(), pinned: false, ...form }, ...data.notes] });
    setForm({ text: "", author: form.author, color: "gold" });
    setShowForm(false);
  };
  const removeNote = (id) => saveData({ ...data, notes: data.notes.filter((n) => n.id !== id) });
  const togglePin = (id) => saveData({ ...data, notes: data.notes.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n)) });

  const sorted = [...data.notes].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Notes</div><div className="page-sub">Quick context, reminders, and things worth flagging to the team.</div></div>
        <button className="btn btn-gold" onClick={() => setShowForm(true)}><Plus size={15} /> Add note</button>
      </div>
      <div className="grid notes-grid">
        {sorted.map((n) => (
          <div key={n.id} className={`note-card ${n.color || "plain"}`}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              {n.pinned && <span style={{ fontSize: 10, color: "var(--gold)", fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}><Pin size={11} /> PINNED</span>}
              <div style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
                <button className="icon-btn" onClick={() => togglePin(n.id)}><Pin size={13} /></button>
                <button className="icon-btn" onClick={() => removeNote(n.id)}><Trash2 size={13} /></button>
              </div>
            </div>
            <div className="note-text">{n.text}</div>
            <div className="note-foot"><span>{n.author || "Team"}</span><span>{fmtDate(n.date)}</span></div>
          </div>
        ))}
        {sorted.length === 0 && <div className="empty">No notes yet — add the first one.</div>}
      </div>

      {showForm && (
        <Modal title="Add a note" onClose={() => setShowForm(false)}>
          <div className="field"><label>Note</label><textarea value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Write something the team should know" autoFocus /></div>
          <div className="field-row">
            <div className="field"><label>Your name</label><input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} placeholder="e.g. Priya" /></div>
            <div className="field"><label>Colour</label>
              <select value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })}>
                <option value="gold">Gold</option><option value="teal">Teal</option><option value="alert">Red</option><option value="plain">Plain</option>
              </select>
            </div>
          </div>
          <div className="modal-actions"><button className="btn" onClick={() => setShowForm(false)}>Cancel</button><button className="btn btn-gold" onClick={addNote}>Add note</button></div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------- Content review ---------------------------------- */

function youtubeId(url) {
  const m = (url || "").match(/(?:youtu\.be\/|v=|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
const fileKind = (file) => ((file.type || "").startsWith("image/") ? "image" : "video");

// What was actually uploaded wins over the format picked in the form — someone
// can upload a photo against a piece marked "Video / Reel", and it still needs
// to render as a photo rather than a video player that shows nothing.
function isPhotoItem(item) {
  if (item.mediaKind) return item.mediaKind === "image";
  return item.format === "photo" || item.format === "graphic";
}

// Everything Drive-hosted is played/shown through our own authenticated proxy
// rather than a public drive.google.com link — the team's Workspace restricts
// sharing outside the domain, so public links can't be relied on to render.
const driveMediaSrc = (fileId) => `/api/drive-stream?fileId=${fileId}`;

// Small previews pull Drive's own thumbnail instead of the full file — a wall
// of phone photos would otherwise transfer megabytes each to fill tiny squares.
const driveThumbSrc = (fileId, size = "s400") => `/api/drive-stream?fileId=${fileId}&thumb=1&size=${size}`;

// Drive can take a moment to generate a preview after an upload, and some files
// never get one. Hide the broken image rather than showing a torn-page icon —
// what is underneath (a dark tile, a play badge) reads fine on its own.
const hideBrokenThumb = (e) => { e.currentTarget.style.visibility = "hidden"; };

// Fire-and-forget cleanup so an abandoned or deleted upload doesn't sit in
// Drive forever taking up the team's space.
function deleteDriveFile(fileIdOrLink) {
  const fileId = fileIdOrLink && (fileIdOrLink.startsWith("http") ? driveFileId(fileIdOrLink) : fileIdOrLink);
  if (!fileId) return;
  fetch("/api/drive-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId }),
  }).catch(() => {});
}

function driveFileId(url) {
  const m = (url || "").match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) || (url || "").match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
function driveEmbedUrl(url) {
  const id = driveFileId(url);
  return id ? `https://drive.google.com/file/d/${id}/preview` : null;
}

// Uploads a file straight to Google Drive from the browser (never through Vercel's own
// server, so large videos don't hit the ~4.5MB serverless request limit — this is also
// the fastest a browser upload can go with free tools: Google's upload API has no way
// to split one file across parallel connections, so going straight there in one stream
// is already the shortest path). Two small backend calls bracket the real upload: one
// to get an authorized upload slot, one to make the finished file viewable by the team.
function uploadToDriveOnce(file, onProgress, profile) {
  return new Promise(async (resolve, reject) => {
    try {
      const startRes = await fetch("/api/drive-upload-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size, profile }),
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || !startData.sessionUrl) {
        reject(new Error(startData.error || "Couldn't start the upload — is Google Drive connected yet?"));
        return;
      }
      const targetFolderId = startData.folderId;

      const xhr = new XMLHttpRequest();
      xhr.open("PUT", startData.sessionUrl, true);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = async () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error("Upload to Drive failed (status " + xhr.status + ")"));
          return;
        }
        try {
          const uploaded = JSON.parse(xhr.responseText);
          const finalizeRes = await fetch("/api/drive-finalize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId: uploaded.id }),
          });
          const finalizeData = await finalizeRes.json().catch(() => ({}));
          if (!finalizeRes.ok || !finalizeData.link) {
            reject(new Error(finalizeData.error || "Uploaded, but couldn't make it viewable."));
            return;
          }
          resolve({ link: finalizeData.link, name: uploaded.name || file.name, kind: fileKind(file) });
        } catch (err) {
          reject(err);
        }
      };
      xhr.onerror = async () => {
        // Google's resumable-upload endpoint often omits the CORS header on its
        // final response — the file can finish uploading successfully even though
        // the browser reports this as an error and hides the real response from us.
        // Ask our own server (not subject to that CORS restriction) to look the
        // file up by name instead of assuming the upload actually failed.
        try {
          const finalizeRes = await fetch("/api/drive-finalize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: file.name, folderId: targetFolderId }),
          });
          const finalizeData = await finalizeRes.json().catch(() => ({}));
          if (!finalizeRes.ok || !finalizeData.link) {
            reject(new Error(finalizeData.error || "Network error during upload."));
            return;
          }
          resolve({ link: finalizeData.link, name: file.name, kind: fileKind(file) });
        } catch {
          reject(new Error("Network error during upload."));
        }
      };
      xhr.send(file);
    } catch (err) {
      reject(err);
    }
  });
}

// A flaky mobile connection shouldn't mean starting a big upload over by hand —
// this retries the whole thing a couple of times on a genuine failure (the
// CORS-masked "error" that actually succeeded is already recovered from inside
// uploadToDriveOnce, so a retry here means it really didn't go through).
// A photo straight off a phone is often 4-8MB at a resolution far beyond what
// anyone views it at. Shrinking it before upload cuts the storage it takes and
// the data every single future view costs, which is what actually adds up.
// Never blocks an upload: if anything here fails, the original goes as-is.
async function shrinkImage(file, maxDim = 1920, quality = 0.85) {
  if (!file.type || !file.type.startsWith("image/")) return file;
  if (file.type === "image/gif") return file; // resizing would drop the animation
  if (file.size < 400 * 1024) return file; // already small, leave it alone
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file; // no gain, keep the original
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function uploadToDrive(originalFile, onProgress, profile, onRetry) {
  return new Promise(async (resolve, reject) => {
    const file = await shrinkImage(originalFile);
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await uploadToDriveOnce(file, onProgress, profile);
        resolve(result);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          if (onRetry) onRetry(attempt + 1, maxAttempts);
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          if (onProgress) onProgress(0);
        }
      }
    }
    reject(lastErr);
  });
}

// Marks a piece of content as posted and cleans up every Drive file it ever
// used (current version + full history) — shared by Content Review and the
// Approved admin page so "posted" always means the same thing everywhere.
function publishContentItem(data, saveData, id) {
  const item = data.content.find((c) => c.id === id);
  saveData({ ...data, content: data.content.map((c) => (c.id === id ? { ...c, status: "published" } : c)) });
  if (item) {
    const fileIds = [item.link, ...(item.versions || []).map((v) => v.link)].map(driveFileId).filter(Boolean);
    Promise.all(
      fileIds.map((fileId) =>
        fetch("/api/drive-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId }) }).catch(() => {})
      )
    ).finally(() => {
      saveData({ ...data, content: data.content.map((c) => (c.id === id ? { ...c, status: "published", link: "", versions: [], driveArchived: true } : c)) });
    });
  }
}

function ContentReview({ data, saveData, profile, isEmployer }) {
  const [showForm, setShowForm] = useState(false);
  const [open, setOpen] = useState(null);
  const [loadedVideo, setLoadedVideo] = useState(null); // content id whose embed the user tapped play on
  const [commentText, setCommentText] = useState("");
  const [localCaption, setLocalCaption] = useState("");
  const fileInputRef = useRef(null);
  const [form, setForm] = useState({ title: "", platform: "Instagram", link: "", assignee: "", format: "video", mediaKind: "" });
  const [scheduled, setScheduled] = useState({}); // { [contentId]: true } — just for the "added" confirmation text
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [uploadRetry, setUploadRetry] = useState("");
  const [sizeNotice, setSizeNotice] = useState("");
  const [versionUploadTarget, setVersionUploadTarget] = useState(null); // which item the picker was opened for
  const [versionUploading, setVersionUploading] = useState(null); // which item has an upload actually in flight
  const [versionUploadProgress, setVersionUploadProgress] = useState(0);
  const [versionUploadRetry, setVersionUploadRetry] = useState("");
  const [versionUploadErrorFor, setVersionUploadErrorFor] = useState(null); // { id, message }
  const versionFileInputRef = useRef(null);

  const handleFileSelect = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    // Swapping the file before posting leaves the first one orphaned in Drive.
    deleteDriveFile(form.link);
    // Not a blocker, just worth knowing: a huge clip costs that much again
    // every time someone watches it.
    setSizeNotice(
      file.size > 150 * 1024 * 1024
        ? `That's a ${Math.round(file.size / 1e6)}MB file. It'll upload fine, but exporting at 1080p instead of 4K makes it far quicker to load for everyone reviewing it.`
        : ""
    );
    setUploading(true);
    setUploadProgress(0);
    setUploadError("");
    setUploadRetry("");
    try {
      const result = await uploadToDrive(file, setUploadProgress, profile, (attempt, max) => setUploadRetry(`Connection hiccup — retrying (${attempt}/${max})…`));
      setForm((f) => ({
        ...f,
        link: result.link,
        mediaKind: result.kind,
        // Uploading a photo against the default "Video / Reel" format would
        // otherwise leave it mislabelled.
        format: result.kind === "image" && f.format === "video" ? "photo" : f.format,
        title: f.title || result.name.replace(/\.[^/.]+$/, ""),
      }));
    } catch (err) {
      setUploadError(err.message || "Upload failed.");
    }
    setUploading(false);
    setUploadRetry("");
    e.target.value = "";
  };

  const addItem = () => {
    if (!form.title.trim()) return;
    const item = { id: uid(), status: "review", comments: [], caption: "", uploadedBy: profile || "", visibility: "private", ...form };
    // Only the leads need to know a new piece landed — the rest of the team
    // isn't notified about every upload, just the people who need to know.
    const leads = (data.profiles || []).filter((p) => p.isLead && p.name !== profile).map((p) => p.name);
    const notifications = [
      ...(data.notifications || []),
      ...leads.map((leadName) => makeNotification({ toProfile: leadName, type: "upload", text: `${profile || "Someone"} uploaded: ${item.title}`, link: "content", fromProfile: profile })),
    ];
    saveData({ ...data, content: [item, ...data.content], notifications });
    leads.forEach((leadName) => sendPush(leadName, "New content uploaded", `${profile || "Someone"} uploaded: ${item.title}`, profile));
    setForm({ title: "", platform: "Instagram", link: "", assignee: "", format: "video", mediaKind: "" });
    setShowForm(false);
  };
  // Backing out of the form after uploading would otherwise leave the file
  // sitting in Drive with nothing in the app pointing at it.
  const cancelAdd = () => {
    if (!uploading) deleteDriveFile(form.link);
    setForm({ title: "", platform: "Instagram", link: "", assignee: "", format: "video", mediaKind: "" });
    setShowForm(false);
  };
  const makePublic = (id) => saveData({ ...data, content: data.content.map((c) => (c.id === id ? { ...c, visibility: "public" } : c)) });
  const updateStatus = (id, status) => {
    if (status === "published") {
      publishContentItem(data, saveData, id);
      return;
    }
    const item = data.content.find((c) => c.id === id);
    let notifications = data.notifications || [];
    const congratsWorthy = status === "approved" && item && item.uploadedBy && item.uploadedBy !== profile;
    if (congratsWorthy) {
      notifications = [...notifications, makeNotification({ toProfile: item.uploadedBy, type: "approved", text: `Your content was approved: ${item.title}`, link: "content", fromProfile: profile })];
    }
    saveData({ ...data, content: data.content.map((c) => (c.id === id ? { ...c, status } : c)), notifications });
    if (congratsWorthy) sendPush(item.uploadedBy, "Content approved! 🎉", `"${item.title}" is ready to post.`, profile);
  };
  const uploadNewVersion = (id) => {
    setVersionUploadTarget(id);
    setVersionUploadErrorFor(null);
    setTimeout(() => versionFileInputRef.current && versionFileInputRef.current.click(), 0);
  };
  const handleVersionFileSelect = async (e) => {
    const file = e.target.files && e.target.files[0];
    const id = versionUploadTarget;
    if (!file || !id) return;
    setVersionUploading(id);
    setVersionUploadProgress(0);
    setVersionUploadRetry("");
    try {
      const result = await uploadToDrive(file, setVersionUploadProgress, profile, (attempt, max) => setVersionUploadRetry(`Connection hiccup — retrying (${attempt}/${max})…`));
      const item = data.content.find((c) => c.id === id);
      if (!item) {
        // Someone deleted the piece while this was uploading — don't strand the
        // file in Drive with nothing pointing at it.
        deleteDriveFile(result.link);
        throw new Error("That piece was removed while this was uploading.");
      }
      const versions = item.link ? [...(item.versions || []), { link: item.link, date: todayISO(), by: profile || "", mediaKind: item.mediaKind || "video" }] : (item.versions || []);
      const leads = (data.profiles || []).filter((p) => p.isLead && p.name !== profile).map((p) => p.name);
      const notifications = [
        ...(data.notifications || []),
        ...leads.map((leadName) => makeNotification({ toProfile: leadName, type: "upload", text: `${profile || "Someone"} uploaded a new version: ${item.title}`, link: "content", fromProfile: profile })),
      ];
      saveData({
        ...data,
        content: data.content.map((c) => (c.id === id ? { ...c, link: result.link, mediaKind: result.kind, status: "review", versions, driveArchived: false } : c)),
        notifications,
      });
      leads.forEach((leadName) => sendPush(leadName, "New version uploaded", `${profile || "Someone"} uploaded a new version: ${item.title}`, profile));
    } catch (err) {
      setVersionUploadErrorFor({ id, message: err.message || "Upload failed." });
    }
    setVersionUploading(null);
    setVersionUploadTarget(null);
    setVersionUploadRetry("");
    e.target.value = "";
  };
  // Deleting a piece takes its Drive files with it — current version and the
  // whole history — so nothing is left orphaned in the team's folder.
  const removeItem = (id) => {
    const item = data.content.find((c) => c.id === id);
    if (item) [item.link, ...(item.versions || []).map((v) => v.link)].forEach(deleteDriveFile);
    saveData({ ...data, content: data.content.filter((c) => c.id !== id) });
  };
  const addComment = (id) => {
    if (!commentText.trim()) return;
    const item = data.content.find((c) => c.id === id);
    const comment = { id: uid(), author: profile || "Someone", text: commentText, date: todayISO() };
    // Only the person whose content this is gets told about a comment on it —
    // not the whole team, and not for comments left on other people's work.
    const notifyOwner = item && item.uploadedBy && item.uploadedBy !== profile;
    const notifications = notifyOwner
      ? [...(data.notifications || []), makeNotification({ toProfile: item.uploadedBy, type: "note", text: `${profile || "Someone"} commented on: ${item.title}`, link: "content", fromProfile: profile })]
      : (data.notifications || []);
    saveData({
      ...data,
      content: data.content.map((c) => (c.id === id ? { ...c, comments: [...c.comments, comment] } : c)),
      notifications,
    });
    if (notifyOwner) sendPush(item.uploadedBy, "New comment on your upload", `${profile || "Someone"} commented on: ${item.title}`, profile);
    setCommentText("");
  };
  const updateCaption = (id, caption) => saveData({ ...data, content: data.content.map((c) => (c.id === id ? { ...c, caption } : c)) });
  const debouncedUpdateCaption = useDebouncedCallback(updateCaption, 500);
  const openItem = (id) => {
    setOpen(open === id ? null : id);
    if (open !== id) {
      const item = data.content.find((c) => c.id === id);
      setLocalCaption(item ? item.caption || "" : "");
    }
  };
  const addToCalendar = (c) => {
    const type = c.format === "photo" ? "photo" : c.format === "graphic" ? "graphic" : "post";
    const event = { id: uid(), title: c.title, date: todayISO(), time: "09:00", type, assignee: c.assignee || "", status: "planned", notes: "Scheduled from Content Review" };
    saveData({ ...data, calendarEvents: [...data.calendarEvents, event] });
    setScheduled({ ...scheduled, [c.id]: true });
  };

  // Uploads default to private — visible to whoever uploaded them and to leads,
  // until the uploader (or a lead) makes it public for the whole team to see.
  const visibleContent = data.content.filter((c) => c.status !== "published" && (isEmployer || !c.uploadedBy || c.uploadedBy === profile || c.visibility === "public"));

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Content Review</div><div className="page-sub">Drop in a link, leave feedback, mark it ready to publish.</div></div>
        <button className="btn btn-gold" onClick={() => setShowForm(true)}><Plus size={15} /> Add content</button>
      </div>

      <div className="content-list">
        {visibleContent.map((c) => {
          const st = CONTENT_STATUS.find((s) => s.id === c.status) || CONTENT_STATUS[0];
          const fmt = CONTENT_FORMATS.find((f) => f.id === c.format) || CONTENT_FORMATS[0];
          const FmtIcon = fmt.icon;
          const yt = youtubeId(c.link);
          const driveId = !yt ? driveFileId(c.link) : null;
          const isPhoto = isPhotoItem(c);
          const isOpen = open === c.id;
          return (
            <div className="content-item" key={c.id}>
              <div className="content-head" onClick={() => openItem(c.id)}>
                <div className="content-thumb" style={{ color: fmt.color }}><FmtIcon size={19} /></div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div className="content-title">{c.title}</div>
                  <div className="content-tags">
                    {c.uploadedBy && <span className="pill" style={{ background: "var(--gold-soft)", color: "var(--gold)" }}>from {c.uploadedBy}</span>}
                    <span className="pill" style={{ background: fmt.color + "22", color: fmt.color }}>{fmt.label}</span>
                    <span className="pill" style={{ background: "var(--panel-raised)", color: "var(--muted)" }}>{c.platform}</span>
                    <span className="pill" style={{ background: st.color + "22", color: st.color }}>{st.label}</span>
                    {c.assignee && <span className="pill" style={{ background: "var(--panel-raised)", color: "var(--muted)" }}>{c.assignee}</span>}
                    {c.comments.length > 0 && <span className="pill" style={{ background: "var(--panel-raised)", color: "var(--muted)" }}><MessageSquare size={10} style={{ verticalAlign: "-1px", marginRight: 3 }} />{c.comments.length}</span>}
                    {c.uploadedBy && c.visibility !== "public" && (
                      <span className="pill" style={{ background: "var(--panel-raised)", color: "var(--muted)" }}><Lock size={10} style={{ verticalAlign: "-1px", marginRight: 3 }} />Private</span>
                    )}
                  </div>
                </div>
                <button className="icon-btn" onClick={(e) => { e.stopPropagation(); removeItem(c.id); }}><Trash2 size={14} /></button>
              </div>

              {isOpen && (
                <div className="content-body">
                  <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                    <button className="btn" style={{ flex: 1, minWidth: 130, justifyContent: "center", background: c.status === "approved" ? "var(--good-soft)" : undefined, borderColor: c.status === "approved" ? "var(--good)" : undefined, color: c.status === "approved" ? "var(--good)" : undefined }} onClick={() => updateStatus(c.id, "approved")}>
                      <CheckCircle2 size={13} /> Approve
                    </button>
                    <button className="btn" style={{ flex: 1, minWidth: 130, justifyContent: "center", background: c.status === "review" ? "var(--alert-soft)" : undefined, borderColor: c.status === "review" ? "var(--alert)" : undefined, color: c.status === "review" ? "var(--alert)" : undefined }} onClick={() => updateStatus(c.id, "review")}>
                      <AlertTriangle size={13} /> Needs changes
                    </button>
                    <button className="btn" style={{ padding: "9px 12px" }} onClick={() => addToCalendar(c)}>
                      <CalendarDays size={13} /> {scheduled[c.id] ? "Added ✓" : "Add to Calendar"}
                    </button>
                    {c.uploadedBy && c.visibility !== "public" && (c.uploadedBy === profile || isEmployer) && (
                      <button className="btn" style={{ padding: "9px 12px" }} onClick={() => makePublic(c.id)} title="Share this with the whole team instead of just you and the leads">
                        <Globe size={13} /> Make public
                      </button>
                    )}
                  </div>
                  <div className="field-row" style={{ marginBottom: 14 }}>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>Status</label>
                      <select value={c.status} onChange={(e) => updateStatus(c.id, e.target.value)}>
                        {CONTENT_STATUS.map((s) => <option value={s.id} key={s.id}>{s.label}</option>)}
                      </select>
                    </div>
                    {c.link && (
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label>Link</label>
                        <a href={c.link} target="_blank" rel="noopener noreferrer" className="btn" style={{ justifyContent: "center", textDecoration: "none" }}>
                          <ExternalLink size={13} /> Open
                        </a>
                      </div>
                    )}
                  </div>

                  <div className="field">
                    <label>Caption</label>
                    <textarea value={localCaption} onChange={(e) => { setLocalCaption(e.target.value); debouncedUpdateCaption(c.id, e.target.value); }} placeholder="The caption or copy that shipped with this piece…" />
                  </div>

                  {yt && (
                    <div style={{ position: "relative", paddingTop: "56.25%", marginBottom: 16, borderRadius: 8, overflow: "hidden", background: "var(--panel-raised)" }}>
                      {loadedVideo === c.id ? (
                        <iframe
                          src={`https://www.youtube.com/embed/${yt}`}
                          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
                          allowFullScreen title={c.title}
                        />
                      ) : (
                        <button
                          onClick={() => setLoadedVideo(c.id)}
                          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                        >
                          <span style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--gold)", color: "#12141B", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <Play size={18} fill="#12141B" />
                          </span>
                        </button>
                      )}
                    </div>
                  )}
                  {driveId && (
                    // Streamed through our own server rather than a Google preview
                    // iframe or public link — the iframe renders badly on mobile, and
                    // public drive.google.com links can't be relied on under this
                    // team's Workspace sharing restrictions.
                    <div style={{ marginBottom: 16, borderRadius: 8, overflow: "hidden", background: "#000", display: "flex", justifyContent: "center" }}>
                      {isPhoto ? (
                        <img src={driveThumbSrc(driveId, "s1600")} onError={hideBrokenThumb} alt={c.title} style={{ width: "100%", maxHeight: "78vh", objectFit: "contain", display: "block" }} />
                      ) : loadedVideo === c.id ? (
                        <video
                          src={driveMediaSrc(driveId)}
                          controls
                          autoPlay
                          playsInline
                          style={{ width: "100%", maxHeight: "78vh", display: "block" }}
                        />
                      ) : (
                        <button
                          onClick={() => setLoadedVideo(c.id)}
                          style={{ width: "100%", aspectRatio: "16 / 9", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                        >
                          <span style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--gold)", color: "#12141B", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <Play size={18} fill="#12141B" />
                          </span>
                        </button>
                      )}
                    </div>
                  )}
                  {!yt && !driveId && c.driveArchived && (
                    <div className="empty" style={{ padding: "10px 0", marginBottom: 8 }}>
                      Published — file removed from Drive to save space.
                    </div>
                  )}

                  {c.status !== "published" && (
                    <div style={{ marginBottom: 14 }}>
                      <button
                        type="button"
                        className="btn"
                        style={{ width: "100%", justifyContent: "center", cursor: versionUploading === c.id ? "default" : "pointer", opacity: versionUploading === c.id ? 0.7 : 1 }}
                        onClick={() => uploadNewVersion(c.id)}
                        disabled={versionUploading === c.id}
                      >
                        <RotateCw size={13} /> {versionUploading === c.id ? (versionUploadRetry || `Uploading… ${versionUploadProgress}%`) : "Upload a fixed version"}
                      </button>
                      {versionUploading === c.id && (
                        <div className="progress-track" style={{ marginTop: 8 }}>
                          <div className="progress-fill" style={{ width: `${versionUploadProgress}%`, background: "var(--gold)" }} />
                        </div>
                      )}
                      {versionUploadErrorFor && versionUploadErrorFor.id === c.id && <div style={{ fontSize: 11.5, color: "var(--alert)", marginTop: 6 }}>{versionUploadErrorFor.message}</div>}
                    </div>
                  )}

                  {c.versions && c.versions.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div className="section-title" style={{ fontSize: 13 }}><RotateCw size={14} color="var(--gold)" /> Version history</div>
                      {[...c.versions].reverse().map((v, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 2px", fontSize: 12, color: "var(--muted)" }}>
                          <span style={{ flex: 1 }}>Version {c.versions.length - i} — {v.by || "someone"} · {fmtDate(v.date)}</span>
                          {v.link && <a href={v.link} target="_blank" rel="noopener noreferrer" style={{ color: "var(--gold)", display: "inline-flex", alignItems: "center", gap: 4, textDecoration: "none" }}><ExternalLink size={11} /> View</a>}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="section-title" style={{ fontSize: 13 }}><MessageSquare size={14} color="var(--gold)" /> Feedback</div>
                  {c.comments.map((cm) => (
                    <div className="comment" key={cm.id}>
                      <Avatar name={cm.author} />
                      <div style={{ flex: 1 }}>
                        <div className="comment-text">{cm.text}</div>
                        <div className="comment-meta">{cm.author} · {fmtDate(cm.date)}</div>
                      </div>
                    </div>
                  ))}
                  {c.comments.length === 0 && <div className="empty" style={{ padding: "10px 0" }}>No feedback yet.</div>}
                  <div className="comment-form">
                    <textarea placeholder="Leave feedback on what to improve…" value={isOpen ? commentText : ""} onChange={(e) => setCommentText(e.target.value)} />
                    <button className="btn btn-gold" style={{ alignSelf: "flex-end" }} onClick={() => addComment(c.id)}><Send size={14} /></button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {visibleContent.length === 0 && <div className="empty">Nothing submitted yet.</div>}
      </div>

      <input ref={versionFileInputRef} type="file" accept="video/*,image/*" onChange={handleVersionFileSelect} style={{ display: "none" }} />

      {showForm && (
        <Modal title="Add content for review" onClose={cancelAdd}>
          <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Launch teaser — 15s cut" autoFocus /></div>

          <div className="field">
            <label>Upload video or photo</label>
            <button
              type="button"
              className="btn"
              style={{ width: "100%", justifyContent: "center", cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.7 : 1 }}
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
              disabled={uploading}
            >
              <Upload size={14} /> {uploading ? (uploadRetry || `Uploading… ${uploadProgress}%`) : "Choose a file"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,image/*"
              onChange={handleFileSelect}
              disabled={uploading}
              style={{ display: "none" }}
            />
            {uploading && (
              <div className="progress-track" style={{ marginTop: 8 }}>
                <div className="progress-fill" style={{ width: `${uploadProgress}%`, background: "var(--gold)" }} />
              </div>
            )}
            {uploadError && <div style={{ fontSize: 11.5, color: "var(--alert)", marginTop: 6 }}>{uploadError}</div>}
            {sizeNotice && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6, lineHeight: 1.5 }}>{sizeNotice}</div>}
            {!uploading && form.link && driveEmbedUrl(form.link) && (
              <div style={{ fontSize: 11.5, color: "var(--good)", marginTop: 6, display: "flex", alignItems: "center", gap: 5 }}><Check size={12} /> Uploaded — ready to add.</div>
            )}
          </div>

          <div className="field"><label>Or paste a link instead</label><input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="YouTube, Drive, or post link" /></div>

          <div className="field-row">
            <div className="field"><label>Format</label>
              <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
                {CONTENT_FORMATS.map((f) => <option value={f.id} key={f.id}>{f.label}</option>)}
              </select>
            </div>
            <div className="field"><label>Platform</label>
              <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
                <option>Instagram</option><option>TikTok</option><option>YouTube</option><option>X</option><option>LinkedIn</option><option>Other</option>
              </select>
            </div>
          </div>
          <div className="field"><label>Assignee</label><input value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} placeholder="Who made this" /></div>
          <div className="modal-actions"><button className="btn" onClick={cancelAdd}>Cancel</button><button className="btn btn-gold" onClick={addItem} disabled={uploading}>Add</button></div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------- Idea bank ---------------------------------- */

function IdeaBank({ data, saveData, profile }) {
  // Phone width decides whether the panel sits beside the board or under it.
  const isNarrow = useIsNarrow();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", tags: "", author: "", link: "", color: IDEA_COLORS[0] });
  const [showFolderForm, setShowFolderForm] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [openFolderId, setOpenFolderId] = useState(null);
  const [openIdeaId, setOpenIdeaId] = useState(null);

  const folders = data.ideaFolders || [];
  const ideas = data.ideas || [];

  // Undo can't just put an old copy of the board back: someone else may have
  // added a picture in the meantime, and restoring a snapshot would delete it.
  // Each entry remembers the board either side of one of my changes, and
  // undoing replays that change backwards onto the board as it stands now,
  // through the same merge that lets two people edit at once. So undo reverses
  // what I did and leaves what everyone else did alone.
  const historyRef = useRef({ past: [], future: [] });
  const [historyDepth, setHistoryDepth] = useState({ past: 0, future: 0 });
  const noteDepth = () => setHistoryDepth({ past: historyRef.current.past.length, future: historyRef.current.future.length });

  const edit = (next) => {
    const h = historyRef.current;
    h.past.push({ before: data, after: next });
    if (h.past.length > 50) h.past.shift();
    h.future = [];
    noteDepth();
    saveData(next);
  };
  const undo = () => {
    const h = historyRef.current;
    const step = h.past.pop();
    if (!step) return;
    h.future.push(step);
    noteDepth();
    saveData(mergeState(step.after, step.before, data));
  };
  const redo = () => {
    const h = historyRef.current;
    const step = h.future.pop();
    if (!step) return;
    h.past.push(step);
    noteDepth();
    saveData(mergeState(step.before, step.after, data));
  };

  // What's picked, so the toolbar knows what it's acting on. One at a time —
  // multi-select is a bigger job and isn't in this batch.
  // A list rather than one thing. Everything written before multi-select acts
  // on the first entry, so `selected` and `setSelected` still mean what they
  // did and only the actions that genuinely work on many had to learn about it.
  const [selection, setSelection] = useState([]); // [{ kind, id }]
  const selected = selection[0] || null;
  const setSelected = (one) => setSelection(one ? [one] : []);
  const isPicked = (kind, id) => selection.some((sel) => sel.kind === kind && sel.id === id);

  // Grouped things are picked together: that's the whole point of grouping.
  const groupMatesOf = (kind, id) => {
    const el = listFor(kind).find((x) => x.id === id);
    if (!el || !el.groupId) return [{ kind, id }];
    const mates = [];
    for (const k of ["item", "idea", "folder", "shape"]) {
      for (const x of listFor(k)) if (x.groupId === el.groupId) mates.push({ kind: k, id: x.id });
    }
    return mates.length ? mates : [{ kind, id }];
  };

  // Tap replaces the selection; tap with Shift or Ctrl adds to it or takes it
  // back out, which is the gesture everything else on a computer uses.
  const pickElement = (kind, id, ev) => {
    const additive = ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey);
    const mates = groupMatesOf(kind, id);
    setSelection((current) => {
      if (!additive) return mates;
      const alreadyIn = current.some((sel) => sel.kind === kind && sel.id === id);
      if (alreadyIn) return current.filter((sel) => !mates.some((m) => m.kind === sel.kind && m.id === sel.id));
      const merged = [...current];
      for (const m of mates) if (!merged.some((sel) => sel.kind === m.kind && sel.id === m.id)) merged.push(m);
      return merged;
    });
    return true;
  };
  // Drawn outside the element's own box so it never covers the content, and
  // via outline rather than border so nothing shifts by 2px when picked.
  const pickedRing = (kind, id) => (isPicked(kind, id)
    ? { outline: "2px solid var(--gold)", outlineOffset: 3, borderRadius: 8 }
    : null);

  // Who else is on this board right now, and what they're touching. None of
  // this is saved — see src/livePresence.js.
  const myColor = ((data.profiles || []).find((p) => p.name === profile) || {}).color || "gold";
  const live = useLiveBoard("ideabank", profile, myColor, openFolderId);
  // Only show markers for people looking at the same board or folder as us.
  const liveHere = Object.values(live.activity).filter((a) => (a.where || null) === (openFolderId || null));
  const dragsHere = liveHere.filter((a) => a.kind === "drag");
  const strokesHere = liveHere.filter((a) => a.kind === "draw" && a.shape);
  const writersHere = liveHere.filter((a) => a.kind === "write");
  const writerOn = (id) => writersHere.find((a) => a.itemId === id);
  // A drag ends by sending "idle", but announce the tool too so a marker says
  // "moving" rather than just showing a box.
  const onDragSignal = (at) => (at ? live.signal({ kind: "drag", ...at }, true) : live.stop());

  // Backward compat: an idea saved before this feature existed has no
  // position/colour yet — give it one, cascading so old ideas don't pile up
  // on top of each other at the same spot.
  const positioned = ideas.map((idea, i) => ({
    ...idea,
    x: idea.x != null ? idea.x : 40 + (i % 6) * 170,
    y: idea.y != null ? idea.y : 40 + Math.floor(i / 6) * 150,
    color: idea.color || IDEA_COLORS[i % IDEA_COLORS.length],
  }));

  const boardIdeas = positioned.filter((i) => (openFolderId ? i.folderId === openFolderId : !i.folderId));
  const currentFolder = openFolderId ? folders.find((f) => f.id === openFolderId) : null;

  const saveFolderPos = (id, x, y, dx, dy) => {
    if (isLocked("folder", id)) return;
    const moved = dragSelectionBy("folder", id, dx || 0, dy || 0);
    const base = moved || data;
    edit({ ...base, ideaFolders: (base.ideaFolders || folders).map((f) => (f.id === id ? { ...f, x, y } : f)) });
  };
  const saveIdeaPos = (id, x, y, dx, dy) => {
    if (isLocked("idea", id)) return;
    const moved = dragSelectionBy("idea", id, dx || 0, dy || 0);
    const base = moved || data;
    edit({ ...base, ideas: (base.ideas || ideas).map((i) => (i.id === id ? { ...i, x, y } : i)) });
  };
  // A single tap only ever picks something up. Opening is a double-click, or
  // the Open button — never a second single click.
  //
  // It used to open on the second tap, which turned out to be dangerous rather
  // than merely surprising: picking something up makes the toolbar appear, and
  // while that toolbar pushed the board down, the second click of a
  // double-click landed wherever the first row of buttons had just slid to.
  // On a folder that was Delete. The toolbar no longer moves anything (it has
  // a reserved row of its own below), and a second click no longer acts.
  const tapToOpen = (kind, id, ev) => { pickElement(kind, id, ev); };
  // Double-click opens, and picks the thing up first so the toolbar is showing
  // the thing you just opened.
  const openOnDouble = (kind, id, open) => (ev) => {
    if (ev) ev.stopPropagation();
    setSelected({ kind, id });
    open();
  };
  const getZoom = () => zoomRef.current;
  const snapRef = useRef(null);
  const snapVia = (...args) => (snapRef.current ? snapRef.current(...args) : null);
  const folderDrag = useDraggable(saveFolderPos, (id, ev) => tapToOpen("folder", id, ev), onDragSignal, getZoom, snapVia);
  const ideaDrag = useDraggable(saveIdeaPos, (id, ev) => tapToOpen("idea", id, ev), onDragSignal, getZoom, snapVia);

  const addFolder = () => {
    if (!folderName.trim()) return;
    const count = folders.length;
    edit({ ...data, ideaFolders: [...folders, { id: uid(), name: folderName.trim(), x: 40 + (count % 5) * 140, y: 40 + Math.floor(count / 5) * 130, color: IDEA_COLORS[count % IDEA_COLORS.length] }] });
    setFolderName("");
    setShowFolderForm(false);
  };
  const removeFolder = (id) => {
    const folder = folders.find((f) => f.id === id);
    const insideCount = ideas.filter((i) => i.folderId === id).length + allBoardItems.filter((b) => b.folderId === id).length;
    if (insideCount > 0 && !window.confirm(`"${folder ? folder.name : "This folder"}" has ${insideCount} thing${insideCount === 1 ? "" : "s"} inside. They'll move back out to the main board, and anything drawn in here is removed. Delete the folder?`)) return;
    // Nothing the team put in is destroyed — ideas and pictures move back out
    // to the main board. Only the drawing is dropped, since strokes only make
    // sense against the layout they were drawn on.
    edit({
      ...data,
      ideaFolders: folders.filter((f) => f.id !== id),
      ideas: ideas.map((i) => (i.folderId === id ? { ...i, folderId: null } : i)),
      boardItems: allBoardItems.map((b) => (b.folderId === id ? { ...b, folderId: null } : b)),
      ideaDrawings: (data.ideaDrawings || []).filter((d) => d.folderId !== id),
    });
    if (openFolderId === id) setOpenFolderId(null);
  };

  const addIdea = () => {
    live.stop();
    if (!form.title.trim()) return;
    const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
    const count = boardIdeas.length;
    const item = { id: uid(), votes: [], ...form, tags, attachments: pendingIdeaAttachments, folderId: openFolderId, x: 40 + (count % 6) * 170, y: 40 + Math.floor(count / 6) * 150 };
    edit({ ...data, ideas: [item, ...ideas] });
    setForm({ title: "", description: "", tags: "", author: form.author, link: "", color: IDEA_COLORS[(count + 1) % IDEA_COLORS.length] });
    setPendingIdeaAttachments([]);
    setShowForm(false);
  };
  // Backing out after attaching would strand those files in Drive.
  const cancelAddIdea = () => {
    live.stop();
    pendingIdeaAttachments.forEach((a) => deleteDriveFile(a.fileId));
    setPendingIdeaAttachments([]);
    setShowForm(false);
  };
  // One vote per person, and tapping again takes it back.
  const vote = (id) => edit({
    ...data,
    ideas: ideas.map((idea) => {
      if (idea.id !== id) return idea;
      const current = withVoteList(idea);
      const votes = hasVoted(current, profile)
        ? voteList(current).filter((v) => v.id !== profile)
        : [...voteList(current), { id: profile, at: todayISO() }];
      return { ...current, votes };
    }),
  });
  const removeIdea = (id) => {
    const item = ideas.find((i) => i.id === id);
    // A duplicated idea carries the same attachments, so only drop a file from
    // Drive once nothing else on the board points at it.
    if (item) {
      (item.attachments || []).forEach((a) => {
        const usedByAnotherIdea = ideas.some((i) => i.id !== id && (i.attachments || []).some((x) => x.fileId === a.fileId));
        const usedByBoardItem = (data.boardItems || []).some((b) => b.fileId === a.fileId);
        if (!usedByAnotherIdea && !usedByBoardItem) deleteDriveFile(a.fileId);
      });
    }
    edit({ ...data, ideas: ideas.filter((i) => i.id !== id) });
    setOpenIdeaId(null);
    if (isPicked("idea", id)) setSelected(null);
  };
  const moveToFolder = (id, folderId) => edit({ ...data, ideas: ideas.map((i) => (i.id === id ? { ...i, folderId: folderId || null } : i)) });
  const setIdeaColor = (id, color) => edit({ ...data, ideas: ideas.map((i) => (i.id === id ? { ...i, color } : i)) });

  const ideaFileInputRef = useRef(null);
  const [ideaAttaching, setIdeaAttaching] = useState(false);
  const [ideaAttachProgress, setIdeaAttachProgress] = useState(0);
  const [ideaAttachError, setIdeaAttachError] = useState("");
  const [lightbox, setLightbox] = useState(null);
  const [pendingIdeaAttachments, setPendingIdeaAttachments] = useState([]);

  const handleIdeaFileSelect = async (e) => {
    const file = e.target.files && e.target.files[0];
    const id = openIdeaId;
    if (!file) return;
    setIdeaAttaching(true);
    setIdeaAttachProgress(0);
    setIdeaAttachError("");
    // Attaching while writing a new idea holds the file until the idea is
    // actually created; attaching from an open idea goes straight onto it.
    if (!id) {
      try {
        const result = await uploadToDrive(file, setIdeaAttachProgress, profile);
        setPendingIdeaAttachments((list) => [...list, { fileId: driveFileId(result.link), name: result.name, kind: result.kind }]);
      } catch (err) {
        setIdeaAttachError(err.message || "Upload failed.");
      }
      setIdeaAttaching(false);
      e.target.value = "";
      return;
    }
    try {
      const result = await uploadToDrive(file, setIdeaAttachProgress, profile);
      const fileId = driveFileId(result.link);
      const target = ideas.find((i) => i.id === id);
      if (!target) {
        deleteDriveFile(result.link);
        throw new Error("That idea was removed while this was uploading.");
      }
      edit({
        ...data,
        ideas: ideas.map((i) => (i.id === id ? { ...i, attachments: [...(i.attachments || []), { fileId, name: result.name, kind: result.kind }] } : i)),
      });
    } catch (err) {
      setIdeaAttachError(err.message || "Upload failed.");
    }
    setIdeaAttaching(false);
    e.target.value = "";
  };
  const removeIdeaAttachment = (ideaId, fileId) => {
    deleteDriveFile(fileId);
    edit({ ...data, ideas: ideas.map((i) => (i.id === ideaId ? { ...i, attachments: (i.attachments || []).filter((a) => a.fileId !== fileId) } : i)) });
  };

  const openIdea = openIdeaId ? positioned.find((i) => i.id === openIdeaId) : null;
  const openYt = openIdea ? youtubeId(openIdea.link) : null;
  const openDrive = openIdea && !openYt ? driveEmbedUrl(openIdea.link) : null;

  const BOARD_W = 1400, BOARD_H = 900;

  // ---- drawing layer ----
  const drawings = (data.ideaDrawings || []).filter((d) => (openFolderId ? d.folderId === openFolderId : !d.folderId));
  const [tool, setTool] = useState("move"); // move | pen | line | rect | circle | erase
  const [drawColor, setDrawColor] = useState(IDEA_COLORS[0]);
  const [drawFill, setDrawFill] = useState("none");
  const [drawWidth, setDrawWidth] = useState(SHAPE_DEFAULTS.width);
  const [drawOpacity, setDrawOpacity] = useState(1);
  const [textFont, setTextFont] = useState(TEXT_DEFAULTS.font);
  const [textSize, setTextSize] = useState(TEXT_DEFAULTS.fontSize);
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [textAlign, setTextAlign] = useState(TEXT_DEFAULTS.align);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showStickers, setShowStickers] = useState(false);
  const [linkDraft, setLinkDraft] = useState(null); // the url being typed, or null
  const [cropping, setCropping] = useState(null);   // the picture being reframed
  const [openPinId, setOpenPinId] = useState(null); // the pin whose thread is showing
  const [peeking, setPeeking] = useState(false);    // holding the before/after button
  const [history, setHistory] = useState(null);     // null until the list is fetched
  const [historyBusy, setHistoryBusy] = useState(false);
  // Panning is the scroll container doing its job — there's no second set of
  // coordinates to keep in step, and the scrollbars say where you are.
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const scrollRef = useRef(null);
  const [lookClip, setLookClip] = useState(null);   // a copied look, waiting to be pasted
  const [pinDraft, setPinDraft] = useState("");
  const [exporting, setExporting] = useState("");
  const [draft, setDraft] = useState(null); // shape being drawn right now, not yet saved
  const boardRef = useRef(null);
  // Last place the pointer was over the board, so a paste lands there rather
  // than always in the corner.
  const pointerRef = useRef({ x: 60, y: 60 });
  const draftRef = useRef(null);
  const drawingMode = tool !== "move";

  // The board's rect is its on-screen size, so at 2x a point halfway across the
  // screen is a quarter of the way across the board. Divide it back.
  const pointOn = (e) => {
    const rect = boardRef.current.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return {
      x: Math.round((p.clientX - rect.left) / zoomRef.current),
      y: Math.round((p.clientY - rect.top) / zoomRef.current),
    };
  };

  const startDraw = (e) => {
    if (!drawingMode || tool === "erase") return;
    e.preventDefault();
    const { x, y } = pointOn(e);
    if (tool === "pin") { addPin(x, y); return; }
    if (tool === "curve") {
      // Click to drop points, and finish by clicking the last one again or
      // pressing Enter. Deliberately not a drag: placing a considered curve
      // point by point is the one thing a mouse does better than a finger,
      // which is why the tool isn't offered on a phone at all.
      const pts = penPoints || [];
      const last = pts[pts.length - 1];
      if (last && Math.abs(last.x - x) < 9 && Math.abs(last.y - y) < 9) return finishCurve(pts);
      setPenPoints([...pts, { x, y }]);
      return;
    }
    if (tool === "text" || tool === "note") {
      // A sticky note is a text box with a background — same dragging, same
      // editing, same everything, so it doesn't need a type of its own.
      const created = addBoardItem({
        type: "text", x, y, w: tool === "note" ? 180 : 220, text: "",
        color: tool === "note" ? "#22232b" : drawColor,
        bg: tool === "note" ? drawFill !== "none" ? drawFill : IDEA_COLORS[0] : null,
        font: textFont, fontSize: tool === "note" ? 16 : textSize,
        bold: textBold, italic: textItalic, align: tool === "note" ? "left" : textAlign,
      });
      setEditingTextId(created.id);
      setEditingText("");
      setTool("move");
      return;
    }
    const style = { color: drawColor, width: drawWidth, opacity: drawOpacity, fill: tool === "pen" || tool === "line" || tool === "arrow" ? "none" : drawFill };
    const shape = tool === "pen"
      ? { tool: "pen", ...style, points: [x, y] }
      : { tool, ...style, x1: x, y1: y, x2: x, y2: y };
    draftRef.current = shape;
    setDraft(shape);

    const move = (ev) => {
      if (!draftRef.current) return;
      ev.preventDefault();
      const pt = pointOn(ev);
      let next;
      if (draftRef.current.tool === "pen") {
        const pts = draftRef.current.points;
        const lastX = pts[pts.length - 2], lastY = pts[pts.length - 1];
        // Skipping near-identical points keeps a stroke from bloating the
        // shared board with hundreds of coordinates.
        if (Math.abs(pt.x - lastX) < 3 && Math.abs(pt.y - lastY) < 3) return;
        next = { ...draftRef.current, points: [...pts, pt.x, pt.y] };
      } else {
        next = { ...draftRef.current, x2: pt.x, y2: pt.y };
      }
      draftRef.current = next;
      setDraft(next);
      live.signal({ kind: "draw", shape: next }, true);
    };
    const end = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      const shapeToSave = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      live.stop();
      if (!shapeToSave) return;
      const isDot = shapeToSave.tool === "pen"
        ? shapeToSave.points.length < 4
        : Math.abs(shapeToSave.x2 - shapeToSave.x1) < 4 && Math.abs(shapeToSave.y2 - shapeToSave.y1) < 4;
      if (isDot) return; // a stray tap shouldn't leave a speck behind
      edit({ ...data, ideaDrawings: [...(data.ideaDrawings || []), { id: uid(), folderId: openFolderId || null, ...shapeToSave }] });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
  };

  const finishCurve = (pts) => {
    setPenPoints(null);
    if (!pts || pts.length < 2) return;
    edit({
      ...data,
      ideaDrawings: [...(data.ideaDrawings || []), {
        id: uid(), folderId: openFolderId || null, tool: "curve", curve: pts,
        color: drawColor, width: drawWidth, opacity: drawOpacity, fill: drawFill,
      }],
    });
  };
  // Dragging one of a finished curve's points reshapes it, which is the whole
  // reason for this tool rather than the freehand pen.
  const moveCurvePoint = (shapeId, index, x, y) => {
    edit({
      ...data,
      ideaDrawings: (data.ideaDrawings || []).map((sh) => (sh.id === shapeId
        ? { ...sh, curve: sh.curve.map((pt, i) => (i === index ? { x: Math.round(x), y: Math.round(y) } : pt)) }
        : sh)),
    });
  };

  const eraseShape = (id) => edit({ ...data, ideaDrawings: (data.ideaDrawings || []).filter((d) => d.id !== id) });
  const clearDrawings = () => edit({ ...data, ideaDrawings: (data.ideaDrawings || []).filter((d) => (openFolderId ? d.folderId !== openFolderId : !!d.folderId)) });

  const renderShape = (s, key, isDraft) => {
    const width = typeof s.width === "number" ? s.width : SHAPE_DEFAULTS.width;
    const fill = s.fill && s.fill !== "none" ? s.fill : "none";
    const common = {
      stroke: s.color, strokeWidth: width, fill,
      opacity: typeof s.opacity === "number" ? s.opacity : 1,
      strokeLinecap: "round", strokeLinejoin: "round",
    };
    // The eraser catches strokes; the move tool picks them up to restyle. Both
    // ride on a fat transparent copy underneath, because a 1px line is not
    // something anybody can hit with a finger.
    const hit = isDraft ? null
      : tool === "erase" ? { stroke: "transparent", strokeWidth: Math.max(18, width + 14), fill: "none", style: { cursor: "pointer", pointerEvents: "stroke" }, onClick: () => eraseShape(s.id) }
      : tool === "move" ? { stroke: "transparent", strokeWidth: Math.max(18, width + 14), fill: "none", style: { cursor: "pointer", pointerEvents: "stroke" }, onClick: (ev) => { ev.stopPropagation(); pickElement("shape", s.id, ev); } }
      : null;
    // A halo rather than a colour change, so what's picked is obvious without
    // hiding what the shape actually looks like.
    const halo = !isDraft && isPicked("shape", s.id)
      ? { stroke: "var(--gold)", strokeWidth: width + 7, fill: "none", opacity: 0.4, strokeLinecap: "round", strokeLinejoin: "round", style: { pointerEvents: "none" } }
      : null;

    const shapes = [];
    const layer = (Tag, props) => {
      if (halo) shapes.push(<Tag key={`${key}-halo`} {...props} {...halo} />);
      if (hit) shapes.push(<Tag key={`${key}-hit`} {...props} {...hit} />);
      shapes.push(<Tag key={key} {...props} {...common} />);
    };

    if (s.tool === "pen") {
      const pts = [];
      for (let i = 0; i < s.points.length; i += 2) pts.push(`${s.points[i]},${s.points[i + 1]}`);
      layer("polyline", { points: pts.join(" "), fill: "none" });
    } else if (s.tool === "line") {
      layer("line", { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 });
    } else if (s.tool === "arrow") {
      layer("line", { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 });
      // The head is filled with the stroke colour whatever the body's fill is —
      // a hollow arrowhead reads as a chevron, not an arrow.
      shapes.push(<polygon key={`${key}-head`} points={arrowHeadPoints(s, width)} fill={s.color} stroke={s.color} strokeWidth={1} strokeLinejoin="round" opacity={common.opacity} style={{ pointerEvents: "none" }} />);
    } else if (s.tool === "rect") {
      const b = shapeBox(s);
      layer("rect", { x: b.left, y: b.top, width: b.w, height: b.h, rx: 4 });
    } else if (s.tool === "circle") {
      layer("ellipse", { cx: (s.x1 + s.x2) / 2, cy: (s.y1 + s.y2) / 2, rx: Math.abs(s.x2 - s.x1) / 2, ry: Math.abs(s.y2 - s.y1) / 2 });
    } else if (s.tool === "bubble") {
      layer("path", { d: bubblePath(s) });
    } else if (s.tool === "curve") {
      layer("path", { d: curveThrough(s.curve || []) });
    }
    return shapes;
  };

  const TOOLS = [
    { id: "move", label: "Move", icon: Pin },
    { id: "text", label: "Text", icon: TypeIcon },
    { id: "note", label: "Note", icon: StickyNote },
    { id: "pen", label: "Pen", icon: Pencil },
    ...(isNarrow ? [] : [{ id: "curve", label: "Curve", icon: PenTool }]),
    { id: "line", label: "Line", icon: Minus },
    { id: "arrow", label: "Arrow", icon: ArrowRight },
    { id: "rect", label: "Box", icon: Square },
    { id: "circle", label: "Circle", icon: Circle },
    { id: "bubble", label: "Bubble", icon: MessageSquare },
    { id: "pin", label: "Comment", icon: MessageSquare },
    { id: "erase", label: "Erase", icon: Trash2 },
  ];
  // Which tools draw a shape that can be filled — a pen line and an arrow have
  // no inside to fill.
  const FILLABLE = ["rect", "circle", "bubble", "curve"];

  // ---- loose pictures and text placed straight on the board ----
  // Separate from idea cards: these are for laying out a case — a wall of
  // reference shots with notes around them — rather than pitching one idea.
  // Everything placed on the board shares one stacking order, so a picture can
  // be put behind an idea card and not just behind other pictures. The drawing
  // layer stays above all of it — pen marks annotate what's underneath.
  const stackOf = (el) => (typeof el.z === "number" ? el.z : 0);
  const allPlaced = () => [...(data.boardItems || []), ...ideas, ...folders];
  const topStack = () => allPlaced().reduce((m, el) => Math.max(m, stackOf(el)), 0);
  const bottomStack = () => allPlaced().reduce((m, el) => Math.min(m, stackOf(el)), 0);

  const allBoardItems = data.boardItems || [];
  const boardItems = allBoardItems.filter((b) => (openFolderId ? b.folderId === openFolderId : !b.folderId));
  const [editingTextId, setEditingTextId] = useState(null);
  const [editingText, setEditingText] = useState("");
  const [resizing, setResizing] = useState(null); // { id, w }
  const boardFileInputRef = useRef(null);
  const [boardUploading, setBoardUploading] = useState(false);
  const [boardUploadProgress, setBoardUploadProgress] = useState(0);

  // The three lists are separate in the saved board but behave as one surface
  // here, so each action works out which list it's touching from the kind.
  const listKeyFor = { item: "boardItems", idea: "ideas", folder: "ideaFolders", shape: "ideaDrawings" };
  const listFor = (kind) => (kind === "item" ? allBoardItems : kind === "idea" ? ideas : kind === "shape" ? (data.ideaDrawings || []) : folders);
  const pickedElement = () => (selected ? listFor(selected.kind).find((el) => el.id === selected.id) : null);

  const restack = (z) => {
    if (!selected) return;
    const key = listKeyFor[selected.kind];
    edit({ ...data, [key]: listFor(selected.kind).map((el) => (el.id === selected.id ? { ...el, z } : el)) });
  };
  // Drawn shapes all live in one SVG above the rest, so their order is only
  // ever relative to each other — front and back mean something different
  // there than they do for a picture.
  const stackPeers = () => (selected && selected.kind === "shape" ? (data.ideaDrawings || []) : allPlaced());
  const bringToFront = () => restackAll(1);
  const sendToBack = () => restackAll(-1);

  // Applies one change across every list the selection touches, in a single
  // save — so ten things moving to the front is one step to undo, not ten.
  const changeSelection = (transform) => {
    if (!selection.length) return null;
    const next = { ...data };
    for (const kind of ["item", "idea", "folder", "shape"]) {
      const picked = selection.filter((sel) => sel.kind === kind);
      if (!picked.length) continue;
      const key = listKeyFor[kind];
      next[key] = listFor(kind).map((el) => (picked.some((sel) => sel.id === el.id) ? transform(el, kind) : el));
    }
    return next;
  };

  const restackAll = (direction) => {
    const peers = allPlaced().concat(data.ideaDrawings || []);
    const edge = direction > 0
      ? peers.reduce((m, el) => Math.max(m, stackOf(el)), 0) + 1
      : peers.reduce((m, el) => Math.min(m, stackOf(el)), 0) - 1;
    const next = changeSelection((el) => ({ ...el, z: edge }));
    if (next) edit(next);
  };

  // Grouping is a shared id rather than a container, so a group can be undone,
  // merged with another, or broken up without anything being moved or rebuilt.
  const groupSelection = () => {
    const id = uid();
    const next = changeSelection((el) => ({ ...el, groupId: id }));
    if (next) edit(next);
  };
  const ungroupSelection = () => {
    const next = changeSelection((el) => { const { groupId, ...rest } = el; return rest; });
    if (next) edit(next);
  };

  // Dragging one of several moves the rest with it, by the same distance.
  const dragSelectionBy = (draggedKind, draggedId, dx, dy) => {
    if (selection.length < 2 || !selection.some((sel) => sel.kind === draggedKind && sel.id === draggedId)) return null;
    const shift = (el, kind) => {
      if (kind === draggedKind && el.id === draggedId) return el;   // already placed
      if (el.points) return { ...el, points: el.points.map((n, i) => n + (i % 2 === 0 ? dx : dy)) };
      if (typeof el.x1 === "number") return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy };
      return { ...el, x: Math.max(0, (el.x || 0) + dx), y: Math.max(0, (el.y || 0) + dy) };
    };
    return changeSelection(shift);
  };

  // Anything on the board can point somewhere — a reference shot at the Canva
  // design it came from, a note at the brief. Only http(s) is ever stored, so
  // a pasted "javascript:" can't be turned into something clickable.
  const saveLink = (raw) => {
    if (!selected || selected.kind !== "item") return;
    const trimmed = (raw || "").trim();
    const url = !trimmed ? null
      : /^https?:\/\//i.test(trimmed) ? trimmed
      : /^[\w-]+(\.[\w-]+)+/.test(trimmed) ? `https://${trimmed}`
      : null;
    if (trimmed && !url) return;      // not a link — leave what was there alone
    edit({ ...data, boardItems: allBoardItems.map((b) => (b.id === selected.id ? { ...b, link: url } : b)) });
    setLinkDraft(null);
  };

  // Every adjustment goes through here so it lands as one change per move of a
  // slider — which keeps undo meaning "put that back how it was".
  const applyLook = (patch) => {
    if (!pickedPhoto) return;
    const next = { ...photoLook(pickedPhoto), ...patch };
    // Nothing worth storing once it's all back at zero.
    const clean = PHOTO_SLIDERS.some(({ key }) => next[key] !== PHOTO_DEFAULTS[key]) || next.spin ? next : null;
    edit({ ...data, boardItems: allBoardItems.map((b) => (b.id === pickedPhoto.id ? { ...b, look: clean } : b)) });
  };
  const usePreset = (preset) => {
    if (!pickedPhoto) return;
    const spin = photoLook(pickedPhoto).spin;   // turning it is framing, not a look
    edit({ ...data, boardItems: allBoardItems.map((b) => (b.id === pickedPhoto.id ? { ...b, look: Object.keys(preset.look).length ? { ...PHOTO_DEFAULTS, ...preset.look, spin } : (spin ? { ...PHOTO_DEFAULTS, spin } : null) } : b)) });
  };
  const spinPhoto = () => {
    if (!pickedPhoto) return;
    const look = { ...photoLook(pickedPhoto), spin: (photoLook(pickedPhoto).spin + 90) % 360 };
    edit({ ...data, boardItems: allBoardItems.map((b) => (b.id === pickedPhoto.id ? { ...b, look } : b)) });
  };
  // Lightroom's best trick: get one photo right, then put that look on the rest.
  const copyLook = () => { if (pickedPhoto) setLookClip(photoLook(pickedPhoto)); };
  const pasteLook = () => {
    if (!lookClip || !selection.length) return;
    const targets = new Set(selection.filter((sel) => sel.kind === "item").map((sel) => sel.id));
    edit({ ...data, boardItems: allBoardItems.map((b) => (targets.has(b.id) && b.type === "image" ? { ...b, look: { ...lookClip, spin: photoLook(b).spin } } : b)) });
  };

  // One place for anything that sets a plain field on everything picked.
  const setOnSelection = (patch) => {
    const next = changeSelection((el) => ({ ...el, ...patch }));
    if (next) edit(next);
  };

  // Where each picked thing is and how big, so they can be lined up. A shape is
  // its bounding box; everything else is its corner and its width.
  const boundsOf = (el) => {
    if (el.points) {
      const xs = el.points.filter((_, i) => i % 2 === 0), ys = el.points.filter((_, i) => i % 2 === 1);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    if (typeof el.x1 === "number") return { x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2), w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) };
    return { x: el.x || 0, y: el.y || 0, w: el.w || 152, h: el.h || 88 };
  };
  const moveElBy = (el, dx, dy) => {
    if (el.points) return { ...el, points: el.points.map((n, i) => n + (i % 2 === 0 ? dx : dy)) };
    if (typeof el.x1 === "number") return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy };
    return { ...el, x: Math.max(0, (el.x || 0) + dx), y: Math.max(0, (el.y || 0) + dy) };
  };

  const pickedElements = () => selection.map((sel) => ({ sel, el: listFor(sel.kind).find((x) => x.id === sel.id) })).filter((r) => r.el);

  // Aligns to the outer edge of everything picked, which is what people expect:
  // the group keeps its footprint and its contents line up inside it.
  const alignSelection = (edge) => {
    const rows = pickedElements();
    if (rows.length < 2) return;
    const boxes = rows.map((r) => boundsOf(r.el));
    const left = Math.min(...boxes.map((b) => b.x));
    const right = Math.max(...boxes.map((b) => b.x + b.w));
    const top = Math.min(...boxes.map((b) => b.y));
    const bottom = Math.max(...boxes.map((b) => b.y + b.h));
    const shiftFor = (b) => {
      if (edge === "left") return [left - b.x, 0];
      if (edge === "right") return [right - (b.x + b.w), 0];
      if (edge === "hcentre") return [(left + right) / 2 - (b.x + b.w / 2), 0];
      if (edge === "top") return [0, top - b.y];
      if (edge === "bottom") return [0, bottom - (b.y + b.h)];
      return [0, (top + bottom) / 2 - (b.y + b.h / 2)];
    };
    let i = 0;
    const next = changeSelection((el) => { const [dx, dy] = shiftFor(boxes[i++]); return moveElBy(el, Math.round(dx), Math.round(dy)); });
    if (next) edit(next);
  };

  // Even gaps between the outermost two, which stay where they are.
  const distributeSelection = (axis) => {
    const rows = pickedElements();
    if (rows.length < 3) return;
    const withBox = rows.map((r) => ({ ...r, box: boundsOf(r.el) }));
    withBox.sort((a, b) => (axis === "x" ? a.box.x - b.box.x : a.box.y - b.box.y));
    const first = withBox[0].box, last = withBox[withBox.length - 1].box;
    const span = axis === "x" ? (last.x + last.w) - first.x : (last.y + last.h) - first.y;
    const used = withBox.reduce((sum, r) => sum + (axis === "x" ? r.box.w : r.box.h), 0);
    const gap = (span - used) / (withBox.length - 1);
    const target = new Map();
    let cursor = axis === "x" ? first.x : first.y;
    for (const r of withBox) {
      target.set(r.sel.id, Math.round(cursor));
      cursor += (axis === "x" ? r.box.w : r.box.h) + gap;
    }
    const next = changeSelection((el) => {
      const want = target.get(el.id);
      if (want === undefined) return el;
      const box = boundsOf(el);
      return moveElBy(el, axis === "x" ? want - box.x : 0, axis === "y" ? want - box.y : 0);
    });
    if (next) edit(next);
  };

  // Typing an exact number, for when nudging isn't the point.
  const setExact = (field, raw) => {
    const value = Math.round(Number(raw));
    if (!Number.isFinite(value) || !selected || selection.length !== 1) return;
    const el = pickedElement();
    if (!el) return;
    const box = boundsOf(el);
    if (field === "w") {
      if (selected.kind !== "item" || value < 20) return;
      return edit({ ...data, boardItems: allBoardItems.map((b) => (b.id === el.id ? { ...b, w: value } : b)) });
    }
    const next = changeSelection((x) => moveElBy(x, field === "x" ? value - box.x : 0, field === "y" ? value - box.y : 0));
    if (next) edit(next);
  };

  const nudgeSelection = (dx, dy) => {
    const next = changeSelection((el) => moveElBy(el, dx, dy));
    if (next) edit(next);
  };

  // The team's own colours, kept on the board rather than per person, because a
  // brand palette is a thing everyone should be reaching into.
  const palette = data.boardPalette || [];
  const rememberColour = (hex) => {
    if (!hex || palette.includes(hex)) return;
    // Newest first, and capped — a swatch row nobody can scan is no use.
    edit({ ...data, boardPalette: [hex, ...palette].slice(0, 12) });
  };
  const forgetColour = (hex) => edit({ ...data, boardPalette: palette.filter((c) => c !== hex) });

  // Chrome hands over a real eyedropper; on browsers without one the button
  // simply isn't offered rather than pretending and failing.
  const canDrop = typeof window !== "undefined" && "EyeDropper" in window;
  const pickFromScreen = async () => {
    if (!canDrop) return;
    try {
      const result = await new window.EyeDropper().open();
      if (result && result.sRGBHex) { applyStyle({ color: result.sRGBHex }); rememberColour(result.sRGBHex); }
    } catch { /* cancelled with Escape — nothing to do */ }
  };

  // Whatever is picked takes the colour, whichever kind it is: a shape's
  // stroke, a text box's letters, an idea card's face.
  const recolourSelection = (hex) => {
    if (!selection.length) return;
    const next = changeSelection((el, kind) => (kind === "shape" ? { ...el, color: hex } : { ...el, color: hex }));
    if (next) edit(next);
  };

  const boardKey = openFolderId || "main";
  const surface = surfaceOf((data.boardSurfaces || {})[boardKey]);
  const setSurface = (id) => edit({ ...data, boardSurfaces: { ...(data.boardSurfaces || {}), [boardKey]: id } });

  // Lines other things already sit on: their two edges and their middle, in
  // both directions. Something dragged near one of those gets pulled onto it.
  const [guides, setGuides] = useState(null);
  const SNAP_PX = 7;

  const snapTo = (id, x, y, size) => {
    if (id === null) { setGuides(null); return null; }
    const w = (size && size.w ? size.w / (zoomRef.current || 1) : 0);
    const h = (size && size.h ? size.h / (zoomRef.current || 1) : 0);

    const verticals = [];
    const horizontals = [];
    for (const el of [...boardItems, ...boardIdeas, ...(currentFolder ? [] : folders)]) {
      if (el.id === id) continue;
      const b = boundsOf(el);
      verticals.push(b.x, b.x + b.w / 2, b.x + b.w);
      horizontals.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    // The board's own middle and edges count too, for centring something on it.
    verticals.push(0, BOARD_W / 2, BOARD_W);
    horizontals.push(0, BOARD_H / 2, BOARD_H);

    // Each of the dragged thing's own three lines can be the one that catches.
    const tryAxis = (lines, mine) => {
      let best = null;
      for (const line of lines) {
        for (const [which, at] of mine) {
          const gap = Math.abs(line - at);
          if (gap <= SNAP_PX && (!best || gap < best.gap)) best = { gap, line, shift: line - at, which };
        }
      }
      return best;
    };
    const vx = tryAxis(verticals, [["left", x], ["centre", x + w / 2], ["right", x + w]]);
    const hy = tryAxis(horizontals, [["top", y], ["middle", y + h / 2], ["bottom", y + h]]);

    setGuides({ x: vx ? vx.line : null, y: hy ? hy.line : null });
    return {
      x: Math.max(0, Math.round(x + (vx ? vx.shift : 0))),
      y: Math.max(0, Math.round(y + (hy ? hy.shift : 0))),
    };
  };

  snapRef.current = snapTo;

  // A layout the team worked out themselves is worth more than any of mine.
  // Saving one takes what's on this board and stores it as plain items and
  // shapes, positions and all — the same shape a built-in template produces,
  // so it lands through exactly the same code and behaves identically.
  const saveAsTemplate = () => {
    const name = (window.prompt("Name this layout, so it's recognisable in the list:") || "").trim();
    if (!name) return;
    const strip = (el) => { const { id, folderId, groupId, ...rest } = el; return rest; };
    edit({
      ...data,
      savedTemplates: [
        { id: uid(), name, by: profile || "Someone", date: todayISO(), items: boardItems.map(strip), shapes: drawings.map(strip) },
        ...(data.savedTemplates || []),
      ].slice(0, 20),
    });
  };
  const forgetTemplate = (id) => edit({ ...data, savedTemplates: (data.savedTemplates || []).filter((t) => t.id !== id) });

  const openHistory = async () => {
    setHistory("loading");
    const { data: rows, error } = await supabase
      .from("hub_history").select("id, taken_at, taken_by, note, snapshot").order("taken_at", { ascending: false }).limit(40);
    if (error) return setHistory("missing");
    setHistory(rows || []);
  };
  const saveVersionNow = async () => {
    setHistoryBusy(true);
    const ok = await takeSnapshot(data, profile, "Saved by hand");
    setHistoryBusy(false);
    if (ok) openHistory();
  };
  // Two ways back, because they're wanted at different moments: put the whole
  // board back, or put only the Idea Bank back and leave the duties, calendar
  // and chat as they are now.
  const restoreFrom = (row, ideaBankOnly) => {
    const snap = row.snapshot || {};
    const when = new Date(row.taken_at).toLocaleString();
    if (!window.confirm(ideaBankOnly
      ? `Put the Idea Bank back to how it was on ${when}? Everything else — duties, calendar, chat — stays exactly as it is now.`
      : `Put the WHOLE board back to how it was on ${when}? That includes duties, the calendar, chat and notes. Anything added since will be gone.`)) return;
    // Goes through edit() like any other change, so it merges rather than
    // stamping over whatever someone else is doing this second — and one press
    // of undo takes the restore itself back.
    const next = ideaBankOnly
      ? { ...data, ...Object.fromEntries(IDEA_BANK_KEYS.map((k) => [k, snap[k] !== undefined ? snap[k] : data[k]])) }
      : { ...snap };
    edit(next);
    setHistory(null);
    setSelected(null);
  };

  // A join between two things rather than a line at two coordinates. It holds
  // the ids, works out where to draw itself from wherever they are now, and so
  // follows them when either is dragged — which is the whole difference between
  // drawing an arrow and actually connecting something.
  const links = (data.boardLinks || []).filter((l) => (l.folderId || null) === (openFolderId || null));
  const linkableAt = (kind, id) => listFor(kind).find((el) => el.id === id);
  const joinSelection = () => {
    if (selection.length !== 2) return;
    const [a, b] = selection;
    edit({
      ...data,
      boardLinks: [...(data.boardLinks || []), { id: uid(), folderId: openFolderId || null, from: { kind: a.kind, id: a.id }, to: { kind: b.kind, id: b.id }, color: drawColor, width: drawWidth }],
    });
  };
  const unjoin = (id) => edit({ ...data, boardLinks: (data.boardLinks || []).filter((l) => l.id !== id) });
  // Any join whose either end has gone is dropped on sight rather than drawn
  // pointing at nothing.
  const liveLinks = links
    .map((l) => ({ l, a: linkableAt(l.from.kind, l.from.id), b: linkableAt(l.to.kind, l.to.id) }))
    .filter((r) => r.a && r.b);
  // Meets each box at its edge instead of burying the head under the middle.
  const edgePoint = (from, to) => {
    const cx = from.x + from.w / 2, cy = from.y + from.h / 2;
    const dx = to.x + to.w / 2 - cx, dy = to.y + to.h / 2 - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const scale = Math.min(
      Math.abs(dx) > 0.01 ? (from.w / 2) / Math.abs(dx) : Infinity,
      Math.abs(dy) > 0.01 ? (from.h / 2) / Math.abs(dy) : Infinity
    );
    return { x: cx + dx * scale, y: cy + dy * scale };
  };

  const [findText, setFindText] = useState(null);   // null when the box is closed
  // Looks everywhere, not just the board you happen to be standing on — the
  // whole point is finding the thing when you've forgotten which folder it's in.
  const findHits = () => {
    const needle = (findText || "").trim().toLowerCase();
    if (needle.length < 2) return [];
    const where = (fid) => (fid ? (folders.find((f) => f.id === fid) || {}).name || "a folder" : "the main board");
    const hits = [];
    for (const i of ideas) {
      const hay = `${i.title || ""} ${i.description || ""} ${(i.tags || []).join(" ")}`.toLowerCase();
      if (hay.includes(needle)) hits.push({ kind: "idea", id: i.id, folderId: i.folderId || null, label: i.title || "Untitled idea", where: where(i.folderId) });
    }
    for (const b of data.boardItems || []) {
      if (b.type === "text" && (b.text || "").toLowerCase().includes(needle)) {
        hits.push({ kind: "item", id: b.id, folderId: b.folderId || null, label: (b.text || "").slice(0, 44), where: where(b.folderId) });
      }
      if (b.type === "image" && (b.name || "").toLowerCase().includes(needle)) {
        hits.push({ kind: "item", id: b.id, folderId: b.folderId || null, label: b.name, where: where(b.folderId) });
      }
    }
    for (const c of data.boardComments || []) {
      if ((c.text || "").toLowerCase().includes(needle)) hits.push({ kind: "pin", id: c.id, folderId: c.folderId || null, label: c.text.slice(0, 44), where: where(c.folderId) });
    }
    for (const f of folders) {
      if ((f.name || "").toLowerCase().includes(needle)) hits.push({ kind: "folder", id: f.id, folderId: null, label: f.name, where: "the main board" });
    }
    return hits.slice(0, 40);
  };
  // Takes you to it and picks it up, so it's obvious which one was meant even
  // on a busy board.
  const goToHit = (hit) => {
    setOpenFolderId(hit.folderId || null);
    setFindText(null);
    if (hit.kind === "pin") { setOpenPinId(hit.id); setSelected(null); return; }
    setSelected({ kind: hit.kind, id: hit.id });
  };

  // Walking a board in front of people. Each folder is a slide and the main
  // board is the first one, because that's the structure the team already made
  // rather than a second one they'd have to maintain.
  const [presenting, setPresenting] = useState(null); // index into the slide list
  const slides = [{ id: null, name: "Main board" }, ...folders.map((f) => ({ id: f.id, name: f.name }))];
  const startPresenting = () => {
    setSelected(null);
    setPresenting(0);
    setOpenFolderId(null);
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  };
  const stopPresenting = () => {
    setPresenting(null);
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  };
  const goSlide = (dir) => {
    setPresenting((now) => {
      if (now === null) return now;
      const next = Math.max(0, Math.min(slides.length - 1, now + dir));
      setOpenFolderId(slides[next].id);
      return next;
    });
  };
  useEffect(() => {
    if (presenting === null) return undefined;
    const onKey = (ev) => {
      if (ev.key === "ArrowRight" || ev.key === " " || ev.key === "PageDown") { ev.preventDefault(); goSlide(1); }
      if (ev.key === "ArrowLeft" || ev.key === "PageUp") { ev.preventDefault(); goSlide(-1); }
      if (ev.key === "Escape") stopPresenting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ZOOM_STEPS = [0.25, 0.4, 0.55, 0.75, 1, 1.25, 1.5, 2, 3];
  // Keeps whatever is in the middle of the view in the middle afterwards,
  // rather than throwing you to the top-left corner every time.
  const zoomTo = (next) => {
    const target = Math.max(0.25, Math.min(3, next));
    const box = scrollRef.current;
    if (!box) return setZoom(target);
    const midX = (box.scrollLeft + box.clientWidth / 2) / zoomRef.current;
    const midY = (box.scrollTop + box.clientHeight / 2) / zoomRef.current;
    setZoom(target);
    requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      scrollRef.current.scrollLeft = midX * target - box.clientWidth / 2;
      scrollRef.current.scrollTop = midY * target - box.clientHeight / 2;
    });
  };
  const zoomStep = (dir) => {
    const i = ZOOM_STEPS.findIndex((z) => z >= zoomRef.current - 0.001);
    zoomTo(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (i < 0 ? 4 : i) + dir))]);
  };
  const zoomToFit = () => {
    const box = scrollRef.current;
    if (!box) return;
    zoomTo(Math.min(1, (box.clientWidth - 8) / BOARD_W));
  };

  const [cutting, setCutting] = useState("");
  const [penPoints, setPenPoints] = useState(null);  // the curve being placed
  // The original file is left exactly where it is and a second, transparent one
  // is put beside it. That matters: the model is good but not perfect, and
  // having replaced the only copy of a photo with a bad cut-out would be a
  // thing you could not undo.
  const removeBackgroundFrom = async (item) => {
    if (!item || !item.fileId) return;
    setCutting("Fetching the picture…");
    try {
      const res = await fetch(driveThumbSrc(item.fileId, "s1600"));
      const blob = await res.blob();
      setCutting("Loading the model — this is the slow bit, once per device…");
      const removeBg = await loadBackgroundRemover();
      const cut = await removeBg(blob, {
        // Progress arrives in stages; the numbers are less useful than knowing
        // it hasn't died.
        progress: (key, current, total) => {
          if (key && key.startsWith("fetch")) setCutting(`Loading the model… ${Math.round((current / (total || 1)) * 100)}%`);
          else setCutting("Working out the edges…");
        },
      });
      setCutting("Saving the cut-out…");
      const file = new File([cut], `${(item.name || "picture").replace(/\.[^.]+$/, "")}-cutout.png`, { type: "image/png" });
      const result = await uploadToDrive(file, () => {}, profile);
      const box = boundsOf(item);
      addBoardItem({
        type: "image", fileId: driveFileId(result.link), kind: "image", name: result.name,
        x: Math.round(box.x + 26), y: Math.round(box.y + 26), w: item.w || 260,
        crop: item.crop || null, imgAspect: item.imgAspect || null, z: topStack() + 1,
      });
    } catch {
      setCutting("That didn't work — the picture may be too big, or the model couldn't load.");
      setTimeout(() => setCutting(""), 4000);
      return;
    }
    setCutting("");
  };

  const saveCrop = (crop, imgAspect) => {
    if (!cropping) return;
    edit({ ...data, boardItems: allBoardItems.map((b) => (b.id === cropping.id ? { ...b, crop, imgAspect: imgAspect || b.imgAspect } : b)) });
    setCropping(null);
  };

  const duplicateSelected = () => {
    if (selection.length > 1) return duplicateMany();
    const el = pickedElement();
    if (!el) return;
    const key = listKeyFor[selected.kind];
    // Offset so the copy is visibly a second thing rather than hidden under it.
    const nudge = 18;
    // A shape has no x/y — it's two corners, or a run of points — so shifting a
    // copy means shifting all of them rather than one origin.
    const copy = selected.kind === "shape"
      ? {
          ...el, id: uid(), z: stackPeers().reduce((m, s2) => Math.max(m, stackOf(s2)), 0) + 1,
          ...(el.points
            ? { points: el.points.map((n) => n + nudge) }
            : { x1: el.x1 + nudge, y1: el.y1 + nudge, x2: el.x2 + nudge, y2: el.y2 + nudge }),
        }
      : { ...el, id: uid(), x: (el.x || 0) + nudge, y: (el.y || 0) + nudge, z: topStack() + 1 };
    if (selected.kind === "idea") copy.votes = [];
    // A duplicated picture points at the same Drive file on purpose: copying
    // the file would double the team's storage for something that looks the
    // same. Deleting one copy therefore leaves the file alone if another
    // still uses it.
    edit({ ...data, [key]: [...listFor(selected.kind), copy] });
    setSelected({ kind: selected.kind, id: copy.id });
  };

  // A style control does two jobs at once, which is what people expect from a
  // drawing app: it restyles whatever is picked, and it becomes the setting the
  // next shape is drawn with.
  const applyStyle = (patch) => {
    if (patch.color !== undefined) setDrawColor(patch.color);
    if (patch.fill !== undefined) setDrawFill(patch.fill);
    if (patch.width !== undefined) setDrawWidth(patch.width);
    if (patch.opacity !== undefined) setDrawOpacity(patch.opacity);
    if (selected && selected.kind === "shape") {
      edit({ ...data, ideaDrawings: (data.ideaDrawings || []).map((sh) => (sh.id === selected.id ? { ...sh, ...patch } : sh)) });
    }
  };
  // What the controls should show: the picked shape's own style, or the
  // settings waiting for the next one.
  const pickedShape = selected && selected.kind === "shape" ? (data.ideaDrawings || []).find((sh) => sh.id === selected.id) : null;
  // The picked text box, if that's what's picked — a sticky note counts, since
  // a note is only a text box with a background.
  const pickedText = selected && selected.kind === "item"
    ? allBoardItems.find((b) => b.id === selected.id && b.type === "text")
    : null;

  const applyText = (patch) => {
    if (patch.font !== undefined) setTextFont(patch.font);
    if (patch.fontSize !== undefined) setTextSize(patch.fontSize);
    if (patch.bold !== undefined) setTextBold(patch.bold);
    if (patch.italic !== undefined) setTextItalic(patch.italic);
    if (patch.align !== undefined) setTextAlign(patch.align);
    // The box being typed into isn't saved keystroke by keystroke, but its
    // styling is — so a size change lands while the cursor is still in it.
    const target = pickedText ? pickedText.id : editingTextId;
    if (target) {
      edit({ ...data, boardItems: allBoardItems.map((b) => (b.id === target ? { ...b, ...patch } : b)) });
    }
  };
  const textNow = pickedText || (editingTextId ? allBoardItems.find((b) => b.id === editingTextId) : null) || {
    font: textFont, fontSize: textSize, bold: textBold, italic: textItalic, align: textAlign,
  };
  const styleNow = {
    color: pickedShape ? pickedShape.color : drawColor,
    fill: pickedShape ? (pickedShape.fill || "none") : drawFill,
    width: pickedShape && typeof pickedShape.width === "number" ? pickedShape.width : drawWidth,
    opacity: pickedShape && typeof pickedShape.opacity === "number" ? pickedShape.opacity : drawOpacity,
  };

  // Copies of several things keep their arrangement relative to each other, and
  // stay grouped together as a new group if they were one.
  // A clipboard of its own rather than the system one. What's being copied is
  // a set of board records — position, style, crop, link, which Drive file —
  // and none of that survives a trip through text/plain. Kept in localStorage
  // so it lasts a reload and carries between folders and boards.
  const CLIP_KEY = "ideabank-clipboard";
  const readClipboard = () => {
    try { const raw = localStorage.getItem(CLIP_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  };
  const [clipHas, setClipHas] = useState(() => { const c = readClipboard(); return c ? c.count : 0; });

  const copySelection = () => {
    if (!selection.length) return;
    const payload = { count: selection.length, groups: {} };
    for (const kind of ["item", "idea", "folder", "shape"]) {
      const mine = selection.filter((sel) => sel.kind === kind);
      if (!mine.length) continue;
      payload.groups[kind] = listFor(kind).filter((el) => mine.some((sel) => sel.id === el.id));
    }
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(payload)); setClipHas(payload.count); } catch { /* full or blocked — copy simply doesn't take */ }
  };

  const cutSelection = () => { copySelection(); deleteSelected(); };

  // Ctrl+V does one of two things depending on what's on the system clipboard:
  // a screenshot becomes a new picture on the board, anything else falls
  // through to the board's own clipboard. Handled on the paste event rather
  // than on the keydown, because only the paste event carries the image.
  //
  // The handler lives in a ref so the listener can be attached exactly once.
  // The first version re-attached on every render — correct, since it cleaned
  // up after itself, but it meant a listener being torn down and rebuilt on
  // every keystroke anywhere in the board. Holding it still is both cheaper
  // and one less thing that has to keep being right.
  const pasteHandlerRef = useRef(null);
  const pasteBusyRef = useRef(false);
  pasteHandlerRef.current = async (ev) => {
    const item = [...((ev.clipboardData && ev.clipboardData.items) || [])].find((it) => it.type && it.type.startsWith("image/"));
    if (item) {
      ev.preventDefault();
      // An upload takes seconds, and a second Ctrl+V in that window would put
      // the same screenshot on the board twice.
      if (pasteBusyRef.current) return;
      const file = item.getAsFile();
      if (!file) return;
      pasteBusyRef.current = true;
      try { await addPictureFromFile(file, pointerRef.current); }
      finally { pasteBusyRef.current = false; }
      return;
    }
    const el = ev.target;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    ev.preventDefault();
    pasteClipboard();
  };
  useEffect(() => {
    const onPaste = (ev) => pasteHandlerRef.current && pasteHandlerRef.current(ev);
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const pasteClipboard = () => {
    const clip = readClipboard();
    if (!clip || !clip.groups) return;
    // Land where the pointer last was, keeping the copied things in the same
    // arrangement relative to each other rather than stacking them all up.
    let minX = Infinity, minY = Infinity;
    const cornerOf = (el) => (el.points ? { x: Math.min(...el.points.filter((_, i) => i % 2 === 0)), y: Math.min(...el.points.filter((_, i) => i % 2 === 1)) }
      : typeof el.x1 === "number" ? { x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2) }
      : { x: el.x || 0, y: el.y || 0 });
    for (const list of Object.values(clip.groups)) for (const el of list) { const c = cornerOf(el); minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); }
    if (!Number.isFinite(minX)) return;
    // Not clamped to zero: the offset is often negative, because pasting to the
    // left of what you copied is the normal case. The leftmost thing lands
    // exactly on the pointer, which is already inside the board, so nothing can
    // end up off the edge.
    const dx = Math.round(pointerRef.current.x - minX);
    const dy = Math.round(pointerRef.current.y - minY);

    const next = { ...data };
    const landed = [];
    const newGroup = clip.count > 1 ? uid() : null;
    const top = topStack();
    let n = 0;
    for (const [kind, list] of Object.entries(clip.groups)) {
      const key = listKeyFor[kind];
      const copies = list.map((el) => {
        const copy = { ...el, id: uid(), folderId: openFolderId || null, z: top + 1 + n++ };
        if (newGroup) copy.groupId = newGroup; else delete copy.groupId;
        if (el.points) copy.points = el.points.map((v, i) => v + (i % 2 === 0 ? dx : dy));
        else if (typeof el.x1 === "number") { copy.x1 = el.x1 + dx; copy.y1 = el.y1 + dy; copy.x2 = el.x2 + dx; copy.y2 = el.y2 + dy; }
        else { copy.x = (el.x || 0) + dx; copy.y = (el.y || 0) + dy; }
        if (kind === "idea") copy.votes = [];
        landed.push({ kind, id: copy.id });
        return copy;
      });
      next[key] = [...listFor(kind), ...copies];
    }
    edit(next);
    setSelection(landed);
  };

  const duplicateMany = () => {
    const nudge = 18;
    const newGroup = uid();
    const next = { ...data };
    const picked = [];
    for (const kind of ["item", "idea", "folder", "shape"]) {
      const mine = selection.filter((sel) => sel.kind === kind);
      if (!mine.length) continue;
      const key = listKeyFor[kind];
      const copies = listFor(kind)
        .filter((el) => mine.some((sel) => sel.id === el.id))
        .map((el) => {
          const copy = { ...el, id: uid(), groupId: newGroup };
          if (el.points) copy.points = el.points.map((n, i) => n + nudge);
          else if (typeof el.x1 === "number") { copy.x1 = el.x1 + nudge; copy.y1 = el.y1 + nudge; copy.x2 = el.x2 + nudge; copy.y2 = el.y2 + nudge; }
          else { copy.x = (el.x || 0) + nudge; copy.y = (el.y || 0) + nudge; }
          if (kind === "idea") copy.votes = [];
          picked.push({ kind, id: copy.id });
          return copy;
        });
      next[key] = [...listFor(kind), ...copies];
    }
    edit(next);
    setSelection(picked);
  };

  // Worked out once here rather than three times inside the markup: what is
  // picked, what to call it, and which groups of controls are worth showing.
  const picked = !!(selected && pickedElement());
  const pickedLabel = !picked ? ""
    : selected.kind === "idea" ? "Idea"
    : selected.kind === "folder" ? "Folder"
    : selected.kind === "shape" ? "Shape"
    : pickedElement().sticker ? "Sticker"
    : pickedElement().type === "text" ? (pickedElement().bg ? "Note" : "Text")
    : "Picture";
  const pickedPhoto = selection.length === 1 && selected && selected.kind === "item"
    && pickedElement() && pickedElement().type === "image" ? pickedElement() : null;
  const showShapeControls = drawingMode || !!pickedShape;
  const showTextControls = tool === "text" || tool === "note" || !!pickedText || !!editingTextId;

  const isLocked = (kind, id) => !!(listFor(kind).find((el) => el.id === id) || {}).locked;

  const saveBoardItemPos = (id, x, y, dx, dy) => {
    if (isLocked("item", id)) return;
    const moved = dragSelectionBy("item", id, dx || 0, dy || 0);
    if (moved) return edit({ ...moved, boardItems: moved.boardItems.map((b) => (b.id === id ? { ...b, x, y } : b)) });
    edit({ ...data, boardItems: allBoardItems.map((b) => (b.id === id ? { ...b, x, y } : b)) });
  };
  const boardItemDrag = useDraggable(saveBoardItemPos, (id, ev) => {
    const item = allBoardItems.find((b) => b.id === id);
    if (!item) return;
    if (tool === "erase") return removeBoardItem(id);
    tapToOpen("item", id, ev);
  }, onDragSignal, getZoom, snapVia);

  // What "open" means depends on what it is: a text box starts editing, a
  // picture goes full screen.
  const openBoardItem = (item) => () => {
    if (item.type === "text") { setEditingTextId(item.id); setEditingText(item.text || ""); live.signal({ kind: "write", itemId: item.id }); }
    else setLightbox({ fileId: item.fileId, kind: item.kind, name: item.name });
  };

  // A template drops into whatever you have open — the main board or a folder —
  // and adds to it rather than replacing it, so running one on a board with
  // work already on it can't destroy anything. Undo takes the whole thing back
  // in one step, because it goes in as a single change.
  const applyTemplate = (template) => {
    const { items, shapes } = template.build();
    const base = topStack();
    edit({
      ...data,
      boardItems: [...allBoardItems, ...items.map((it, i) => ({ ...it, id: uid(), folderId: openFolderId || null, z: base + 1 + i }))],
      ideaDrawings: [...(data.ideaDrawings || []), ...shapes.map((sh) => ({ ...sh, id: uid(), folderId: openFolderId || null }))],
    });
    setShowTemplates(false);
    setSelected(null);
  };

  // Export renders the board element itself rather than redrawing it from the
  // saved data, so what lands in the picture is exactly what's on screen —
  // fonts, photos, strokes and all — with nothing to keep in sync.
  // Cuts the picked things out of the finished picture rather than rendering
  // them separately: whatever overlaps them — a drawn arrow, a colour wash —
  // is part of how they look, and rendering them alone would lose it.
  const exportSelection = async () => {
    const rows = pickedElements();
    if (!rows.length || !boardRef.current) return;
    const boxes = rows.map((r) => boundsOf(r.el));
    const pad = 24;
    const left = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
    const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
    const right = Math.min(BOARD_W, Math.max(...boxes.map((b) => b.x + b.w)) + pad);
    const bottom = Math.min(BOARD_H, Math.max(...boxes.map((b) => b.y + b.h)) + pad);
    if (right - left < 8 || bottom - top < 8) return;

    setSelected(null);
    setExporting("selection");
    try {
      const html2canvas = await loadHtml2Canvas();
      await new Promise((r) => setTimeout(r, 60));
      const scale = 2;
      const full = await html2canvas(boardRef.current, {
        backgroundColor: surface.paper === "var(--panel)" ? "#12141B" : surface.paper,
        scale, useCORS: true, logging: false,
        width: BOARD_W, height: BOARD_H, windowWidth: BOARD_W, windowHeight: BOARD_H,
      });
      const cut = document.createElement("canvas");
      cut.width = (right - left) * scale;
      cut.height = (bottom - top) * scale;
      cut.getContext("2d").drawImage(full, left * scale, top * scale, cut.width, cut.height, 0, 0, cut.width, cut.height);
      const link = document.createElement("a");
      link.download = `${currentFolder ? currentFolder.name : "idea-board"}-piece-${todayISO()}.png`;
      link.href = cut.toDataURL("image/png");
      link.click();
    } catch { /* nothing partial is left behind */ }
    setExporting("");
  };

  const exportBoard = async (mode) => {
    if (!boardRef.current) return;
    setSelected(null);            // no gold ring in the exported picture
    setExporting(mode);
    try {
      const html2canvas = await loadHtml2Canvas();
      await new Promise((r) => setTimeout(r, 60));   // let the ring clear first
      const canvas = await html2canvas(boardRef.current, {
        backgroundColor: "#12141B",
        scale: 2,                 // readable when zoomed into, still a sane size
        useCORS: true,
        logging: false,
        width: BOARD_W, height: BOARD_H, windowWidth: BOARD_W, windowHeight: BOARD_H,
      });
      const name = `${currentFolder ? currentFolder.name : "idea-board"}-${todayISO()}`;
      if (mode === "png") {
        const link = document.createElement("a");
        link.download = `${name}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
      } else {
        // No PDF library: hand the picture to the browser's own print dialog,
        // where "Save as PDF" is a destination on every platform including
        // phones. One less dependency to keep alive for a button used rarely.
        const win = window.open("", "_blank");
        if (!win) { setExporting(""); return; }
        win.document.write(
          `<title>${name}</title><style>@page{size:landscape;margin:10mm}body{margin:0}img{width:100%}</style>` +
          `<img src="${canvas.toDataURL("image/png")}" onload="window.focus();window.print()">`
        );
        win.document.close();
      }
    } catch {
      // Nothing partial is left behind — the button simply does nothing and
      // can be pressed again.
    }
    setExporting("");
  };

  // A sticker is a text box holding one emoji at a large size — same dragging,
  // resizing, stacking and undo as everything else, and nothing new to store.
  // Feedback that points at something. A pin sits at a spot on the board rather
  // than being attached to an element, so it can mark a gap, a arrangement or
  // the join between two things — none of which are an element you could hang a
  // comment off.
  const pins = (data.boardComments || []).filter((c) => (c.folderId || null) === (openFolderId || null));
  const addPin = (x, y) => {
    const pin = { id: uid(), folderId: openFolderId || null, x, y, author: profile || "Someone", date: todayISO(), text: "", replies: [], resolved: false };
    edit({ ...data, boardComments: [...(data.boardComments || []), pin] });
    setOpenPinId(pin.id);
    setPinDraft("");
    setTool("move");
  };
  const updatePin = (id, patch) => edit({ ...data, boardComments: (data.boardComments || []).map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const removePin = (id) => {
    edit({ ...data, boardComments: (data.boardComments || []).filter((c) => c.id !== id) });
    if (openPinId === id) setOpenPinId(null);
  };
  const sayOnPin = (pin) => {
    const said = pinDraft.trim();
    if (!said) return;
    setPinDraft("");
    // The first thing said is the comment itself; everything after is a reply,
    // so an unanswered pin reads as one remark rather than an empty thread.
    if (!pin.text) return updatePin(pin.id, { text: said, author: profile || "Someone", date: todayISO() });
    updatePin(pin.id, { replies: [...(pin.replies || []), { id: uid(), author: profile || "Someone", text: said, date: todayISO() }] });
  };

  const addSticker = (emoji) => {
    const count = boardItems.filter((b) => b.sticker).length;
    addBoardItem({
      type: "text", sticker: true, text: emoji,
      x: 70 + (count % 8) * 70, y: 70 + Math.floor(count / 8) * 70,
      w: 64, fontSize: 44, align: "center", font: "sans", color: "var(--text)", bg: null,
    });
    setShowStickers(false);
  };

  const addBoardItem = (item) => {
    const created = { id: uid(), folderId: openFolderId || null, ...item };
    edit({ ...data, boardItems: [...allBoardItems, created] });
    return created;
  };
  // A duplicated picture points at the same file in Drive as the original, so
  // deleting one copy must not delete the file the other still shows. Only the
  // last reference takes the file with it.
  const fileStillUsedElsewhere = (fileId, ignoreItemId) => {
    if (!fileId) return true;
    if (allBoardItems.some((b) => b.id !== ignoreItemId && b.fileId === fileId)) return true;
    return ideas.some((i) => (i.attachments || []).some((a) => a.fileId === fileId));
  };
  const removeBoardItem = (id) => {
    const item = allBoardItems.find((b) => b.id === id);
    if (item && item.fileId && !fileStillUsedElsewhere(item.fileId, id)) deleteDriveFile(item.fileId);
    edit({ ...data, boardItems: allBoardItems.filter((b) => b.id !== id) });
    if (editingTextId === id) setEditingTextId(null);
    if (isPicked("item", id)) setSelected(null);
  };
  // Delete routes back through each kind's own remover so the side effects
  // still happen — a picture's Drive file goes with it, a folder asks first.
  const deleteSelected = () => {
    if (!selection.length) return;
    // Deliberately not a loop over the single-item removers. Each of those
    // builds its change from the board as this render saw it, so calling them
    // one after another has every call start from the same board and only the
    // last one survive — three things picked, one thing deleted. It also has to
    // be a single change so that one press of undo brings all of them back.
    const going = { item: new Set(), idea: new Set(), folder: new Set(), shape: new Set() };
    for (const sel of selection) going[sel.kind].add(sel.id);

    // A folder asks before turning its contents loose, and the answer has to
    // come before anything is removed.
    for (const id of going.folder) {
      const folder = folders.find((f) => f.id === id);
      const inside = ideas.filter((i) => i.folderId === id).length + allBoardItems.filter((b) => b.folderId === id).length;
      if (inside > 0 && !window.confirm(`"${folder ? folder.name : "This folder"}" has ${inside} thing${inside === 1 ? "" : "s"} inside. They'll move back out to the main board, and anything drawn in here is removed. Delete the folder?`)) return;
    }

    const survivingItems = allBoardItems.filter((b) => !going.item.has(b.id));
    const survivingIdeas = ideas.filter((i) => !going.idea.has(i.id));
    // Same rule as before, judged against everything that survives at once: a
    // file in Drive only goes when nothing left on the board points at it.
    const stillUsed = (fileId) =>
      !fileId ||
      survivingItems.some((b) => b.fileId === fileId) ||
      survivingIdeas.some((i) => (i.attachments || []).some((a) => a.fileId === fileId));
    for (const b of allBoardItems) if (going.item.has(b.id) && b.fileId && !stillUsed(b.fileId)) deleteDriveFile(b.fileId);
    for (const i of ideas) if (going.idea.has(i.id)) for (const a of i.attachments || []) if (!stillUsed(a.fileId)) deleteDriveFile(a.fileId);

    setSelection([]);
    if (going.item.has(editingTextId)) setEditingTextId(null);
    if (going.idea.size) setOpenIdeaId(null);
    if (going.folder.has(openFolderId)) setOpenFolderId(null);

    edit({
      ...data,
      boardItems: survivingItems.map((b) => (going.folder.has(b.folderId) ? { ...b, folderId: null } : b)),
      ideas: survivingIdeas.map((i) => (going.folder.has(i.folderId) ? { ...i, folderId: null } : i)),
      ideaFolders: folders.filter((f) => !going.folder.has(f.id)),
      ideaDrawings: (data.ideaDrawings || []).filter((dr) => !going.shape.has(dr.id) && !going.folder.has(dr.folderId)),
      boardComments: (data.boardComments || []).filter((c) => !going.folder.has(c.folderId)),
    });
  };

  // Opening is the second tap on something already picked, or the toolbar
  // button — so one tap can pick a thing up without a modal appearing over it.
  const openSelected = () => {
    const el = pickedElement();
    if (!el || !selected) return;
    if (selected.kind === "shape") return;   // a shape has nothing to open
    if (selected.kind === "idea") return setOpenIdeaId(el.id);
    if (selected.kind === "folder") return setOpenFolderId(el.id);
    if (el.type === "text") { setEditingTextId(el.id); setEditingText(el.text || ""); live.signal({ kind: "write", itemId: el.id }); return; }
    setLightbox({ fileId: el.fileId, kind: el.kind, name: el.name });
  };

  // Board-wide shortcuts. Ignored while a field has focus, so Ctrl+Z inside a
  // text box still undoes typing rather than the last thing put on the board.
  useEffect(() => {
    const onKey = (ev) => {
      const el = ev.target;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (typing) return;
      const meta = ev.ctrlKey || ev.metaKey;
      if (meta && ev.key.toLowerCase() === "z") { ev.preventDefault(); return ev.shiftKey ? redo() : undo(); }
      if (meta && ev.key.toLowerCase() === "y") { ev.preventDefault(); return redo(); }
      if (meta && ev.key.toLowerCase() === "d") { ev.preventDefault(); return duplicateSelected(); }
      if (meta && ev.key.toLowerCase() === "c") { ev.preventDefault(); return copySelection(); }
      if (meta && ev.key.toLowerCase() === "x") { ev.preventDefault(); return cutSelection(); }
      // V is deliberately absent: the paste event above handles it, and it's
      // the only one of the two that can see a screenshot on the clipboard.
      if (ev.key === "Delete" || ev.key === "Backspace") { if (selected) { ev.preventDefault(); deleteSelected(); } return; }
      if (meta && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        const everything = [];
        for (const [kind, list] of [["item", boardItems], ["idea", boardIdeas], ["folder", currentFolder ? [] : folders], ["shape", drawings]]) {
          for (const el of list) everything.push({ kind, id: el.id });
        }
        return setSelection(everything);
      }
      if (selection.length && ev.key.startsWith("Arrow")) {
        // Shift jumps ten at a time, for when a pixel at a time is too slow.
        const step = ev.shiftKey ? 10 : 1;
        const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
        if (by) { ev.preventDefault(); return nudgeSelection(by[0], by[1]); }
      }
      if (penPoints && (ev.key === "Enter" || ev.key === "Escape")) {
        ev.preventDefault();
        return ev.key === "Enter" ? finishCurve(penPoints) : setPenPoints(null);
      }
      if (ev.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const commitText = () => {
    live.stop();
    if (!editingTextId) return;
    const id = editingTextId;
    const text = editingText;
    setEditingTextId(null);
    // An empty text box is just clutter — drop it rather than leave a blank.
    if (!text.trim()) return removeBoardItem(id);
    edit({ ...data, boardItems: allBoardItems.map((b) => (b.id === id ? { ...b, text } : b)) });
  };

  // Pictures arrive three ways now — the picker, a file dragged in, or a
  // screenshot pasted — and all three want the same thing to happen, so they
  // all come through here. `at` is where to put it; without one they cascade
  // from the corner the way the picker always did.
  const addPictureFromFile = async (file, at) => {
    if (!file || !file.type || !file.type.startsWith("image/")) return false;
    setBoardUploading(true);
    setBoardUploadProgress(0);
    try {
      const result = await uploadToDrive(file, setBoardUploadProgress, profile);
      const count = boardItems.filter((b) => b.type === "image").length;
      addBoardItem({
        type: "image",
        fileId: driveFileId(result.link),
        kind: result.kind,
        name: result.name,
        x: at ? Math.max(0, Math.round(at.x)) : 60 + (count % 5) * 60,
        y: at ? Math.max(0, Math.round(at.y)) : 60 + (count % 5) * 40,
        w: 260,
      });
      return true;
    } catch {
      // nothing half-created is left behind; the picker can just be used again
      return false;
    } finally {
      setBoardUploading(false);
    }
  };

  const handleBoardFileSelect = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    await addPictureFromFile(file);
    e.target.value = "";
  };

  // Dropping files on the board. Several at once fan out from where they landed
  // rather than piling up in one spot.
  const [dropTarget, setDropTarget] = useState(false);
  const handleBoardDrop = async (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((fl) => fl.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    setDropTarget(false);
    const rect = boardRef.current && boardRef.current.getBoundingClientRect();
    const at = rect
      ? { x: (e.clientX - rect.left) / zoomRef.current, y: (e.clientY - rect.top) / zoomRef.current }
      : null;
    // One at a time: each upload needs the board as it stands after the last,
    // and firing them together would have them all read the same board and
    // only the last one stick.
    for (let i = 0; i < files.length; i++) {
      await addPictureFromFile(files[i], at ? { x: at.x + i * 26, y: at.y + i * 22 } : null);
    }
  };

  // Dragging the corner of a picture to size it, saved once on release.
  const startResize = (e, item) => {
    e.preventDefault();
    e.stopPropagation();
    const p = e.touches ? e.touches[0] : e;
    const startX = p.clientX;
    const startW = item.w || 260;
    let latest = startW;
    const move = (ev) => {
      const q = ev.touches ? ev.touches[0] : ev;
      latest = Math.max(80, Math.min(900, Math.round(startW + (q.clientX - startX) / zoomRef.current)));
      setResizing({ id: item.id, w: latest });
    };
    const end = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      setResizing(null);
      edit({ ...data, boardItems: allBoardItems.map((b) => (b.id === item.id ? { ...b, w: latest } : b)) });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
  };

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="page-title">Idea Bank</div>
          <div className="page-sub">{currentFolder ? `Inside "${currentFolder.name}" — drag ideas around, or head back to the board.` : "A space to spark ideas — drag things wherever they feel right."}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {currentFolder ? (
            <>
              <button className="btn" onClick={() => setOpenFolderId(null)}><ChevronLeft size={15} /> Back to board</button>
              <button className="btn" style={{ borderColor: "var(--alert)", color: "var(--alert)" }} onClick={() => removeFolder(currentFolder.id)}><Trash2 size={14} /> Delete folder</button>
            </>
          ) : (
            <button className="btn" onClick={() => setShowFolderForm(true)}><Folder size={15} /> New folder</button>
          )}
          <button className="btn" onClick={startPresenting}><PlayIcon size={15} /> Present</button>
          <button className="btn" onClick={() => setFindText("")}><Search size={15} /> Find</button>
          <button className="btn" onClick={openHistory}><Clock size={15} /> History</button>
          <button className="btn" onClick={() => setShowStickers(true)}><Smile size={15} /> Stickers</button>
          <button className="btn" onClick={() => setShowTemplates(true)}><Layers size={15} /> Templates</button>
          <button className="btn" onClick={() => exportBoard("png")} disabled={!!exporting}>
            <Upload size={15} /> {exporting === "png" ? "Saving…" : "PNG"}
          </button>
          {selection.length > 0 && (
            <button className="btn" onClick={exportSelection} disabled={!!exporting}>
              <Upload size={15} /> {exporting === "selection" ? "Saving…" : "Export picked"}
            </button>
          )}
          <button className="btn" onClick={() => exportBoard("print")} disabled={!!exporting}>
            <BookOpen size={15} /> {exporting === "print" ? "Preparing…" : "PDF"}
          </button>
          <button className="btn btn-gold" onClick={() => { setForm((f) => ({ ...f, color: IDEA_COLORS[boardIdeas.length % IDEA_COLORS.length] })); setShowForm(true); live.signal({ kind: "write", label: "writing a new idea" }); }}><Plus size={15} /> Add idea</button>
        </div>
      </div>

      {live.peers.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 10, fontSize: 11.5, color: "var(--muted)" }}>
          <span style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, fontSize: 10.5 }}>Also here</span>
          {live.peers.map((peer) => {
            const act = live.activity[peer.id];
            const tone = `var(--${peer.color || "gold"})`;
            const doing = !act ? null
              : act.kind === "drag" ? "moving something"
              : act.kind === "draw" ? "drawing"
              : act.kind === "write" ? (act.label || "writing") : null;
            const theirFolder = peer.where ? (folders.find((f) => f.id === peer.where) || {}).name : null;
            const elsewhere = (peer.where || null) !== (openFolderId || null);
            return (
              <span
                key={peer.id}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px 3px 3px", borderRadius: 999, background: "var(--panel-raised)", border: `1px solid ${doing ? tone : "var(--hair)"}` }}
              >
                <span style={{ width: 18, height: 18, borderRadius: "50%", background: `var(--${peer.color || "gold"}-soft)`, color: tone, fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {(peer.name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
                </span>
                <span style={{ color: "var(--text)", fontWeight: 600 }}>{peer.name}</span>
                {doing && <span style={{ color: tone }}>· {doing}</span>}
                {!doing && elsewhere && <span>· {theirFolder ? `in ${theirFolder}` : "on the main board"}</span>}
              </span>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <button
          className="btn" style={{ padding: "6px 10px", fontSize: 12 }}
          onClick={undo} disabled={historyDepth.past === 0} title="Undo (Ctrl+Z)"
        ><RotateCcw size={13} /> Undo</button>
        <button
          className="btn" style={{ padding: "6px 10px", fontSize: 12 }}
          onClick={redo} disabled={historyDepth.future === 0} title="Redo (Ctrl+Shift+Z)"
        ><RotateCw size={13} /> Redo</button>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginRight: 2 }}>
          <button className="btn" style={{ padding: "6px 9px", fontSize: 12 }} onClick={() => zoomStep(-1)} title="Zoom out (Ctrl+scroll)"><Minus size={13} /></button>
          <button
            className="btn" style={{ padding: "6px 8px", fontSize: 11, minWidth: 48 }}
            onClick={() => zoomTo(1)} title="Back to actual size"
          >{Math.round(zoom * 100)}%</button>
          <button className="btn" style={{ padding: "6px 9px", fontSize: 12 }} onClick={() => zoomStep(1)} title="Zoom in (Ctrl+scroll)"><Plus size={13} /></button>
          <button className="btn" style={{ padding: "6px 9px", fontSize: 11 }} onClick={zoomToFit} title="Fit the whole board">Fit</button>
        </span>
        {clipHas > 0 && (
          <button
            className="btn" style={{ padding: "6px 10px", fontSize: 12 }}
            onClick={pasteClipboard} title="Paste (Ctrl+V) — lands where your pointer is"
          ><ClipboardPaste size={13} /> Paste{clipHas > 1 ? ` ${clipHas}` : ""}</button>
        )}
        <span style={{ width: 1, height: 20, background: "var(--hair)", margin: "0 2px" }} />
        {TOOLS.map((t) => {
          const TIcon = t.icon;
          return (
            <button
              key={t.id}
              className="btn"
              style={{ padding: "6px 10px", fontSize: 12, background: tool === t.id ? "var(--gold-soft)" : undefined, borderColor: tool === t.id ? "var(--gold)" : undefined, color: tool === t.id ? "var(--gold)" : undefined }}
              onClick={() => setTool(t.id)}
            >
              <TIcon size={13} /> {t.label}
            </button>
          );
        })}
        <button
          className="btn"
          style={{ padding: "6px 10px", fontSize: 12 }}
          onClick={() => boardFileInputRef.current && boardFileInputRef.current.click()}
          disabled={boardUploading}
          title="Drop a picture straight onto the board"
        >
          <Image size={13} /> {boardUploading ? `Adding… ${boardUploadProgress}%` : "Picture"}
        </button>
        <input ref={boardFileInputRef} type="file" accept="video/*,image/*" onChange={handleBoardFileSelect} disabled={boardUploading} style={{ display: "none" }} />
      </div>

      {/* Board and its panel sit side by side on a laptop. On a phone the panel
          drops underneath instead, because a 268px column beside a 414px screen
          leaves room for neither. Either way it is always present, so picking
          something up never moves the board — that shift is what once put
          Delete under a double-click. */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexDirection: isNarrow ? "column" : "row" }}>
        <div
          ref={scrollRef}
          onDragOver={(e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); setDropTarget(true); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTarget(false); }}
          onDrop={handleBoardDrop}
          onWheel={(e) => {
            // Ctrl+wheel is the zoom gesture everywhere else, and it's what a
            // trackpad pinch arrives as. Plain wheel still scrolls.
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            zoomTo(zoomRef.current * (e.deltaY < 0 ? 1.12 : 0.89));
          }}
          style={{ position: "relative", flex: "1 1 auto", minWidth: 0, width: "100%", overflow: "auto", border: `1px solid ${dropTarget ? "var(--gold)" : "var(--hair)"}`, borderRadius: 12, background: "var(--panel)", outline: dropTarget ? "2px dashed var(--gold)" : "none", outlineOffset: -5 }}
        >
        {/* A shim at the zoomed size, because a transform doesn't change how
            much room something takes up — without it the scrollbars would still
            think the board was its original size. */}
        <div style={{ width: BOARD_W * zoom, height: BOARD_H * zoom, position: "relative" }}>
        <div
          ref={boardRef}
          onMouseMove={(e) => {
            const rect = boardRef.current && boardRef.current.getBoundingClientRect();
            if (rect) pointerRef.current = { x: Math.round((e.clientX - rect.left) / zoomRef.current), y: Math.round((e.clientY - rect.top) / zoomRef.current) };
          }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected(null); startDraw(e); }}
          onTouchStart={(e) => { if (e.target === e.currentTarget) setSelected(null); startDraw(e); }}
          style={{ position: "relative", width: BOARD_W, height: BOARD_H, background: surface.paper, backgroundImage: surface.image, backgroundSize: surface.size, color: surface.ink, cursor: drawingMode && tool !== "erase" ? "crosshair" : "default", touchAction: drawingMode ? "none" : "auto", transform: zoom === 1 ? undefined : `scale(${zoom})`, transformOrigin: "0 0" }}
        >
          <svg
            width={BOARD_W}
            height={BOARD_H}
            // The layer itself never catches clicks — only the strokes do, and
            // only while erasing — so cards and pictures underneath stay usable.
            // Above every element: pen marks annotate whatever is underneath,
            // so restacking a picture must never bury someone's notes.
            style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 900 }}
          >
            {liveLinks.map(({ l, a, b }) => {
              const from = edgePoint(boundsOf(a), boundsOf(b));
              const to = edgePoint(boundsOf(b), boundsOf(a));
              const w = l.width || 3;
              const head = arrowHeadPoints({ x1: from.x, y1: from.y, x2: to.x, y2: to.y }, w);
              return (
                <g key={l.id}>
                  <line
                    x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                    stroke="transparent" strokeWidth={Math.max(18, w + 14)}
                    style={{ cursor: tool === "erase" ? "pointer" : "default", pointerEvents: tool === "erase" ? "stroke" : "none" }}
                    onClick={() => { if (tool === "erase") unjoin(l.id); }}
                  />
                  <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={l.color} strokeWidth={w} strokeLinecap="round" />
                  <polygon points={head} fill={l.color} stroke={l.color} strokeWidth={1} strokeLinejoin="round" />
                </g>
              );
            })}
            {[...drawings].sort((a, b) => stackOf(a) - stackOf(b)).map((sh) => renderShape(sh, sh.id, false))}
            {draft && renderShape(draft, "draft", true)}
            {/* The curve being placed, plus the points of a finished one that's
                picked, so it can be reshaped afterwards. */}
            {penPoints && penPoints.length > 0 && (
              <g>
                <path d={curveThrough(penPoints)} stroke={drawColor} strokeWidth={drawWidth} fill="none" opacity={0.75} strokeDasharray="6 5" />
                {penPoints.map((pt, i) => <circle key={i} cx={pt.x} cy={pt.y} r={4} fill="var(--gold)" />)}
              </g>
            )}
            {pickedShape && pickedShape.tool === "curve" && (pickedShape.curve || []).map((pt, i) => (
              <circle
                key={i} cx={pt.x} cy={pt.y} r={6}
                fill="var(--gold)" stroke="#171812" strokeWidth={1.5}
                style={{ cursor: "grab", pointerEvents: "all" }}
                onMouseDown={(ev) => {
                  ev.stopPropagation();
                  const move = (m) => {
                    const rect = boardRef.current.getBoundingClientRect();
                    moveCurvePoint(pickedShape.id, i, (m.clientX - rect.left) / zoomRef.current, (m.clientY - rect.top) / zoomRef.current);
                  };
                  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
                  window.addEventListener("mousemove", move);
                  window.addEventListener("mouseup", up);
                }}
              />
            ))}
            {strokesHere.map((a) => renderShape(a.shape, `live-${a.id}`, true))}
          </svg>

          {boardItems.map((b) => {
            const pos = boardItemDrag.dragging && boardItemDrag.dragging.id === b.id ? boardItemDrag.dragging : b;
            const width = resizing && resizing.id === b.id ? resizing.w : (b.w || 220);
            const isEditing = editingTextId === b.id;
            return (
              <div
                key={b.id}
                onMouseDown={(e) => { if (!drawingMode && !isEditing) boardItemDrag.startDrag(e, b.id, b.x, b.y); }}
                onTouchStart={(e) => { if (!drawingMode && !isEditing) boardItemDrag.startDrag(e, b.id, b.x, b.y); }}
                onDoubleClick={isEditing ? undefined : openOnDouble("item", b.id, openBoardItem(b))}
                style={{
                  position: "absolute", left: pos.x, top: pos.y, width,
                  mixBlendMode: b.blend && b.blend !== "normal" ? b.blend : undefined,
                  filter: b.shadow && b.shadow !== "none" ? shadowCss(b.shadow) : undefined,
                  transform: b.spin ? `rotate(${b.spin}deg)` : undefined,
                  clipPath: maskCss(b.mask) || undefined,
                  pointerEvents: drawingMode && tool !== "erase" ? "none" : "auto",
                  cursor: isEditing ? "text" : tool === "erase" ? "pointer" : "grab",
                  userSelect: isEditing ? "text" : "none",
                  touchAction: "none", zIndex: 2 + stackOf(b),
                  ...pickedRing("item", b.id),
                }}
              >
                {b.link && (
                  // Its own tap target rather than making the whole element a
                  // link: you still need to be able to pick the thing up, move
                  // it and edit it without being sent off to a browser tab.
                  <a
                    href={b.link} target="_blank" rel="noopener noreferrer"
                    onClick={(ev) => ev.stopPropagation()} onMouseDown={(ev) => ev.stopPropagation()} onTouchStart={(ev) => ev.stopPropagation()}
                    title={b.link}
                    style={{ position: "absolute", top: -9, right: -9, zIndex: 6, width: 24, height: 24, borderRadius: "50%", background: "var(--teal)", color: "#0d1b19", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.45)" }}
                  ><Link2 size={13} /></a>
                )}
                {b.type === "image" ? (
                  <div style={{ position: "relative" }}>
                    {b.crop ? (
                      // The whole picture is still the thing being drawn; the
                      // window in front of it decides how much shows. Height
                      // comes from the crop's share of the picture, which is
                      // why the picture's own proportions are remembered.
                      <div style={{ position: "relative", width: "100%", paddingTop: `${(b.crop.h / b.crop.w) * (100 / (b.imgAspect || 1))}%`, overflow: "hidden", borderRadius: 8, boxShadow: "0 4px 14px rgba(0,0,0,0.4)", background: "var(--panel-raised)" }}>
                        <img
                          src={driveThumbSrc(b.fileId, "s800")} onError={hideBrokenThumb}
                          alt={b.name || ""} draggable={false}
                          style={{ position: "absolute", top: 0, left: 0, width: `${100 / b.crop.w}%`, maxWidth: "none", transform: `translate(${-b.crop.x * 100 / b.crop.w}%, ${-b.crop.y * 100 / b.crop.h}%)`, display: "block", filter: peeking && pickedPhoto && pickedPhoto.id === b.id ? "none" : photoFilter(b) }}
                        />
                      </div>
                    ) : (
                      <img
                        src={driveThumbSrc(b.fileId, "s800")} onError={hideBrokenThumb}
                        alt={b.name || ""}
                        draggable={false}
                        style={{
                          width: "100%", borderRadius: 8, display: "block", boxShadow: "0 4px 14px rgba(0,0,0,0.4)", background: "var(--panel-raised)",
                          filter: peeking && pickedPhoto && pickedPhoto.id === b.id ? "none" : photoFilter(b),
                          transform: photoLook(b).spin ? `rotate(${photoLook(b).spin}deg)` : undefined,
                        }}
                      />
                    )}
                    {b.kind !== "image" && (
                      <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                        <span style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <Play size={18} fill="#fff" color="#fff" />
                        </span>
                      </span>
                    )}
                    {!drawingMode && (
                      <span
                        onMouseDown={(e) => startResize(e, b)}
                        onTouchStart={(e) => startResize(e, b)}
                        title="Drag to resize"
                        style={{ position: "absolute", right: -6, bottom: -6, width: 18, height: 18, borderRadius: 4, background: "var(--gold)", cursor: "nwse-resize", border: "2px solid var(--panel)" }}
                      />
                    )}
                  </div>
                ) : isEditing ? (
                  <textarea
                    autoFocus
                    value={editingText}
                    onChange={(e) => { setEditingText(e.target.value); live.signal({ kind: "write", itemId: b.id }, true); }}
                    onBlur={commitText}
                    onKeyDown={(e) => { if (e.key === "Escape") commitText(); }}
                    style={{
                      width: "100%", minHeight: 70,
                      background: b.bg || "var(--panel-raised)",
                      color: b.bg ? (b.color || "#22232b") : "var(--text)",
                      border: `1px solid ${b.bg ? "var(--text)" : b.color || "var(--gold)"}`,
                      borderRadius: 6, padding: "8px 10px", resize: "none",
                      ...textStyleOf(b),
                    }}
                  />
                ) : (
                  <div
                    style={{
                      whiteSpace: "pre-wrap", wordBreak: "break-word",
                      // Text with no colour of its own follows the board, so
                      // switching to a pale surface doesn't leave it invisible.
                      color: b.color || surface.ink,
                      ...textStyleOf(b),
                      padding: b.bg ? "11px 12px" : "6px 8px",
                      background: b.bg || "transparent",
                      borderRadius: b.bg ? 4 : 0,
                      boxShadow: b.bg ? "0 6px 14px rgba(0,0,0,0.38)" : "none",
                      // A shadow behind loose text keeps it readable over a
                      // photo; on a sticky note the note itself does that job.
                      textShadow: b.bg || surface.ink !== "#EDEBE3" ? "none" : "0 1px 3px rgba(0,0,0,0.5)",
                      minHeight: b.bg ? 60 : 0,
                    }}
                  >
                    {b.text}
                  </div>
                )}
              </div>
            );
          })}
          {/* Follows the other person's pointer in real time. Nothing here is
              saved — when they let go, the real item arrives through the
              normal save and this marker disappears. */}
          {dragsHere.map((a) => (
            <div
              key={a.id}
              style={{
                position: "absolute", left: a.x, top: a.y,
                width: a.w || 152, height: a.h || 88,
                border: `2px dashed var(--${a.color || "gold"})`,
                borderRadius: 8, pointerEvents: "none", zIndex: 4,
              }}
            >
              <span style={{ position: "absolute", top: -19, left: -2, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap", padding: "2px 6px", borderRadius: 4, background: `var(--${a.color || "gold"})`, color: "#171812" }}>
                {a.name}
              </span>
            </div>
          ))}

          {guides && (guides.x !== null || guides.y !== null) && (
            <>
              {guides.x !== null && (
                <div style={{ position: "absolute", left: guides.x, top: 0, width: 1, height: BOARD_H, background: "var(--teal)", opacity: 0.9, pointerEvents: "none", zIndex: 940 }} />
              )}
              {guides.y !== null && (
                <div style={{ position: "absolute", top: guides.y, left: 0, height: 1, width: BOARD_W, background: "var(--teal)", opacity: 0.9, pointerEvents: "none", zIndex: 940 }} />
              )}
            </>
          )}

          {pins.map((c) => {
            const open = openPinId === c.id;
            return (
              <div key={c.id} style={{ position: "absolute", left: c.x, top: c.y, zIndex: 950 }}>
                <button
                  onClick={(ev) => { ev.stopPropagation(); setOpenPinId(open ? null : c.id); setPinDraft(""); }}
                  onMouseDown={(ev) => ev.stopPropagation()}
                  title={c.text || "Empty note"}
                  style={{
                    width: 26, height: 26, borderRadius: "50% 50% 50% 2px",
                    background: c.resolved ? "var(--good)" : "var(--gold)", color: "#171812",
                    border: "2px solid var(--panel)", cursor: "pointer", fontSize: 11, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 3px 10px rgba(0,0,0,0.45)",
                  }}
                >{c.resolved ? <Check size={13} strokeWidth={3} /> : (c.replies || []).length + (c.text ? 1 : 0) || <MessageSquare size={12} />}</button>

                {open && (
                  <div
                    onMouseDown={(ev) => ev.stopPropagation()}
                    style={{ position: "absolute", left: 32, top: 0, width: 250, background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 10, padding: 11, boxShadow: "0 10px 28px rgba(0,0,0,0.5)", zIndex: 960 }}
                  >
                    {c.text ? (
                      <>
                        <div style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.45, marginBottom: 3 }}><Linkify text={c.text} /></div>
                        <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 9 }}>{c.author} · {fmtDate(c.date)}</div>
                      </>
                    ) : (
                      <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 9 }}>What did you want to say about this spot?</div>
                    )}
                    {(c.replies || []).map((rep) => (
                      <div key={rep.id} style={{ borderTop: "1px solid var(--hair)", paddingTop: 7, marginBottom: 7 }}>
                        <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.4 }}><Linkify text={rep.text} /></div>
                        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{rep.author}</div>
                      </div>
                    ))}
                    <textarea
                      value={pinDraft} onChange={(ev) => setPinDraft(ev.target.value)}
                      onKeyDown={(ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); sayOnPin(c); } }}
                      placeholder={c.text ? "Reply…" : "Say something…"}
                      style={{ width: "100%", minHeight: 46, background: "var(--panel)", border: "1px solid var(--hair)", borderRadius: 6, color: "var(--text)", fontSize: 12, padding: "6px 8px", resize: "none", outline: "none", marginBottom: 7 }}
                    />
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button className="btn" style={{ padding: "4px 9px", fontSize: 11 }} onClick={() => sayOnPin(c)}>Post</button>
                      <button className="btn" style={{ padding: "4px 9px", fontSize: 11 }} onClick={() => updatePin(c.id, { resolved: !c.resolved })}>
                        {c.resolved ? "Reopen" : "Resolve"}
                      </button>
                      <button className="btn" style={{ padding: "4px 9px", fontSize: 11, borderColor: "var(--alert)", color: "var(--alert)", marginLeft: "auto" }} onClick={() => removePin(c.id)}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* "…is writing" over the box they're typing in. */}
          {writersHere.filter((a) => a.itemId).map((a) => {
            const target = boardItems.find((b) => b.id === a.itemId);
            if (!target) return null;
            return (
              <span
                key={a.id}
                style={{ position: "absolute", left: target.x, top: target.y - 19, zIndex: 4, pointerEvents: "none", fontSize: 10, fontWeight: 700, whiteSpace: "nowrap", padding: "2px 6px", borderRadius: 4, background: `var(--${a.color || "gold"})`, color: "#171812" }}
              >
                {a.name} is writing…
              </span>
            );
          })}

          {!currentFolder && folders.map((f) => {
            const pos = folderDrag.dragging && folderDrag.dragging.id === f.id ? folderDrag.dragging : f;
            const count = ideas.filter((i) => i.folderId === f.id).length;
            return (
              <div
                key={f.id}
                onMouseDown={(e) => { if (!drawingMode) folderDrag.startDrag(e, f.id, f.x || 0, f.y || 0); }}
                onTouchStart={(e) => { if (!drawingMode) folderDrag.startDrag(e, f.id, f.x || 0, f.y || 0); }}
                onDoubleClick={openOnDouble("folder", f.id, () => setOpenFolderId(f.id))}
                style={{ position: "absolute", left: pos.x, top: pos.y, width: 116, cursor: "grab", userSelect: "none", touchAction: "none", pointerEvents: drawingMode ? "none" : "auto", textAlign: "center", zIndex: 2 + stackOf(f), ...pickedRing("folder", f.id) }}
              >
                <div style={{ width: 62, height: 50, margin: "0 auto 6px", borderRadius: 8, background: f.color || IDEA_COLORS[0], display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 10px rgba(0,0,0,0.35)" }}>
                  <FolderOpen size={24} color="#22232b" />
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}>{f.name}</div>
                <div style={{ fontSize: 9.5, color: "var(--muted)" }}>{count} idea{count === 1 ? "" : "s"}</div>
              </div>
            );
          })}

          {boardIdeas.map((i) => {
            const pos = ideaDrag.dragging && ideaDrag.dragging.id === i.id ? ideaDrag.dragging : i;
            return (
              <div
                key={i.id}
                onMouseDown={(e) => { if (!drawingMode) ideaDrag.startDrag(e, i.id, i.x, i.y); }}
                onTouchStart={(e) => { if (!drawingMode) ideaDrag.startDrag(e, i.id, i.x, i.y); }}
                onDoubleClick={openOnDouble("idea", i.id, () => setOpenIdeaId(i.id))}
                style={{ position: "absolute", left: pos.x, top: pos.y, width: 152, minHeight: 88, pointerEvents: drawingMode ? "none" : "auto", background: i.color, borderRadius: 8, padding: "10px 11px", boxShadow: "0 4px 10px rgba(0,0,0,0.35)", cursor: "grab", userSelect: "none", touchAction: "none", zIndex: 2 + stackOf(i), ...pickedRing("idea", i.id) }}
              >
                {i.attachments && i.attachments.length > 0 && (
                  i.attachments[0].kind === "image" ? (
                    <img src={driveThumbSrc(i.attachments[0].fileId)} onError={hideBrokenThumb} alt="" draggable={false} style={{ width: "100%", height: 66, objectFit: "cover", borderRadius: 5, marginBottom: 7, display: "block" }} />
                  ) : (
                    <div style={{ position: "relative", width: "100%", height: 66, borderRadius: 5, marginBottom: 7, overflow: "hidden", background: "rgba(0,0,0,0.35)" }}>
                      <img src={driveThumbSrc(i.attachments[0].fileId)} onError={hideBrokenThumb} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ width: 26, height: 26, borderRadius: "50%", background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <Play size={13} fill="#fff" color="#fff" />
                        </span>
                      </span>
                    </div>
                  )
                )}
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#22232b", lineHeight: 1.3, marginBottom: 10, wordBreak: "break-word" }}>{i.title}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "absolute", left: 11, right: 11, bottom: 8 }}>
                  <span style={{ fontSize: 10, color: "#22232b", opacity: 0.7 }}>{i.author || "Anon"}</span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {i.attachments && i.attachments.length > 1 && <span style={{ fontSize: 10, color: "#22232b", opacity: 0.7 }}>{i.attachments.length} files</span>}
                    {voteCount(i) > 0 && <span style={{ fontSize: 10, color: "#22232b", fontWeight: 700 }}>▲ {voteCount(i)}</span>}
                  </span>
                </div>
              </div>
            );
          })}

          {!currentFolder && folders.length === 0 && boardIdeas.length === 0 && boardItems.length === 0 && drawings.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13, padding: 20, textAlign: "center" }}>
              Nothing here yet — add an idea or a folder to get started.
            </div>
          )}
          {currentFolder && boardIdeas.length === 0 && boardItems.length === 0 && drawings.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 }}>
              Nothing in this folder yet.
            </div>
          )}
        </div>
        </div>
        </div>
        {/* ---- properties panel: only ever shows controls for what's picked ---- */}
        <div
          style={{
            width: isNarrow ? "100%" : 272, flexShrink: 0, boxSizing: "border-box",
            background: "var(--panel)", border: "1px solid var(--hair)", borderRadius: 12,
            maxHeight: isNarrow ? 420 : BOARD_H, overflowY: "auto",
          }}
        >
          <div style={{ padding: "11px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: picked ? "var(--gold)" : "var(--text)" }}>
                {selection.length > 1 ? `${selection.length} picked` : picked ? pickedLabel : "Nothing picked"}
              </span>
              {picked && (
                <button className="btn" style={{ padding: "3px 8px", fontSize: 10.5 }} onClick={() => setSelected(null)}>Done</button>
              )}
            </div>
            {!picked && (
              <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5, marginTop: 6 }}>
                Click something to pick it up, double-click to open it, Shift-click for several.
                Drag pictures straight onto the board, or paste a screenshot with Ctrl+V.
                Things snap to line up with their neighbours — hold Alt while dragging to ignore that.
                The settings below apply to whatever you draw next.
              </div>
            )}
          </div>

          {picked && (
            <PanelSection title="Do">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {selection.length === 1 && selected.kind !== "shape" && (
                  <button className="btn" style={PANEL_BTN} onClick={openSelected}><ExternalLink size={11} /> Open</button>
                )}
                <button className="btn" style={PANEL_BTN} onClick={copySelection} title="Ctrl+C"><Copy size={11} /> Copy</button>
                <button className="btn" style={PANEL_BTN} onClick={duplicateSelected} title="Ctrl+D"><Copy size={11} /> Duplicate</button>
                <button className="btn" style={PANEL_BTN} onClick={bringToFront}><ChevronUp size={11} /> Front</button>
                <button className="btn" style={PANEL_BTN} onClick={sendToBack}><ChevronDown size={11} /> Back</button>
                {selection.length > 1 && (
                  <button className="btn" style={PANEL_BTN} onClick={groupSelection}><Layers size={11} /> Group</button>
                )}
                {selection.length === 2 && (
                  <button className="btn" style={PANEL_BTN} onClick={joinSelection} title="An arrow that follows both of them"><ArrowRight size={11} /> Join</button>
                )}
                {selection.some((sel) => (listFor(sel.kind).find((el) => el.id === sel.id) || {}).groupId) && (
                  <button className="btn" style={PANEL_BTN} onClick={ungroupSelection}>Ungroup</button>
                )}
                {selection.length === 1 && selected.kind === "item" && pickedElement().type === "image" && pickedElement().kind === "image" && (
                  <button
                    className="btn"
                    style={{ ...PANEL_BTN, ...(pickedElement().crop ? { borderColor: "var(--gold)", color: "var(--gold)" } : {}) }}
                    onClick={() => setCropping(pickedElement())}
                  ><Crop size={11} /> Crop</button>
                )}
              </div>
              {/* Kept away from the rest: it's the one action that can't be
                  taken back by aiming again. */}
              <button
                className="btn"
                style={{ ...PANEL_BTN, marginTop: 8, width: "100%", justifyContent: "center", borderColor: "var(--alert)", color: "var(--alert)" }}
                onClick={deleteSelected} title="Delete key"
              ><Trash2 size={11} /> Delete</button>
            </PanelSection>
          )}

          {picked && selection.length === 1 && selected.kind === "item" && (
            <PanelSection title="Link">
              {linkDraft === null ? (
                <button
                  className="btn"
                  style={{ ...PANEL_BTN, width: "100%", justifyContent: "center", ...(pickedElement().link ? { borderColor: "var(--teal)", color: "var(--teal)" } : {}) }}
                  onClick={() => setLinkDraft(pickedElement().link || "")}
                  title={pickedElement().link || "Point this at a link"}
                ><Link2 size={11} /> {pickedElement().link ? "Linked — change" : "Add a link"}</button>
              ) : (
                <>
                  <input
                    autoFocus value={linkDraft} onChange={(e) => setLinkDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveLink(linkDraft); if (e.key === "Escape") setLinkDraft(null); }}
                    placeholder="Paste a link…"
                    style={{ width: "100%", boxSizing: "border-box", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 5, color: "var(--text)", fontSize: 11.5, padding: "6px 8px", outline: "none", marginBottom: 6 }}
                  />
                  <div style={{ display: "flex", gap: 5 }}>
                    <button className="btn" style={PANEL_BTN} onClick={() => saveLink(linkDraft)}>Save</button>
                    <button className="btn" style={PANEL_BTN} onClick={() => setLinkDraft(null)}>Cancel</button>
                    {pickedElement().link && <button className="btn" style={PANEL_BTN} onClick={() => saveLink("")}>Remove</button>}
                  </div>
                </>
              )}
            </PanelSection>
          )}

          {pickedPhoto && (
            <PanelSection title="Picture">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                {PHOTO_PRESETS.map((pre) => (
                  <button key={pre.id} className="btn" style={PANEL_BTN} onClick={() => usePreset(pre)}>{pre.label}</button>
                ))}
              </div>
              {PHOTO_SLIDERS.map(({ key, label, min, max }) => {
                const value = photoLook(pickedPhoto)[key];
                return (
                  <div key={key} style={{ marginBottom: 7 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginBottom: 2 }}>
                      <span>{label}</span><span>{value > 0 ? "+" : ""}{value}</span>
                    </div>
                    <input
                      type="range" min={min} max={max} step="1" value={value}
                      onChange={(e) => applyLook({ [key]: Number(e.target.value) })}
                      onDoubleClick={() => applyLook({ [key]: PHOTO_DEFAULTS[key] })}
                      title="Double-click to put this one back"
                      style={{ width: "100%", accentColor: "var(--gold)" }}
                    />
                  </div>
                );
              })}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}>
                <button className="btn" style={PANEL_BTN} onClick={spinPhoto} title="Turn a quarter turn"><RotateCw size={11} /> Turn</button>
                <button
                  className="btn" style={PANEL_BTN}
                  onMouseDown={() => setPeeking(true)} onMouseUp={() => setPeeking(false)} onMouseLeave={() => setPeeking(false)}
                  onTouchStart={() => setPeeking(true)} onTouchEnd={() => setPeeking(false)}
                  title="Hold to see it without the edit"
                  disabled={!hasLook(pickedPhoto)}
                >Before</button>
                <button className="btn" style={PANEL_BTN} onClick={copyLook} disabled={!hasLook(pickedPhoto)} title="Copy this look">Copy look</button>
                <button
                  className="btn" style={PANEL_BTN} onClick={() => removeBackgroundFrom(pickedPhoto)} disabled={!!cutting}
                  title="Cuts the subject out and puts the result beside the original"
                ><Scissors size={11} /> Cut out</button>
              </div>
              {cutting && (
                <div style={{ fontSize: 10.5, color: "var(--gold)", marginTop: 7, lineHeight: 1.4 }}>{cutting}</div>
              )}
              {lookClip && (
                <button
                  className="btn" style={{ ...PANEL_BTN, marginTop: 6, width: "100%", justifyContent: "center", borderColor: "var(--teal)", color: "var(--teal)" }}
                  onClick={pasteLook}
                >Paste that look here</button>
              )}
            </PanelSection>
          )}

          {(showTextControls || showShapeControls) && (
            <PanelSection title={pickedShape ? "Shape" : showTextControls && !showShapeControls ? "Text colour" : "Colour"}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                {IDEA_COLORS.map((c) => (
                  <button
                    key={c} onClick={() => applyStyle({ color: c })} title="Line, pen and text colour"
                    style={{ width: 22, height: 22, borderRadius: "50%", background: c, border: styleNow.color === c ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer", padding: 0 }}
                  />
                ))}
                <input
                  type="color" value={styleNow.color} onChange={(e) => applyStyle({ color: e.target.value })}
                  title="Any other colour"
                  style={{ width: 26, height: 24, padding: 0, border: "1px solid var(--hair)", borderRadius: 5, background: "none", cursor: "pointer" }}
                />
                {canDrop && (
                  <button className="btn" style={PANEL_BTN} onClick={pickFromScreen} title="Take a colour from anywhere on screen"><Pipette size={11} /></button>
                )}
                <button className="btn" style={PANEL_BTN} onClick={() => rememberColour(styleNow.color)} title="Keep this colour for the team">Save</button>
              </div>
              {palette.length > 0 && (
                <>
                  <div style={{ fontSize: 10, color: "var(--muted)", margin: "9px 0 5px" }}>Your colours · right-click to drop one</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                    {palette.map((c) => (
                      <button
                        key={c} onClick={() => applyStyle({ color: c })}
                        onContextMenu={(e) => { e.preventDefault(); forgetColour(c); }}
                        title={`${c} — right-click to remove`}
                        style={{ width: 22, height: 22, borderRadius: 5, background: c, border: styleNow.color === c ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer", padding: 0 }}
                      />
                    ))}
                  </div>
                </>
              )}
              {picked && selection.length > 1 && (
                <button
                  className="btn" style={{ ...PANEL_BTN, marginTop: 9, width: "100%", justifyContent: "center" }}
                  onClick={() => recolourSelection(styleNow.color)}
                >Colour all {selection.length}</button>
              )}
            </PanelSection>
          )}

          {showShapeControls && (
            <PanelSection title="Line">
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}>
                {STROKE_WIDTHS.map((wpx) => (
                  <button
                    key={wpx} onClick={() => applyStyle({ width: wpx })} title={`${wpx}px line`}
                    style={{ flex: 1, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: styleNow.width === wpx ? "var(--gold-soft)" : "var(--panel-raised)", border: `1px solid ${styleNow.width === wpx ? "var(--gold)" : "var(--hair)"}`, borderRadius: 5, cursor: "pointer" }}
                  >
                    <span style={{ width: 16, height: Math.min(wpx, 8), borderRadius: 4, background: styleNow.width === wpx ? "var(--gold)" : "var(--text)", display: "block" }} />
                  </button>
                ))}
              </div>
              {(FILLABLE.includes(tool) || tool === "note" || (pickedShape && FILLABLE.includes(pickedShape.tool))) && (
                <>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 6 }}>Fill</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                    <button
                      onClick={() => applyStyle({ fill: "none" })} title="No fill — outline only"
                      style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--panel-raised)", border: styleNow.fill === "none" ? "2px solid var(--text)" : "1px solid var(--hair)", cursor: "pointer", color: "var(--muted)", fontSize: 12, lineHeight: 1, padding: 0 }}
                    >⌀</button>
                    {IDEA_COLORS.map((c) => (
                      <button
                        key={c} onClick={() => applyStyle({ fill: c })} title="Fill colour"
                        style={{ width: 22, height: 22, borderRadius: "50%", background: c, border: styleNow.fill === c ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer", padding: 0 }}
                      />
                    ))}
                    <input
                      type="color" value={styleNow.fill === "none" ? "#000000" : styleNow.fill}
                      onChange={(e) => applyStyle({ fill: e.target.value })} title="Any other fill colour"
                      style={{ width: 26, height: 24, padding: 0, border: "1px solid var(--hair)", borderRadius: 5, background: "none", cursor: "pointer" }}
                    />
                  </div>
                </>
              )}
              <div style={{ fontSize: 10, color: "var(--muted)", margin: "10px 0 4px" }}>Opacity · {Math.round(styleNow.opacity * 100)}%</div>
              <input
                type="range" min="10" max="100" step="5" value={Math.round(styleNow.opacity * 100)}
                onChange={(e) => applyStyle({ opacity: Number(e.target.value) / 100 })}
                style={{ width: "100%", accentColor: "var(--gold)" }}
              />
            </PanelSection>
          )}

          {showTextControls && (
            <PanelSection title="Text">
              <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
                <select
                  value={textNow.font || "sans"} onChange={(e) => applyText({ font: e.target.value })}
                  style={{ flex: 1, minWidth: 0, background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 5, color: "var(--text)", fontSize: 11, padding: "5px 6px", outline: "none" }}
                >
                  {BOARD_FONTS.map((fnt) => <option key={fnt.id} value={fnt.id}>{fnt.label}</option>)}
                </select>
                <select
                  value={textNow.fontSize || TEXT_DEFAULTS.fontSize} onChange={(e) => applyText({ fontSize: Number(e.target.value) })}
                  title="Text size"
                  style={{ width: 72, background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 5, color: "var(--text)", fontSize: 11, padding: "5px 6px", outline: "none" }}
                >
                  {TEXT_SIZES.map((sz) => <option key={sz} value={sz}>{sz}px</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 5 }}>
                {[
                  { key: "bold", Icon: Bold, title: "Bold", on: !!textNow.bold },
                  { key: "italic", Icon: Italic, title: "Italic", on: !!textNow.italic },
                ].map(({ key, Icon, title, on }) => (
                  <button
                    key={key} title={title} onClick={() => applyText({ [key]: !on })}
                    style={{ flex: 1, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: on ? "var(--gold-soft)" : "var(--panel-raised)", border: `1px solid ${on ? "var(--gold)" : "var(--hair)"}`, color: on ? "var(--gold)" : "var(--text)", borderRadius: 5, cursor: "pointer", padding: 0 }}
                  ><Icon size={12} /></button>
                ))}
                {[
                  { val: "left", Icon: AlignLeft }, { val: "center", Icon: AlignCenter }, { val: "right", Icon: AlignRight },
                ].map(({ val, Icon }) => {
                  const on = (textNow.align || "left") === val;
                  return (
                    <button
                      key={val} title={`Align ${val}`} onClick={() => applyText({ align: val })}
                      style={{ flex: 1, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: on ? "var(--gold-soft)" : "var(--panel-raised)", border: `1px solid ${on ? "var(--gold)" : "var(--hair)"}`, color: on ? "var(--gold)" : "var(--text)", borderRadius: 5, cursor: "pointer", padding: 0 }}
                    ><Icon size={12} /></button>
                  );
                })}
              </div>
            </PanelSection>
          )}

          {picked && selection.length > 1 && (
            <PanelSection title="Line up">
              <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                {[["left", AlignLeft], ["hcentre", AlignCenter], ["right", AlignRight]].map(([edge, Icon]) => (
                  <button key={edge} className="btn" style={{ ...PANEL_BTN, flex: 1, justifyContent: "center" }} onClick={() => alignSelection(edge)} title={`Align ${edge}`}><Icon size={12} /></button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                {[["top", "Top"], ["vcentre", "Middle"], ["bottom", "Bottom"]].map(([edge, label]) => (
                  <button key={edge} className="btn" style={{ ...PANEL_BTN, flex: 1, justifyContent: "center" }} onClick={() => alignSelection(edge)}>{label}</button>
                ))}
              </div>
              {selection.length > 2 && (
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="btn" style={{ ...PANEL_BTN, flex: 1, justifyContent: "center" }} onClick={() => distributeSelection("x")}>Even across</button>
                  <button className="btn" style={{ ...PANEL_BTN, flex: 1, justifyContent: "center" }} onClick={() => distributeSelection("y")}>Even down</button>
                </div>
              )}
            </PanelSection>
          )}

          {picked && (
            <PanelSection title="Place">
              {selection.length === 1 && (
                <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
                  {[["x", "X"], ["y", "Y"]].map(([field, label]) => (
                    <label key={field} style={{ flex: 1, fontSize: 10, color: "var(--muted)" }}>
                      {label}
                      <input
                        type="number" value={Math.round(boundsOf(pickedElement())[field])}
                        onChange={(e) => setExact(field, e.target.value)}
                        style={{ width: "100%", boxSizing: "border-box", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 5, color: "var(--text)", fontSize: 11, padding: "4px 6px", outline: "none", marginTop: 2 }}
                      />
                    </label>
                  ))}
                  {selected.kind === "item" && (
                    <label style={{ flex: 1, fontSize: 10, color: "var(--muted)" }}>
                      W
                      <input
                        type="number" value={Math.round(pickedElement().w || 220)}
                        onChange={(e) => setExact("w", e.target.value)}
                        style={{ width: "100%", boxSizing: "border-box", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 5, color: "var(--text)", fontSize: 11, padding: "4px 6px", outline: "none", marginTop: 2 }}
                      />
                    </label>
                  )}
                </div>
              )}
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                <button className="btn" style={PANEL_BTN} onClick={() => setOnSelection({ spin: (((pickedElement() || {}).spin || 0) + 15) % 360 })} title="Turn 15°"><RotateCw size={11} /> Turn</button>
                <button className="btn" style={PANEL_BTN} onClick={() => setOnSelection({ spin: 0 })}>Straighten</button>
                <button
                  className="btn"
                  style={{ ...PANEL_BTN, ...(pickedElement().locked ? { borderColor: "var(--gold)", color: "var(--gold)" } : {}) }}
                  onClick={() => setOnSelection({ locked: !pickedElement().locked })}
                  title="A locked thing can't be dragged by accident"
                ><Lock size={11} /> {pickedElement().locked ? "Locked" : "Lock"}</button>
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 7, lineHeight: 1.4 }}>Arrow keys nudge · Shift for ten at a time</div>
            </PanelSection>
          )}

          {picked && selection.length === 1 && selected.kind === "item" && (
            <PanelSection title="Effects">
              <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 5 }}>Against what's behind</div>
              <select
                value={pickedElement().blend || "normal"} onChange={(e) => setOnSelection({ blend: e.target.value })}
                style={{ width: "100%", boxSizing: "border-box", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 5, color: "var(--text)", fontSize: 11, padding: "5px 6px", outline: "none", marginBottom: 9 }}
              >
                {BLEND_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 5 }}>Shadow</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 9 }}>
                {SHADOWS.map((sh) => {
                  const on = (pickedElement().shadow || "none") === sh.id;
                  return <button key={sh.id} className="btn" style={{ ...PANEL_BTN, ...(on ? { borderColor: "var(--gold)", color: "var(--gold)" } : {}) }} onClick={() => setOnSelection({ shadow: sh.id })}>{sh.label}</button>;
                })}
              </div>
              {pickedElement().type === "image" && (
                <>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 5 }}>Cut to a shape</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {MASK_SHAPES.map((m) => {
                      const on = (pickedElement().mask || "none") === m.id;
                      return <button key={m.id} className="btn" style={{ ...PANEL_BTN, ...(on ? { borderColor: "var(--gold)", color: "var(--gold)" } : {}) }} onClick={() => setOnSelection({ mask: m.id })}>{m.label}</button>;
                    })}
                  </div>
                </>
              )}
            </PanelSection>
          )}

          <PanelSection title="Board surface">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {BOARD_SURFACES.map((sf) => {
                const on = surface.id === sf.id;
                return (
                  <button
                    key={sf.id} className="btn"
                    style={{ ...PANEL_BTN, ...(on ? { borderColor: "var(--gold)", color: "var(--gold)" } : {}) }}
                    onClick={() => setSurface(sf.id)}
                  >{sf.label}</button>
                );
              })}
            </div>
          </PanelSection>

          {drawings.length > 0 && (
            <PanelSection title="Board">
              <button className="btn" style={{ ...PANEL_BTN, width: "100%", justifyContent: "center" }} onClick={clearDrawings}>
                Clear the drawing on this board
              </button>
            </PanelSection>
          )}
        </div>
      </div>

      {cropping && (
        <CropModal item={cropping} onCancel={() => setCropping(null)} onSave={saveCrop} />
      )}

      {presenting !== null && (
        // Sits over everything and drives the board underneath rather than
        // rendering a second copy of it — so what's on screen is the real
        // board, still live, still updating if someone edits during the talk.
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 4000, display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: "12px 16px", background: "linear-gradient(transparent, rgba(0,0,0,0.75) 40%)", pointerEvents: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--panel)", border: "1px solid var(--hair)", borderRadius: 999, padding: "7px 10px", pointerEvents: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
            <button className="btn" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => goSlide(-1)} disabled={presenting === 0}><ChevronLeft size={14} /></button>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", minWidth: 150, textAlign: "center" }}>
              {slides[presenting] ? slides[presenting].name : ""} <span style={{ color: "var(--muted)", fontWeight: 400 }}>· {presenting + 1}/{slides.length}</span>
            </span>
            <button className="btn" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => goSlide(1)} disabled={presenting >= slides.length - 1}><ChevronRight size={14} /></button>
            <button className="btn" style={{ padding: "5px 10px", fontSize: 12 }} onClick={zoomToFit} title="Fit the board"><Maximize2 size={13} /></button>
            <button className="btn" style={{ padding: "5px 10px", fontSize: 12 }} onClick={stopPresenting}>Done</button>
          </div>
        </div>
      )}

      {history !== null && (
        <Modal title="Board history" onClose={() => setHistory(null)}>
          {history === "loading" && <div className="empty">Looking…</div>}
          {history === "missing" && (
            <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
              History isn't switched on yet. Run <strong style={{ color: "var(--text)" }}>supabase-history-schema.sql</strong> in
              Supabase (Project → SQL Editor → New query → paste → Run), the same way as the original setup. Snapshots start
              building up from then on.
            </div>
          )}
          {Array.isArray(history) && (
            <>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12, lineHeight: 1.5 }}>
                A copy of the board is kept every twenty minutes or so while people are working, and the newest {HISTORY_KEEP} are
                held. Restoring goes through the same merge as any other change, so it won't stamp over what someone else is doing
                right now — and Undo takes the restore itself back.
              </div>
              <button className="btn" style={{ marginBottom: 12 }} onClick={saveVersionNow} disabled={historyBusy}>
                {historyBusy ? "Saving…" : "Save a version now"}
              </button>
              {history.length === 0 && <div className="empty">Nothing kept yet — the first one lands the next time someone edits.</div>}
              {history.map((row) => {
                const snap = row.snapshot || {};
                return (
                  <div key={row.id} style={{ borderTop: "1px solid var(--hair)", padding: "10px 0" }}>
                    <div style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 600 }}>
                      {new Date(row.taken_at).toLocaleString()}
                      {row.taken_by && <span style={{ color: "var(--muted)", fontWeight: 400 }}> · {row.taken_by}</span>}
                      {row.note && <span style={{ color: "var(--gold)", fontWeight: 400 }}> · {row.note}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)", margin: "3px 0 7px" }}>
                      {(snap.ideas || []).length} ideas · {(snap.boardItems || []).length} on the board ·{" "}
                      {(snap.ideaDrawings || []).length} drawn · {(snap.tasks || []).length} duties · {(snap.messages || []).length} messages
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button className="btn" style={PANEL_BTN} onClick={() => restoreFrom(row, true)}>Restore the Idea Bank</button>
                      <button className="btn" style={{ ...PANEL_BTN, borderColor: "var(--alert)", color: "var(--alert)" }} onClick={() => restoreFrom(row, false)}>Restore everything</button>
                    </div>
                  </div>
                );
              })}
            </>
          )}
          <div className="modal-actions"><button className="btn" onClick={() => setHistory(null)}>Close</button></div>
        </Modal>
      )}

      {showStickers && (
        <Modal title="Stickers" onClose={() => setShowStickers(false)}>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12, lineHeight: 1.5 }}>
            Drops onto {currentFolder ? `"${currentFolder.name}"` : "the board"}, then drag it where you want it. Resize it
            like any text — the size control makes it bigger.
          </div>
          {STICKER_GROUPS.map((g) => (
            <div key={g.label} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", fontWeight: 600, marginBottom: 7 }}>{g.label}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {g.items.map((e) => (
                  <button
                    key={e} onClick={() => addSticker(e)} title={`Add ${e}`}
                    style={{ width: 40, height: 40, fontSize: 21, lineHeight: 1, background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 8, cursor: "pointer" }}
                  >{e}</button>
                ))}
              </div>
            </div>
          ))}
          <div className="modal-actions"><button className="btn" onClick={() => setShowStickers(false)}>Close</button></div>
        </Modal>
      )}

      {showTemplates && (
        <Modal title="Start from a template" onClose={() => setShowTemplates(false)}>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
            Adds a starting layout to {currentFolder ? `"${currentFolder.name}"` : "this board"} — it only ever adds, so
            nothing already here is touched, and Undo takes the whole thing back in one go.
          </div>
          {(data.savedTemplates || []).length > 0 && (
            <>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", fontWeight: 700, marginBottom: 7 }}>Yours</div>
              {(data.savedTemplates || []).map((t) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
                  <button
                    onClick={() => applyTemplate({ build: () => ({ items: t.items || [], shapes: t.shapes || [] }) })}
                    style={{ flex: 1, textAlign: "left", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 9, padding: "11px 13px", cursor: "pointer" }}
                  >
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>{t.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                      {(t.items || []).length} things · {(t.shapes || []).length} drawn · saved by {t.by}
                    </div>
                  </button>
                  <button className="btn" style={{ padding: "5px 9px", fontSize: 11 }} onClick={() => forgetTemplate(t.id)}>Forget</button>
                </div>
              ))}
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", fontWeight: 700, margin: "14px 0 7px" }}>Ready-made</div>
            </>
          )}
          {BOARD_TEMPLATES.map((t) => (
            <button
              key={t.id} onClick={() => applyTemplate(t)}
              style={{ display: "block", width: "100%", textAlign: "left", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 9, padding: "11px 13px", marginBottom: 9, cursor: "pointer" }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>{t.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.45 }}>{t.blurb}</div>
            </button>
          ))}
          <div className="modal-actions">
            <button className="btn" onClick={saveAsTemplate} disabled={boardItems.length === 0 && drawings.length === 0}>
              Save this board as a template
            </button>
            <button className="btn" onClick={() => setShowTemplates(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {findText !== null && (
        <Modal title="Find on the boards" onClose={() => setFindText(null)}>
          <input
            autoFocus value={findText} onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setFindText(null); }}
            placeholder="Type at least two letters…"
            style={{ width: "100%", boxSizing: "border-box", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 6, color: "var(--text)", fontSize: 13, padding: "9px 11px", outline: "none", marginBottom: 12 }}
          />
          {findText.trim().length < 2 ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Searches idea cards, text and notes, pictures by name, comments and folder names — across every folder, not just this board.</div>
          ) : findHits().length === 0 ? (
            <div className="empty">Nothing matches that.</div>
          ) : (
            findHits().map((hit) => (
              <button
                key={hit.kind + hit.id} onClick={() => goToHit(hit)}
                style={{ display: "block", width: "100%", textAlign: "left", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 8, padding: "9px 11px", marginBottom: 7, cursor: "pointer" }}
              >
                <div style={{ fontSize: 12.5, color: "var(--text)", marginBottom: 2 }}>{hit.label}</div>
                <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  {hit.kind === "idea" ? "Idea" : hit.kind === "pin" ? "Comment" : hit.kind === "folder" ? "Folder" : "On the board"} · in {hit.where}
                </div>
              </button>
            ))
          )}
          <div className="modal-actions"><button className="btn" onClick={() => setFindText(null)}>Close</button></div>
        </Modal>
      )}

      {showFolderForm && (
        <Modal title="New folder" onClose={() => setShowFolderForm(false)}>
          <div className="field"><label>Name</label><input value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="e.g. Reels concepts" autoFocus /></div>
          <div className="modal-actions"><button className="btn" onClick={() => setShowFolderForm(false)}>Cancel</button><button className="btn btn-gold" onClick={addFolder}>Create folder</button></div>
        </Modal>
      )}

      {showForm && (
        <Modal title="Add an idea" onClose={cancelAddIdea}>
          <div className="field"><label>Idea</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Myth-busting series" autoFocus /></div>
          <div className="field"><label>Description</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What's the concept?" /></div>

          <div className="field">
            <label>Pictures & videos</label>
            {pendingIdeaAttachments.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                {pendingIdeaAttachments.map((a) => (
                  <div key={a.fileId} style={{ position: "relative" }}>
                    <img src={driveThumbSrc(a.fileId)} onError={hideBrokenThumb} alt={a.name} style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 6, background: "var(--panel-raised)", display: "block" }} />
                    {a.kind !== "image" && (
                      <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                        <span style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <Play size={13} fill="#fff" color="#fff" />
                        </span>
                      </span>
                    )}
                    <button
                      onClick={() => { deleteDriveFile(a.fileId); setPendingIdeaAttachments((list) => list.filter((x) => x.fileId !== a.fileId)); }}
                      style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "var(--alert)", color: "#fff", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="btn"
              style={{ padding: "6px 10px", fontSize: 12 }}
              onClick={() => ideaFileInputRef.current && ideaFileInputRef.current.click()}
              disabled={ideaAttaching}
            >
              <Upload size={12} /> {ideaAttaching ? `Uploading… ${ideaAttachProgress}%` : "Attach a picture or video"}
            </button>
            {ideaAttachError && <div style={{ fontSize: 11.5, color: "var(--alert)", marginTop: 6 }}>{ideaAttachError}</div>}
          </div>

          <div className="field"><label>Video or reference link (optional)</label><input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="Paste a YouTube, Drive, or inspiration link" /></div>
          <div className="field-row">
            <div className="field"><label>Tags (comma separated)</label><input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="Reels, Series" /></div>
            <div className="field"><label>Your name</label><input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} placeholder="e.g. Alex" /></div>
          </div>
          <div className="field">
            <label>Colour</label>
            <div style={{ display: "flex", gap: 8 }}>
              {IDEA_COLORS.map((c) => (
                <button key={c} onClick={() => setForm({ ...form, color: c })} style={{ width: 26, height: 26, borderRadius: "50%", background: c, border: form.color === c ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer" }} />
              ))}
            </div>
          </div>
          <div className="modal-actions"><button className="btn" onClick={cancelAddIdea}>Cancel</button><button className="btn btn-gold" onClick={addIdea} disabled={ideaAttaching}>Add idea</button></div>
        </Modal>
      )}

      {openIdea && (
        <Modal title={openIdea.title} onClose={() => setOpenIdeaId(null)}>
          {openIdea.description && <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5, marginBottom: 14 }}>{openIdea.description}</div>}
          {(openYt || openDrive) && (
            <div style={{ position: "relative", paddingTop: "56.25%", borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
              <iframe src={openYt ? `https://www.youtube.com/embed/${openYt}` : openDrive} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }} allowFullScreen title={openIdea.title} />
            </div>
          )}
          {openIdea.link && !openYt && !openDrive && (
            <a href={openIdea.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--gold)", display: "inline-flex", alignItems: "center", gap: 5, textDecoration: "none", marginBottom: 14 }}><Link2 size={12} /> View reference</a>
          )}
          {openIdea.tags && openIdea.tags.length > 0 && (
            <div className="content-tags" style={{ marginBottom: 14 }}>
              {openIdea.tags.map((t) => <span className="pill" key={t} style={{ background: "var(--teal-soft)", color: "var(--teal)" }}>{t}</span>)}
            </div>
          )}

          <div className="field">
            <label>Pictures & videos</label>
            {openIdea.attachments && openIdea.attachments.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                {openIdea.attachments.map((a) => (
                  <div key={a.fileId} style={{ position: "relative" }}>
                    <button onClick={() => setLightbox(a)} title={`Open ${a.name}`} style={{ padding: 0, border: "none", background: "none", cursor: "zoom-in", lineHeight: 0 }}>
                      {a.kind === "image" ? (
                        <img src={driveThumbSrc(a.fileId)} onError={hideBrokenThumb} alt={a.name} style={{ width: 92, height: 92, objectFit: "cover", borderRadius: 6, background: "var(--panel-raised)", display: "block" }} />
                      ) : (
                        <div style={{ position: "relative", width: 92, height: 92, borderRadius: 6, overflow: "hidden", background: "var(--panel-raised)" }}>
                          <img src={driveThumbSrc(a.fileId)} onError={hideBrokenThumb} alt={a.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                          <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <span style={{ width: 30, height: 30, borderRadius: "50%", background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <Play size={14} fill="#fff" color="#fff" />
                            </span>
                          </span>
                        </div>
                      )}
                    </button>
                    <button
                      onClick={() => removeIdeaAttachment(openIdea.id, a.fileId)}
                      style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "var(--alert)", color: "#fff", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="btn"
              style={{ padding: "6px 10px", fontSize: 12 }}
              onClick={() => ideaFileInputRef.current && ideaFileInputRef.current.click()}
              disabled={ideaAttaching}
            >
              <Upload size={12} /> {ideaAttaching ? `Uploading… ${ideaAttachProgress}%` : "Attach a picture or video"}
            </button>
            {ideaAttachError && <div style={{ fontSize: 11.5, color: "var(--alert)", marginTop: 6 }}>{ideaAttachError}</div>}
          </div>

          <div className="field-row">
            <div className="field">
              <label>Folder</label>
              <select value={openIdea.folderId || ""} onChange={(e) => moveToFolder(openIdea.id, e.target.value || null)}>
                <option value="">On the board</option>
                {folders.map((f) => <option value={f.id} key={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Colour</label>
              <div style={{ display: "flex", gap: 6, paddingTop: 4 }}>
                {IDEA_COLORS.map((c) => (
                  <button key={c} onClick={() => setIdeaColor(openIdea.id, c)} style={{ width: 22, height: 22, borderRadius: "50%", background: c, border: openIdea.color === c ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer" }} />
                ))}
              </div>
            </div>
          </div>

          <div className="modal-actions" style={{ justifyContent: "space-between" }}>
            <button className="btn" style={{ borderColor: "var(--alert)", color: "var(--alert)" }} onClick={() => removeIdea(openIdea.id)}><Trash2 size={13} /> Delete</button>
            <div style={{ display: "flex", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--muted)", alignSelf: "center" }}>{openIdea.author || "Anonymous"}</span>
              <button
                className="vote-btn"
                onClick={() => vote(openIdea.id)}
                title={voteList(openIdea).filter((v) => !v.legacy).map((v) => v.id).join(", ") || "No votes yet"}
                style={hasVoted(openIdea, profile) ? { borderColor: "var(--gold)", background: "var(--gold-soft)" } : undefined}
              >
                <ThumbsUp size={13} /> {voteCount(openIdea)}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* One picker serves both attaching to an open idea and attaching while writing a new one. */}
      <input ref={ideaFileInputRef} type="file" accept="video/*,image/*" onChange={handleIdeaFileSelect} disabled={ideaAttaching} style={{ display: "none" }} />

      {lightbox && <MediaLightbox fileId={lightbox.fileId} kind={lightbox.kind} name={lightbox.name} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/* ---------------------------------- Crop ---------------------------------- */

// Cropping here never touches the file in Drive. It records which part of the
// picture to show, as fractions of the whole, so the original is still there
// underneath — the crop can be changed or cleared later, other copies of the
// same picture keep their own framing, and nothing has to be re-uploaded.
// One look for every button in the panel, so a column of them reads as a set
// rather than as things that happened to end up next to each other.
const PANEL_BTN = { padding: "5px 9px", fontSize: 11, display: "inline-flex", alignItems: "center", gap: 5 };

function PanelSection({ title, children }) {
  return (
    <div style={{ borderTop: "1px solid var(--hair)", padding: "11px 12px" }}>
      <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--muted)", fontWeight: 700, marginBottom: 9 }}>{title}</div>
      {children}
    </div>
  );
}

function CropModal({ item, onCancel, onSave }) {
  const [box, setBox] = useState(item.crop || { x: 0, y: 0, w: 1, h: 1 });
  const [aspect, setAspect] = useState(item.imgAspect || null);
  const frameRef = useRef(null);

  // Drag anywhere on the picture to draw the new frame.
  const startDrag = (e) => {
    e.preventDefault();
    const rect = frameRef.current.getBoundingClientRect();
    const at = (ev) => {
      const pt = ev.touches ? ev.touches[0] : ev;
      return {
        x: Math.min(1, Math.max(0, (pt.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (pt.clientY - rect.top) / rect.height)),
      };
    };
    const origin = at(e);
    const move = (ev) => {
      ev.preventDefault();
      const now = at(ev);
      setBox({
        x: Math.min(origin.x, now.x), y: Math.min(origin.y, now.y),
        w: Math.abs(now.x - origin.x), h: Math.abs(now.y - origin.y),
      });
    };
    const end = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      // A tap rather than a drag shouldn't leave a crop of nothing.
      setBox((b) => (b.w < 0.04 || b.h < 0.04 ? { x: 0, y: 0, w: 1, h: 1 } : b));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
  };

  // Presets crop from the centre outwards, to the largest box that fits.
  const toRatio = (r) => {
    if (!aspect) return;
    let w = 1, h = 1;
    if (aspect > r) w = r / aspect; else h = aspect / r;
    setBox({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  };

  const pct = (n) => `${n * 100}%`;

  return (
    <Modal title="Crop picture" onClose={onCancel}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12, lineHeight: 1.5 }}>
        Drag across the picture to choose what to keep. The file in Drive isn't changed — this only
        records the framing, so you can widen it again or clear it at any point.
      </div>
      <div
        ref={frameRef}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
        style={{ position: "relative", width: "100%", background: "#000", borderRadius: 8, overflow: "hidden", cursor: "crosshair", touchAction: "none", userSelect: "none" }}
      >
        <img
          src={driveThumbSrc(item.fileId, "s1600")} alt={item.name || ""} draggable={false}
          onLoad={(e) => { if (!aspect && e.target.naturalHeight) setAspect(e.target.naturalWidth / e.target.naturalHeight); }}
          style={{ width: "100%", display: "block", opacity: 0.4 }}
        />
        {/* The kept part shown at full strength, the rest dimmed behind it. */}
        <div style={{ position: "absolute", left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h), overflow: "hidden", outline: "2px solid var(--gold)", boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)", pointerEvents: "none" }}>
          <img
            src={driveThumbSrc(item.fileId, "s1600")} alt="" draggable={false}
            style={{ position: "absolute", width: pct(1 / (box.w || 1)), left: pct(-box.x / (box.w || 1)), top: pct(-box.y / (box.h || 1)), height: "auto", maxWidth: "none" }}
          />
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        {[{ l: "Square", r: 1 }, { l: "4:5", r: 4 / 5 }, { l: "16:9", r: 16 / 9 }, { l: "9:16", r: 9 / 16 }].map((o) => (
          <button key={o.l} className="btn" style={{ padding: "5px 10px", fontSize: 11.5 }} onClick={() => toRatio(o.r)} disabled={!aspect}>{o.l}</button>
        ))}
        <button className="btn" style={{ padding: "5px 10px", fontSize: 11.5 }} onClick={() => setBox({ x: 0, y: 0, w: 1, h: 1 })}>Whole picture</button>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn btn-gold" onClick={() => onSave(box.w >= 0.999 && box.h >= 0.999 ? null : box, aspect)}>Save crop</button>
      </div>
    </Modal>
  );
}

/* ---------------------------------- Meeting (agenda + announcements) ---------------------------------- */

function Meeting({ data, saveData, profile }) {
  const [agendaText, setAgendaText] = useState("");
  const [announceText, setAnnounceText] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState([]); // [{ fileId, name, kind }]
  const [attaching, setAttaching] = useState(false);
  const [attachProgress, setAttachProgress] = useState(0);
  const [attachRetry, setAttachRetry] = useState("");
  const [attachError, setAttachError] = useState("");
  const agendaFileInputRef = useRef(null);
  const [lightbox, setLightbox] = useState(null); // attachment being viewed full-screen

  const meetingItems = data.meetingItems || [];
  const announcements = data.announcements || [];

  const handleAgendaFileSelect = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setAttaching(true);
    setAttachProgress(0);
    setAttachRetry("");
    setAttachError("");
    try {
      const result = await uploadToDrive(file, setAttachProgress, profile, (attempt, max) => setAttachRetry(`Connection hiccup — retrying (${attempt}/${max})…`));
      const fileId = driveFileId(result.link);
      setPendingAttachments((list) => [...list, { fileId, name: result.name, kind: file.type.startsWith("image/") ? "image" : "video" }]);
    } catch (err) {
      setAttachError(err.message || "Attach failed.");
    }
    setAttaching(false);
    setAttachRetry("");
    e.target.value = "";
  };
  const removePendingAttachment = (fileId) => {
    deleteDriveFile(fileId); // it was never posted, so don't leave it in Drive
    setPendingAttachments((list) => list.filter((a) => a.fileId !== fileId));
  };

  const addAgendaItem = () => {
    if (!agendaText.trim()) return;
    saveData({ ...data, meetingItems: [{ id: uid(), text: agendaText.trim(), author: profile || "Team", date: todayISO(), done: false, attachments: pendingAttachments }, ...meetingItems] });
    setAgendaText("");
    setPendingAttachments([]);
  };
  // Deleting a topic (one-off, or the whole "clear discussed" sweep at the end
  // of a meeting) also deletes whatever it had attached, so Drive doesn't fill
  // up with meeting screenshots and clips nobody needs after the fact.
  const deleteAttachments = (items) => {
    items.forEach((m) => (m.attachments || []).forEach((a) => {
      if (a.fileId) fetch("/api/drive-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId: a.fileId }) }).catch(() => {});
    }));
  };
  const toggleAgendaDone = (id) => saveData({ ...data, meetingItems: meetingItems.map((m) => (m.id === id ? { ...m, done: !m.done } : m)) });
  const removeAgendaItem = (id) => {
    const item = meetingItems.find((m) => m.id === id);
    if (item) deleteAttachments([item]);
    saveData({ ...data, meetingItems: meetingItems.filter((m) => m.id !== id) });
  };
  const clearDiscussed = () => {
    deleteAttachments(meetingItems.filter((m) => m.done));
    saveData({ ...data, meetingItems: meetingItems.filter((m) => !m.done) });
  };

  const addAnnouncement = () => {
    if (!announceText.trim()) return;
    const notifications = [...(data.notifications || []), makeNotification({ toProfile: null, type: "announcement", text: `${profile || "Team"} posted an announcement`, link: "dashboard", fromProfile: profile })];
    saveData({ ...data, announcements: [...announcements, { id: uid(), text: announceText.trim(), author: profile || "Team", date: todayISO() }], notifications });
    sendPush(null, "New announcement", announceText.trim().slice(0, 100), profile);
    setAnnounceText("");
  };
  const removeAnnouncement = (id) => saveData({ ...data, announcements: announcements.filter((a) => a.id !== id) });

  const sortedAgenda = [...meetingItems].sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Meeting</div><div className="page-sub">Collect what to bring up next time, and post team-wide announcements.</div></div>
      </div>

      <div className="grid two-col">
        <div className="card">
          <div className="section-title"><ListChecks size={16} color="var(--gold)" /> Agenda for next meeting</div>
          <div className="comment-form" style={{ marginBottom: 10 }}>
            <textarea
              placeholder="Something to bring up next meeting… (Enter for a new line, Ctrl+Enter to post)"
              value={agendaText}
              onChange={(e) => setAgendaText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addAgendaItem(); } }}
              style={{ minHeight: 70 }}
            />
            <button className="btn btn-gold" style={{ alignSelf: "flex-end" }} onClick={addAgendaItem}><Plus size={14} /></button>
          </div>
          <div style={{ marginBottom: 16 }}>
            {pendingAttachments.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                {pendingAttachments.map((a) => (
                  <div key={a.fileId} style={{ position: "relative", width: 84 }}>
                    {a.kind === "image" ? (
                      <img src={driveThumbSrc(a.fileId)} onError={hideBrokenThumb} alt={a.name} style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 6, background: "var(--panel-raised)", display: "block" }} />
                    ) : (
                      <video src={driveMediaSrc(a.fileId)} poster={driveThumbSrc(a.fileId)} controls preload="none" style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 6, background: "#000", display: "block" }} />
                    )}
                    <button
                      onClick={() => removePendingAttachment(a.fileId)}
                      style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "var(--alert)", color: "#fff", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                    >
                      <X size={11} />
                    </button>
                    <div style={{ fontSize: 9.5, color: "var(--muted)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="btn"
              style={{ padding: "6px 10px", fontSize: 12, cursor: attaching ? "default" : "pointer", opacity: attaching ? 0.7 : 1 }}
              onClick={() => agendaFileInputRef.current && agendaFileInputRef.current.click()}
              disabled={attaching}
            >
              <Upload size={12} /> {attaching ? (attachRetry || `Uploading… ${attachProgress}%`) : "Attach a photo or video"}
            </button>
            <input ref={agendaFileInputRef} type="file" accept="video/*,image/*" onChange={handleAgendaFileSelect} disabled={attaching} style={{ display: "none" }} />
            {attachError && <div style={{ fontSize: 11.5, color: "var(--alert)", marginTop: 6 }}>{attachError}</div>}
          </div>
          {sortedAgenda.map((m) => (
            <div key={m.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--hair)" }}>
              <button className={`check-btn ${m.done ? "done" : ""}`} style={{ marginTop: 2 }} onClick={() => toggleAgendaDone(m.id)}><CheckCircle2 size={12} /></button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap", textDecoration: m.done ? "line-through" : "none", opacity: m.done ? 0.55 : 1 }}>{m.text}</div>
                {m.attachments && m.attachments.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {m.attachments.map((a) => (
                      <button
                        key={a.fileId}
                        onClick={() => setLightbox(a)}
                        title={`Open ${a.name}`}
                        style={{ position: "relative", padding: 0, border: "none", background: "none", cursor: "zoom-in", lineHeight: 0 }}
                      >
                        {a.kind === "image" ? (
                          <img src={driveThumbSrc(a.fileId)} onError={hideBrokenThumb} alt={a.name} style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 6, background: "var(--panel-raised)", display: "block" }} />
                        ) : (
                          <div style={{ position: "relative", width: 120, height: 120, borderRadius: 6, overflow: "hidden", background: "var(--panel-raised)" }}>
                            <img src={driveThumbSrc(a.fileId)} onError={hideBrokenThumb} alt={a.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <span style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <Play size={16} fill="#fff" color="#fff" />
                              </span>
                            </span>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{m.author}</span>
              <button className="icon-btn" onClick={() => removeAgendaItem(m.id)}><Trash2 size={13} /></button>
            </div>
          ))}
          {sortedAgenda.length === 0 && <div className="empty">Nothing on the agenda yet.</div>}
          {meetingItems.some((m) => m.done) && (
            <button className="btn" style={{ marginTop: 14 }} onClick={clearDiscussed}>Clear discussed items</button>
          )}
        </div>

        <div className="card">
          <div className="section-title"><Radio size={16} color="var(--gold)" /> Announcements</div>
          <div className="comment-form" style={{ marginBottom: 16 }}>
            <textarea placeholder="Post something the whole team should see…" value={announceText} onChange={(e) => setAnnounceText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addAnnouncement(); } }} />
            <button className="btn btn-gold" style={{ alignSelf: "flex-end" }} onClick={addAnnouncement}><Plus size={14} /></button>
          </div>
          {[...announcements].reverse().map((a) => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--hair)" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13 }}>{a.text}</div>
                <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>{a.author} · {fmtDate(a.date)}</div>
              </div>
              <button className="icon-btn" onClick={() => removeAnnouncement(a.id)}><Trash2 size={13} /></button>
            </div>
          ))}
          {announcements.length === 0 && <div className="empty">No announcements yet — post one for the team to see on the Dashboard.</div>}
        </div>
      </div>

      {lightbox && <MediaLightbox fileId={lightbox.fileId} kind={lightbox.kind} name={lightbox.name} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/* ---------------------------------- Chat ---------------------------------- */

function Chat({ data, saveData, profile }) {
  const [thread, setThread] = useState("team"); // "team" | a profile name
  const [text, setText] = useState("");
  const scrollRef = useRef(null);

  const others = (data.profiles || []).filter((p) => p.name !== profile);
  const messages = data.messages || [];
  const visible = thread === "team"
    ? messages.filter((m) => m.to === null)
    : messages.filter((m) => (m.from === profile && m.to === thread) || (m.from === thread && m.to === profile));

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visible.length, thread]);

  const initials = (name) => (name || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  const send = () => {
    if (!text.trim() || !profile) return;
    const msg = { id: uid(), from: profile, to: thread === "team" ? null : thread, text: text.trim(), date: todayISO(), time: new Date().toTimeString().slice(0, 5) };
    let notifications = data.notifications || [];
    if (thread === "team") {
      notifications = [...notifications, makeNotification({ toProfile: null, type: "message", text: `${profile} in Team Chat: ${text.trim().slice(0, 60)}`, link: "chat", fromProfile: profile })];
      saveData({ ...data, messages: [...messages, msg], notifications });
      sendPush(null, `${profile} in Team Chat`, text.trim().slice(0, 100), profile);
    } else {
      notifications = [...notifications, makeNotification({ toProfile: thread, type: "message", text: `${profile} sent you a message`, link: "chat", fromProfile: profile })];
      saveData({ ...data, messages: [...messages, msg], notifications });
      sendPush(thread, `Message from ${profile}`, text.trim().slice(0, 100));
    }
    setText("");
  };

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Chat</div><div className="page-sub">Team chat, or message someone directly.</div></div>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="card" style={{ width: 200, flexShrink: 0, padding: 12 }}>
          <button className={`nav-item ${thread === "team" ? "active" : ""}`} onClick={() => setThread("team")}><Users size={16} /> Team Chat</button>
          {others.map((p) => (
            <button key={p.id} className={`nav-item ${thread === p.name ? "active" : ""}`} onClick={() => setThread(p.name)}>
              <span style={{ width: 20, height: 20, borderRadius: "50%", background: `var(--${p.color}-soft)`, color: `var(--${p.color})`, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{initials(p.name)}</span>
              {p.name}
            </button>
          ))}
          {others.length === 0 && <div className="empty" style={{ padding: "10px 4px", fontSize: 11 }}>No one else has signed in yet.</div>}
        </div>

        <div className="card" style={{ flex: 1, minWidth: 260, display: "flex", flexDirection: "column" }}>
          <div ref={scrollRef} style={{ maxHeight: 420, minHeight: 200, overflowY: "auto", paddingRight: 4 }}>
            {visible.map((m) => (
              <div key={m.id} style={{ marginBottom: 12, textAlign: m.from === profile ? "right" : "left" }}>
                {thread === "team" && m.from !== profile && <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 3 }}>{m.from}</div>}
                <div style={{ display: "inline-block", background: m.from === profile ? "var(--gold)" : "var(--panel-raised)", color: m.from === profile ? "#171812" : "var(--text)", padding: "8px 12px", borderRadius: 10, fontSize: 13, maxWidth: "75%", textAlign: "left", whiteSpace: "pre-wrap", wordBreak: "break-word" }}><Linkify text={m.text} /></div>
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>{m.time}</div>
              </div>
            ))}
            {visible.length === 0 && <div className="empty">{thread === "team" ? "No messages yet — say hi to the team." : `No messages with ${thread} yet.`}</div>}
          </div>
          <div className="comment-form" style={{ marginTop: 14 }}>
            <textarea
              value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={thread === "team" ? "Message the team…" : `Message ${thread}…`}
            />
            <button className="btn btn-gold" style={{ alignSelf: "flex-end" }} onClick={send}><Send size={14} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Approved queue (admin) ---------------------------------- */

function ApprovedQueue({ data, saveData, profile }) {
  const [open, setOpen] = useState(null);
  const [loadedVideo, setLoadedVideo] = useState(null);

  const order = data.approvedOrder || [];
  const approved = data.content.filter((c) => c.status === "approved");
  // Anything not yet in the saved order goes to the end, newest last.
  const ordered = [
    ...order.map((id) => approved.find((c) => c.id === id)).filter(Boolean),
    ...approved.filter((c) => !order.includes(c.id)),
  ];

  const move = (id, dir) => {
    const ids = ordered.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    saveData({ ...data, approvedOrder: ids });
  };

  const markPosted = (id) => publishContentItem(data, saveData, id);

  // A quick look at when these pieces are already scheduled to go out, pulled
  // from the same calendar events "Add to Calendar" creates.
  const scheduled = (data.calendarEvents || [])
    .filter((e) => e.notes === "Scheduled from Content Review" && approved.some((c) => c.title === e.title))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8);

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Approved Content</div><div className="page-sub">Everything cleared and ready to post — reorder it into the lineup you want.</div></div>
      </div>

      <div className="content-list" style={{ marginBottom: 28 }}>
        {ordered.map((c, i) => {
          const fmt = CONTENT_FORMATS.find((f) => f.id === c.format) || CONTENT_FORMATS[0];
          const FmtIcon = fmt.icon;
          const yt = youtubeId(c.link);
          const driveId = !yt ? driveFileId(c.link) : null;
          const isOpen = open === c.id;
          return (
            <div className="content-item" key={c.id}>
              <div className="content-head" onClick={() => setOpen(isOpen ? null : c.id)}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }} onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" disabled={i === 0} onClick={() => move(c.id, -1)} style={{ opacity: i === 0 ? 0.3 : 1 }}><ChevronLeft size={13} style={{ transform: "rotate(90deg)" }} /></button>
                  <button className="icon-btn" disabled={i === ordered.length - 1} onClick={() => move(c.id, 1)} style={{ opacity: i === ordered.length - 1 ? 0.3 : 1 }}><ChevronLeft size={13} style={{ transform: "rotate(-90deg)" }} /></button>
                </div>
                <div className="content-thumb" style={{ color: fmt.color }}><FmtIcon size={19} /></div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div className="content-title">#{i + 1} — {c.title}</div>
                  <div className="content-tags">
                    <span className="pill" style={{ background: fmt.color + "22", color: fmt.color }}>{fmt.label}</span>
                    <span className="pill" style={{ background: "var(--panel-raised)", color: "var(--muted)" }}>{c.platform}</span>
                    {c.uploadedBy && <span className="pill" style={{ background: "var(--panel-raised)", color: "var(--muted)" }}>{c.uploadedBy}</span>}
                  </div>
                </div>
                <button className="btn btn-gold" style={{ padding: "9px 12px" }} onClick={(e) => { e.stopPropagation(); markPosted(c.id); }}><CheckCircle2 size={13} /> Mark posted</button>
              </div>

              {isOpen && (
                <div className="content-body">
                  {c.caption && <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 12, lineHeight: 1.5 }}>{c.caption}</div>}
                  {driveId && isPhotoItem(c) ? (
                    <img src={driveThumbSrc(driveId, "s1600")} onError={hideBrokenThumb} alt={c.title} style={{ width: "100%", maxHeight: "60vh", objectFit: "contain", borderRadius: 8, background: "#000", display: "block" }} />
                  ) : (yt || driveId) && (
                    <div style={{ position: "relative", paddingTop: "56.25%", marginBottom: 4, borderRadius: 8, overflow: "hidden", background: "var(--panel-raised)" }}>
                      {loadedVideo === c.id ? (
                        <>
                          {yt && <iframe src={`https://www.youtube.com/embed/${yt}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }} allowFullScreen title={c.title} />}
                          {!yt && driveId && <video src={driveMediaSrc(driveId)} controls autoPlay playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "#000" }} />}
                        </>
                      ) : (
                        <button onClick={() => setLoadedVideo(c.id)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <span style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--gold)", color: "#12141B", display: "flex", alignItems: "center", justifyContent: "center" }}><Play size={18} fill="#12141B" /></span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {ordered.length === 0 && <div className="empty">Nothing approved yet — clear something in Content Review first.</div>}
      </div>

      {scheduled.length > 0 && (
        <div>
          <div className="section-title" style={{ fontSize: 13 }}><CalendarDays size={14} color="var(--gold)" /> Coming up on the posting calendar</div>
          {scheduled.map((e) => (
            <div key={e.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 2px", borderBottom: "1px solid var(--hair)", fontSize: 12.5 }}>
              <span>{e.title}</span>
              <span style={{ color: "var(--muted)" }}>{fmtDate(e.date)}{e.time ? ` · ${e.time}` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Guidelines / resources ---------------------------------- */

const MOOD_TYPES = [
  { id: "image", label: "Picture", icon: Image },
  { id: "color", label: "Colour", icon: Palette },
  { id: "font", label: "Font", icon: TypeIcon },
  { id: "note", label: "Thought", icon: StickyNote },
];

function Guidelines({ data, saveData, profile }) {
  const [tab, setTab] = useState("moodboard"); // "moodboard" | "docs"

  // ---- docs & assets (the original simple resource list) ----
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", link: "", category: "Guidelines" });

  const addResource = () => {
    if (!form.title.trim()) return;
    saveData({ ...data, resources: [{ id: uid(), ...form }, ...data.resources] });
    setForm({ title: "", description: "", link: "", category: "Guidelines" });
    setShowForm(false);
  };
  const removeResource = (id) => saveData({ ...data, resources: data.resources.filter((r) => r.id !== id) });

  const categories = [...new Set(data.resources.map((r) => r.category || "Other"))];

  // ---- moodboard ----
  const moodboard = data.moodboard || [];
  const [showMoodForm, setShowMoodForm] = useState(false);
  const [moodType, setMoodType] = useState("image");
  const [moodForm, setMoodForm] = useState({ label: "", hex: "#C9A24B", font: "", note: "", link: "" });
  const [moodUploading, setMoodUploading] = useState(false);
  const [moodUploadProgress, setMoodUploadProgress] = useState(0);
  const [moodUploadError, setMoodUploadError] = useState("");
  const [moodUploadRetry, setMoodUploadRetry] = useState("");
  const moodFileInputRef = useRef(null);

  // Loads a font's real face from Google Fonts so its card previews accurately —
  // falls back silently to the browser's default if the name isn't a real family.
  useEffect(() => {
    const fonts = moodboard.filter((m) => m.type === "font" && m.font);
    fonts.forEach((m) => {
      const linkId = `gf-${m.font.replace(/[^a-z0-9]/gi, "-")}`;
      if (document.getElementById(linkId)) return;
      const link = document.createElement("link");
      link.id = linkId;
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(m.font).replace(/%20/g, "+")}:wght@400;600;700&display=swap`;
      document.head.appendChild(link);
    });
  }, [moodboard]);

  const handleMoodFileSelect = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setMoodUploading(true);
    setMoodUploadProgress(0);
    setMoodUploadError("");
    setMoodUploadRetry("");
    try {
      const result = await uploadToDrive(file, setMoodUploadProgress, profile, (attempt, max) => setMoodUploadRetry(`Connection hiccup — retrying (${attempt}/${max})…`));
      addMoodItem({ type: "image", fileId: driveFileId(result.link), label: moodForm.label });
      setShowMoodForm(false);
      setMoodForm({ label: "", hex: "#C9A24B", font: "", note: "", link: "" });
    } catch (err) {
      setMoodUploadError(err.message || "Upload failed.");
    }
    setMoodUploading(false);
    setMoodUploadRetry("");
    e.target.value = "";
  };

  const addMoodItem = (fields) => {
    saveData({ ...data, moodboard: [{ id: uid(), addedBy: profile || "", date: todayISO(), ...fields }, ...moodboard] });
  };
  const removeMoodItem = (id) => {
    const item = moodboard.find((m) => m.id === id);
    if (item && item.fileId) deleteDriveFile(item.fileId);
    saveData({ ...data, moodboard: moodboard.filter((m) => m.id !== id) });
  };

  const submitMoodForm = () => {
    if (moodType === "color") {
      addMoodItem({ type: "color", hex: moodForm.hex, label: moodForm.label });
    } else if (moodType === "font") {
      if (!moodForm.font.trim()) return;
      addMoodItem({ type: "font", font: moodForm.font.trim(), label: moodForm.label });
    } else if (moodType === "note") {
      if (!moodForm.note.trim()) return;
      addMoodItem({ type: "note", note: moodForm.note.trim(), label: moodForm.label });
    }
    setShowMoodForm(false);
    setMoodForm({ label: "", hex: "#C9A24B", font: "", note: "", link: "" });
  };

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Guidelines & Resources</div><div className="page-sub">The look, the voice, and everything the team needs to stay on-brand.</div></div>
        {tab === "moodboard" ? (
          <button className="btn btn-gold" onClick={() => { setMoodType("image"); setShowMoodForm(true); }}><Plus size={15} /> Add to moodboard</button>
        ) : (
          <button className="btn btn-gold" onClick={() => setShowForm(true)}><Plus size={15} /> Add resource</button>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button className="btn" style={{ background: tab === "moodboard" ? "var(--gold-soft)" : undefined, borderColor: tab === "moodboard" ? "var(--gold)" : undefined, color: tab === "moodboard" ? "var(--gold)" : undefined }} onClick={() => setTab("moodboard")}>
          <Palette size={13} /> Moodboard
        </button>
        <button className="btn" style={{ background: tab === "docs" ? "var(--gold-soft)" : undefined, borderColor: tab === "docs" ? "var(--gold)" : undefined, color: tab === "docs" ? "var(--gold)" : undefined }} onClick={() => setTab("docs")}>
          <BookOpen size={13} /> Docs & Assets
        </button>
      </div>

      {tab === "moodboard" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
            {moodboard.map((m) => (
              <div key={m.id} className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                {m.type === "image" && m.fileId && (
                  <img src={driveThumbSrc(m.fileId, "s600")} onError={hideBrokenThumb} alt={m.label || "Moodboard image"} style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block", background: "var(--panel-raised)" }} />
                )}
                {m.type === "color" && (
                  <div style={{ width: "100%", aspectRatio: "1 / 1", background: m.hex }} />
                )}
                {m.type === "font" && (
                  <div style={{ padding: "18px 14px 10px", minHeight: 90, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                    <div style={{ fontFamily: `"${m.font}", sans-serif`, fontSize: 30, lineHeight: 1.1, color: "var(--text)" }}>Aa Bb Cc</div>
                  </div>
                )}
                {m.type === "note" && (
                  <div style={{ padding: "16px 14px 10px", minHeight: 90 }}>
                    <div style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.5, fontStyle: "italic" }}>&ldquo;{m.note}&rdquo;</div>
                  </div>
                )}
                <div style={{ padding: "9px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, borderTop: "1px solid var(--hair)" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {m.label || (m.type === "color" ? m.hex : m.type === "font" ? m.font : m.type === "note" ? "Thought" : "Picture")}
                    </div>
                    {m.type === "color" && <div style={{ fontSize: 10, color: "var(--muted)" }} className="mono">{m.hex}</div>}
                  </div>
                  <button className="icon-btn" onClick={() => removeMoodItem(m.id)}><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
          </div>
          {moodboard.length === 0 && <div className="empty">Nothing on the moodboard yet — add a photo, a brand colour, a font, or a quick thought.</div>}
        </div>
      )}

      {tab === "docs" && (
        <div>
          {categories.map((cat) => (
            <div key={cat} style={{ marginBottom: 26 }}>
              <div className="section-title"><BookOpen size={16} color="var(--gold)" /> {cat}</div>
              <div className="grid res-grid">
                {data.resources.filter((r) => (r.category || "Other") === cat).map((r) => (
                  <div className="card res-card" key={r.id}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.title}</div>
                      <button className="icon-btn" onClick={() => removeResource(r.id)}><Trash2 size={13} /></button>
                    </div>
                    {r.description && <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>{r.description}</div>}
                    {r.link && <a href={r.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--gold)", display: "inline-flex", alignItems: "center", gap: 5, textDecoration: "none" }}><Link2 size={12} /> Open resource</a>}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {data.resources.length === 0 && <div className="empty">No resources yet — add the first guideline or asset.</div>}
        </div>
      )}

      {showForm && (
        <Modal title="Add a resource" onClose={() => setShowForm(false)}>
          <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Caption Style Guide" autoFocus /></div>
          <div className="field"><label>Description</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What is this and when should the team use it?" /></div>
          <div className="field-row">
            <div className="field"><label>Link (optional)</label><input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://…" /></div>
            <div className="field"><label>Category</label><input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Guidelines, Assets…" /></div>
          </div>
          <div className="modal-actions"><button className="btn" onClick={() => setShowForm(false)}>Cancel</button><button className="btn btn-gold" onClick={addResource}>Add resource</button></div>
        </Modal>
      )}

      {showMoodForm && (
        <Modal title="Add to moodboard" onClose={() => setShowMoodForm(false)}>
          <div className="field">
            <label>Type</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {MOOD_TYPES.map((t) => {
                const TIcon = t.icon;
                return (
                  <button key={t.id} className="btn" style={{ flex: 1, minWidth: 80, justifyContent: "center", background: moodType === t.id ? "var(--gold-soft)" : undefined, borderColor: moodType === t.id ? "var(--gold)" : undefined, color: moodType === t.id ? "var(--gold)" : undefined }} onClick={() => setMoodType(t.id)}>
                    <TIcon size={13} /> {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {moodType === "image" && (
            <div className="field">
              <label>Picture</label>
              <input value={moodForm.label} onChange={(e) => setMoodForm({ ...moodForm, label: e.target.value })} placeholder="Caption (optional)" style={{ marginBottom: 8 }} />
              <button
                type="button"
                className="btn"
                style={{ width: "100%", justifyContent: "center", cursor: moodUploading ? "default" : "pointer", opacity: moodUploading ? 0.7 : 1 }}
                onClick={() => moodFileInputRef.current && moodFileInputRef.current.click()}
                disabled={moodUploading}
              >
                <Upload size={14} /> {moodUploading ? (moodUploadRetry || `Uploading… ${moodUploadProgress}%`) : "Choose a photo"}
              </button>
              <input ref={moodFileInputRef} type="file" accept="image/*" onChange={handleMoodFileSelect} disabled={moodUploading} style={{ display: "none" }} />
              {moodUploading && (
                <div className="progress-track" style={{ marginTop: 8 }}>
                  <div className="progress-fill" style={{ width: `${moodUploadProgress}%`, background: "var(--gold)" }} />
                </div>
              )}
              {moodUploadError && <div style={{ fontSize: 11.5, color: "var(--alert)", marginTop: 6 }}>{moodUploadError}</div>}
            </div>
          )}

          {moodType === "color" && (
            <>
              <div className="field-row">
                <div className="field">
                  <label>Colour</label>
                  <input type="color" value={moodForm.hex} onChange={(e) => setMoodForm({ ...moodForm, hex: e.target.value })} style={{ height: 40, padding: 4 }} />
                </div>
                <div className="field">
                  <label>Hex</label>
                  <input value={moodForm.hex} onChange={(e) => setMoodForm({ ...moodForm, hex: e.target.value })} placeholder="#C9A24B" />
                </div>
              </div>
              <div className="field"><label>Label (optional)</label><input value={moodForm.label} onChange={(e) => setMoodForm({ ...moodForm, label: e.target.value })} placeholder="e.g. Brand gold" /></div>
              <div className="modal-actions"><button className="btn" onClick={() => setShowMoodForm(false)}>Cancel</button><button className="btn btn-gold" onClick={submitMoodForm}>Add to moodboard</button></div>
            </>
          )}

          {moodType === "font" && (
            <>
              <div className="field"><label>Font name</label><input value={moodForm.font} onChange={(e) => setMoodForm({ ...moodForm, font: e.target.value })} placeholder="e.g. Fraunces, Poppins, Inter…" autoFocus /></div>
              <div className="field"><label>Label (optional)</label><input value={moodForm.label} onChange={(e) => setMoodForm({ ...moodForm, label: e.target.value })} placeholder="e.g. Headline font" /></div>
              {moodForm.font.trim() && <div style={{ fontFamily: `"${moodForm.font.trim()}", sans-serif`, fontSize: 26, marginBottom: 14 }}>Aa Bb Cc</div>}
              <div className="modal-actions"><button className="btn" onClick={() => setShowMoodForm(false)}>Cancel</button><button className="btn btn-gold" onClick={submitMoodForm}>Add to moodboard</button></div>
            </>
          )}

          {moodType === "note" && (
            <>
              <div className="field"><label>Thought</label><textarea value={moodForm.note} onChange={(e) => setMoodForm({ ...moodForm, note: e.target.value })} placeholder="A direction, a reference, a feeling to chase…" autoFocus /></div>
              <div className="field"><label>Label (optional)</label><input value={moodForm.label} onChange={(e) => setMoodForm({ ...moodForm, label: e.target.value })} placeholder="e.g. Tone of voice" /></div>
              <div className="modal-actions"><button className="btn" onClick={() => setShowMoodForm(false)}>Cancel</button><button className="btn btn-gold" onClick={submitMoodForm}>Add to moodboard</button></div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------- My Duties (personal tracker) ---------------------------------- */

function MyDuties({ data, saveData, profile }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", dueDate: todayISO(), priority: "medium", type: "other", format: "video" });
  const [expanded, setExpanded] = useState({});
  const [openTaskId, setOpenTaskId] = useState(null);

  const mine = data.tasks.filter((t) => t.assignee === profile);
  const done = mine.filter((t) => t.status === "done").length;
  const pct = mine.length ? Math.round((done / mine.length) * 100) : 0;
  const circumference = 2 * Math.PI * 46;

  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return isoOf(d);
  });
  const hitDates = new Set(mine.filter((t) => t.completedAt).map((t) => t.completedAt));
  const allAssignees = [...new Set([...(data.profiles || []).map((p) => p.name), ...data.tasks.map((t) => t.assignee).filter(Boolean)])];

  const addTask = () => {
    if (!form.title.trim() || !profile) return;
    const task = { id: uid(), status: "todo", assignee: profile, steps: defaultContentSteps(form.format), link: "", notes: [], ...form };
    saveData({ ...data, tasks: [task, ...data.tasks] });
    setForm({ title: "", description: "", dueDate: todayISO(), priority: "medium", type: "other", format: "video" });
    setShowForm(false);
  };
  const toggleStep = (taskId, stepId) => {
    saveData({
      ...data,
      tasks: data.tasks.map((t) => (t.id === taskId ? { ...t, steps: (t.steps || []).map((s) => (s.id === stepId ? { ...s, done: !s.done } : s)) } : t)),
    });
  };
  const toggleDone = (t) => {
    const nextStatus = t.status === "done" ? "todo" : "done";
    saveData({
      ...data,
      tasks: data.tasks.map((x) => (x.id === t.id ? { ...x, status: nextStatus, completedAt: nextStatus === "done" ? todayISO() : null } : x)),
    });
  };
  const removeTask = (id) => {
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return;
    saveData({
      ...data,
      tasks: data.tasks.filter((t) => t.id !== id),
      // A duty put on the calendar leaves an event behind pointing at a duty
      // that no longer exists; take it with the duty rather than stranding it.
      calendarEvents: (data.calendarEvents || []).filter((e) => e.taskId !== id),
      deletedTasks: [{ ...task, deletedBy: profile || "Unknown", deletedAt: todayISO() }, ...(data.deletedTasks || [])],
    });
  };

  const sorted = [...mine].sort((a, b) => (a.status === "done") - (b.status === "done") || a.dueDate.localeCompare(b.dueDate));

  if (!profile) {
    return (
      <div>
        <div className="topbar"><div><div className="page-title">My Duties</div><div className="page-sub">Your personal task tracker.</div></div></div>
        <div className="card empty">Set your name in the sidebar first, so this page can find your tasks.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">My Duties</div><div className="page-sub">Just your tasks, your pace, your progress.</div></div>
        <button className="btn btn-gold" onClick={() => setShowForm(true)}><Plus size={15} /> Add my task</button>
      </div>

      <div className="hero" style={{ marginBottom: 22 }}>
        <div className="ring-wrap" style={{ width: 100, height: 100 }}>
          <svg width="100" height="100" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="46" fill="none" stroke="var(--panel-raised)" strokeWidth="9" />
            <circle
              cx="50" cy="50" r="46" fill="none" stroke="var(--good)" strokeWidth="9" strokeLinecap="round"
              strokeDasharray={circumference} strokeDashoffset={circumference - (pct / 100) * circumference}
              transform="rotate(-90 50 50)" style={{ transition: "stroke-dashoffset .5s ease" }}
            />
          </svg>
          <div className="ring-num"><div className="n" style={{ fontSize: 21 }}>{pct}%</div><div className="l">Done</div></div>
        </div>
        <div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>Last 7 days</div>
          <div className="streak-row">
            {last7.map((iso) => {
              const d = new Date(iso + "T00:00:00");
              return (
                <div key={iso} className={`streak-dot ${hitDates.has(iso) ? "hit" : ""}`} title={iso}>
                  {d.toLocaleDateString(undefined, { weekday: "narrow" })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="section-title"><ListChecks size={16} color="var(--gold)" /> {profile}'s tasks</div>
        {sorted.map((t) => {
          const p = PRIORITY.find((x) => x.id === t.priority) || PRIORITY[1];
          const ty = TASK_TYPES.find((x) => x.id === t.type) || TASK_TYPES[TASK_TYPES.length - 1];
          const TyIcon = ty.icon;
          const overdue = t.status !== "done" && daysUntil(t.dueDate) < 0;
          const dueToday = t.status !== "done" && daysUntil(t.dueDate) === 0;
          const rowColor = t.status === "done" ? "var(--good)" : overdue ? "var(--alert)" : dueToday ? "var(--gold)" : "var(--hair)";
          const steps = t.steps || [];
          const stepsDone = steps.filter((s) => s.done).length;
          const nextStep = steps.find((s) => !s.done);
          const isOpen = expanded[t.id];
          return (
            <div className="personal-task-row" key={t.id} style={{ borderLeft: `3px solid ${rowColor}`, paddingLeft: 10, background: t.status === "done" ? "var(--good-soft)" : overdue ? "var(--alert-soft)" : "transparent", borderRadius: 6, alignItems: "flex-start" }}>
              <button className={`check-btn ${t.status === "done" ? "done" : ""}`} style={{ marginTop: 2 }} onClick={() => toggleDone(t)}>
                <CheckCircle2 size={13} />
              </button>
              <span style={{ width: 26, height: 26, borderRadius: 7, background: ty.color + "1f", color: ty.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><TyIcon size={13} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, textDecoration: t.status === "done" ? "line-through" : "none", opacity: t.status === "done" ? 0.6 : 1, cursor: "pointer" }} onClick={() => setOpenTaskId(t.id)}>{ty.verb} — {t.title}</div>
                {t.projectId && (() => {
                  const proj = (data.projects || []).find((p) => p.id === t.projectId);
                  return proj ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9.5, fontWeight: 700, color: "var(--gold)", background: "var(--gold-soft)", padding: "1px 6px", borderRadius: 4, marginTop: 3 }}>
                      <Layers size={9} /> {proj.name}
                    </span>
                  ) : null;
                })()}
                {t.description && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{t.description}</div>}
                {steps.length > 0 && t.status !== "done" && (
                  <div style={{ marginTop: 6 }}>
                    <button
                      onClick={() => setExpanded({ ...expanded, [t.id]: !isOpen })}
                      style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 6, padding: "5px 8px", fontSize: 11, color: "var(--muted)", maxWidth: 320 }}
                    >
                      <span style={{ flexShrink: 0, fontWeight: 700, color: stepsDone === steps.length ? "var(--good)" : "var(--gold)" }}>{stepsDone}/{steps.length}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nextStep ? `Next: ${nextStep.text}` : "All steps done"}</span>
                      <ChevronRight size={11} style={{ flexShrink: 0, transform: isOpen ? "rotate(90deg)" : "none" }} />
                    </button>
                    {isOpen && (
                      <div style={{ marginTop: 6 }}>
                        {steps.map((s) => (
                          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                            <button className={`check-btn ${s.done ? "done" : ""}`} style={{ width: 16, height: 16 }} onClick={() => toggleStep(t.id, s.id)}><CheckCircle2 size={10} /></button>
                            <span style={{ fontSize: 11.5, textDecoration: s.done ? "line-through" : "none", opacity: s.done ? 0.55 : 1 }}>{s.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <span className="pill" style={{ background: p.color + "22", color: p.color }}>{p.label}</span>
              <span className="due-tag" style={{ color: overdue ? "var(--alert)" : "var(--muted)" }}>{overdue ? "Overdue" : fmtDate(t.dueDate)}</span>
              <button className="icon-btn" onClick={() => removeTask(t.id)}><Trash2 size={13} /></button>
            </div>
          );
        })}
        {sorted.length === 0 && <div className="empty">Nothing assigned to you yet — add your own task above.</div>}
      </div>

      {showForm && (
        <Modal title="Add my task" onClose={() => setShowForm(false)}>
          <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Prep tomorrow's caption drafts" autoFocus /></div>
          <div className="field"><label>Details</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional notes" /></div>
          <div className="field-row">
            <div className="field"><label>Action</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TASK_TYPES.map((t) => <option value={t.id} key={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div className="field"><label>Format</label>
              <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
                {CONTENT_FORMATS.map((f) => <option value={f.id} key={f.id}>{f.label}</option>)}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field"><label>Due date</label><input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></div>
            <div className="field"><label>Priority</label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {PRIORITY.map((p) => <option value={p.id} key={p.id}>{p.label}</option>)}
              </select>
            </div>
          </div>
          <div className="modal-actions"><button className="btn" onClick={() => setShowForm(false)}>Cancel</button><button className="btn btn-gold" onClick={addTask}>Add task</button></div>
        </Modal>
      )}

      {openTaskId && (
        <TaskDetailModal
          data={data} saveData={saveData} taskId={openTaskId} onClose={() => setOpenTaskId(null)}
          profile={profile} allAssignees={allAssignees} onDelete={removeTask} onOpenTask={(id) => setOpenTaskId(id)}
        />
      )}
    </div>
  );
}

/* ---------------------------------- Login ---------------------------------- */

const PROFILE_COLORS = ["gold", "teal", "good", "alert"];
const genCode = () => String(Math.floor(1000 + Math.random() * 9000));

function PinPad({ onDigit, onBack }) {
  return (
    <div className="pinpad">
      {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d, i) => (
        d === "" ? <div key={i} /> : (
          <button key={i} className={d === "⌫" ? "ghost" : ""} onClick={() => d === "⌫" ? onBack() : onDigit(d)}>
            {d === "⌫" ? <X size={16} /> : d}
          </button>
        )
      ))}
    </div>
  );
}

function LoginScreen({ data, saveData, onLogin }) {
  const profiles = data.profiles || [];
  const adminCode = data.adminCode || "";

  const [pinTarget, setPinTarget] = useState(null); // profile being pin-checked
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);

  const [mode, setMode] = useState("picker"); // picker | admin-setup | admin-unlock | admin-panel
  const [adminPin, setAdminPin] = useState("");
  const [adminPinError, setAdminPinError] = useState(false);
  const [setupPin, setSetupPin] = useState("");
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState(genCode());
  const [newCodeError, setNewCodeError] = useState("");
  const [copied, setCopied] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null);
  const [editCode, setEditCode] = useState("");
  const [editCodeError, setEditCodeError] = useState("");

  const initials = (name) => (name || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  const tryLogin = (p) => {
    if (p.pin) { setPinTarget(p); setPin(""); setPinError(false); }
    else onLogin(p);
  };
  const pressDigit = (d) => {
    const next = (pin + d).slice(0, 4);
    setPin(next);
    setPinError(false);
    if (next.length >= pinTarget.pin.length) {
      if (next === pinTarget.pin) onLogin(pinTarget);
      else { setPinError(true); setPin(""); }
    }
  };

  const pressSetupDigit = (d) => {
    const next = (setupPin + d).slice(0, 4);
    setSetupPin(next);
    if (next.length >= 4) {
      saveData({ ...data, adminCode: next });
      setMode("admin-panel");
      setSetupPin("");
    }
  };

  const pressAdminDigit = (d) => {
    const next = (adminPin + d).slice(0, 4);
    setAdminPin(next);
    setAdminPinError(false);
    if (next.length >= 4) {
      if (next === adminCode) { setMode("admin-panel"); setAdminPin(""); }
      else { setAdminPinError(true); setAdminPin(""); }
    }
  };

  const openManage = () => {
    setEditingProfile(null);
    setMode(adminCode ? "admin-unlock" : "admin-setup");
    setAdminPin("");
    setAdminPinError(false);
    setSetupPin("");
    setNewName("");
    setNewCode(genCode());
    setNewCodeError("");
  };

  const codeTaken = (code, excludeId) => profiles.some((p) => p.pin === code && p.id !== excludeId);

  const createProfile = () => {
    if (!newName.trim()) return;
    if (!/^\d{4}$/.test(newCode)) { setNewCodeError("Code must be exactly 4 digits."); return; }
    if (codeTaken(newCode)) { setNewCodeError("That code is already assigned to someone else."); return; }
    const np = { id: uid(), name: newName.trim(), pin: newCode, color: PROFILE_COLORS[profiles.length % PROFILE_COLORS.length], isLead: profiles.length === 0 };
    saveData({ ...data, profiles: [...profiles, np] });
    setNewName("");
    setNewCode(genCode());
    setNewCodeError("");
  };
  const removeProfile = (id) => {
    saveData({ ...data, profiles: profiles.filter((p) => p.id !== id) });
    if (editingProfile && editingProfile.id === id) setEditingProfile(null);
  };
  const openEditCode = (p) => {
    setEditingProfile(p);
    setEditCode(p.pin);
    setEditCodeError("");
  };
  const saveEditCode = () => {
    if (!/^\d{4}$/.test(editCode)) { setEditCodeError("Code must be exactly 4 digits."); return; }
    if (codeTaken(editCode, editingProfile.id)) { setEditCodeError("That code is already assigned to someone else."); return; }
    saveData({ ...data, profiles: profiles.map((x) => (x.id === editingProfile.id ? { ...x, pin: editCode } : x)) });
    setEditingProfile(null);
  };
  const copyCode = async (code) => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable — code is still on screen */ }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-eyebrow">Social Ops</div>
        <div className="login-brand-row">
          <span className="brand-dot" />
          <span className="b-name">Broadcast Desk</span>
        </div>
        <div className="login-title">Sign in</div>

        {pinTarget ? (
          <>
            <div className="login-sub">Enter {pinTarget.name}'s code</div>
            <div className="pin-dots">
              {Array.from({ length: pinTarget.pin.length }).map((_, i) => (
                <div key={i} className={`pin-dot ${i < pin.length ? "filled" : ""}`} />
              ))}
            </div>
            {pinError && <div className="pin-error">That code didn't match — try again.</div>}
            <PinPad value={pin} onDigit={pressDigit} onBack={() => setPin(pin.slice(0, -1))} />
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button className="btn" onClick={() => setPinTarget(null)}>Back</button>
            </div>
          </>
        ) : mode === "admin-setup" ? (
          <>
            <div className="login-sub"><Shield size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Set your lead passcode</div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", textAlign: "center", marginBottom: 14, lineHeight: 1.5 }}>
              This is the only door into profile management. Pick 4 digits only you know.
            </div>
            <div className="pin-dots">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`pin-dot ${i < setupPin.length ? "filled" : ""}`} />
              ))}
            </div>
            <PinPad value={setupPin} onDigit={pressSetupDigit} onBack={() => setSetupPin(setupPin.slice(0, -1))} />
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button className="btn" onClick={() => setMode("picker")}>Back</button>
            </div>
          </>
        ) : mode === "admin-unlock" ? (
          <>
            <div className="login-sub"><Lock size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Lead passcode</div>
            <div className="pin-dots">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`pin-dot ${i < adminPin.length ? "filled" : ""}`} />
              ))}
            </div>
            {adminPinError && <div className="pin-error">Wrong passcode.</div>}
            <PinPad value={adminPin} onDigit={pressAdminDigit} onBack={() => setAdminPin(adminPin.slice(0, -1))} />
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button className="btn" onClick={() => setMode("picker")}>Back</button>
            </div>
          </>
        ) : mode === "admin-panel" ? (
          <>
            <div className="login-sub"><Shield size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Manage profiles</div>

            {editingProfile ? (
              <div className="code-reveal">
                <div style={{ fontSize: 13, fontWeight: 600 }}>{editingProfile.name}'s login code</div>
                <input
                  className="code-input"
                  value={editCode}
                  autoFocus
                  onChange={(e) => { setEditCode(e.target.value.replace(/\D/g, "").slice(0, 4)); setEditCodeError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") saveEditCode(); }}
                  placeholder="0000"
                />
                {editCodeError && <div className="pin-error" style={{ marginTop: 8 }}>{editCodeError}</div>}
                <div className="copy-row">
                  <button className="btn" onClick={() => setEditCode(genCode())}><RotateCw size={13} /> Random</button>
                  <button className="btn" onClick={() => copyCode(editCode)}>{copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}</button>
                  <button className="btn btn-gold" onClick={saveEditCode}>Save code</button>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 12 }}>Pick any 4 digits — send them to {editingProfile.name} so they can sign in.</div>
                <button className="btn" style={{ marginTop: 14 }} onClick={() => setEditingProfile(null)}>Cancel</button>
              </div>
            ) : (
              <>
                <div className="admin-list">
                  {profiles.length === 0 && <div className="empty" style={{ padding: "14px 0" }}>No profiles yet — add the first one below.</div>}
                  {profiles.map((p) => (
                    <div className="admin-row" key={p.id}>
                      <div className="profile-avatar-lg" style={{ width: 32, height: 32, fontSize: 11, background: `var(--${p.color}-soft)`, color: `var(--${p.color})` }}>{initials(p.name)}</div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                      <button className="code code-btn" onClick={() => openEditCode(p)}>{p.pin}</button>
                      <button className="icon-btn" title="Change this person's code" onClick={() => openEditCode(p)}><Pencil size={13} /></button>
                      <button className="icon-btn" onClick={() => removeProfile(p.id)}><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
                <div className="field"><label>Add a profile</label></div>
                <div className="field-row" style={{ alignItems: "flex-start" }}>
                  <div className="field" style={{ marginBottom: 0, flex: 2 }}>
                    <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Their name" onKeyDown={(e) => { if (e.key === "Enter") createProfile(); }} />
                  </div>
                  <div className="field" style={{ marginBottom: 0, flex: 1 }}>
                    <input
                      className="mono-input"
                      value={newCode}
                      onChange={(e) => { setNewCode(e.target.value.replace(/\D/g, "").slice(0, 4)); setNewCodeError(""); }}
                      onKeyDown={(e) => { if (e.key === "Enter") createProfile(); }}
                      placeholder="Code"
                    />
                  </div>
                </div>
                {newCodeError && <div className="pin-error" style={{ marginTop: -8, marginBottom: 12, textAlign: "left" }}>{newCodeError}</div>}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <button className="manage-link" style={{ width: "auto", margin: 0, border: "none", padding: "6px 4px" }} onClick={() => setNewCode(genCode())}><RotateCw size={12} /> Random code</button>
                  <button className="btn btn-gold" onClick={createProfile}><Plus size={14} /> Add profile</button>
                </div>
              </>
            )}
            <div style={{ textAlign: "center", marginTop: 18 }}>
              <button className="btn" onClick={() => setMode("picker")}>Back to sign in</button>
            </div>
          </>
        ) : (
          <>
            <div className="login-sub">Who's checking in?</div>
            <div className="profile-grid">
              {profiles.map((p) => (
                <button key={p.id} className="profile-card" onClick={() => tryLogin(p)}>
                  <div className="profile-avatar-lg" style={{ background: `var(--${p.color}-soft)`, color: `var(--${p.color})` }}>{initials(p.name)}</div>
                  <div className="pname">{p.name}</div>
                </button>
              ))}
            </div>
            {profiles.length === 0 && <div className="empty">No profiles yet. As the team lead, tap below to add the first one.</div>}
            <button className="manage-link" onClick={openManage}><Settings size={13} /> Team lead? Manage profiles</button>
            <div className="manage-caption">Adds people and hands out their sign-in codes</div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------- Team (in-app profile management) ---------------------------------- */

const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

// Every Drive file id the app still points at. Anything in the Drive folder
// that isn't in here is a leftover — usually from a cleanup that failed or an
// upload that was interrupted before it was attached to anything.
function referencedFileIds(data) {
  const ids = new Set();
  const add = (linkOrId) => {
    if (!linkOrId) return;
    const id = linkOrId.startsWith("http") ? driveFileId(linkOrId) : linkOrId;
    if (id) ids.add(id);
  };
  (data.content || []).forEach((c) => { add(c.link); (c.versions || []).forEach((v) => add(v.link)); });
  (data.moodboard || []).forEach((m) => add(m.fileId));
  (data.meetingItems || []).forEach((m) => (m.attachments || []).forEach((a) => add(a.fileId)));
  (data.ideas || []).forEach((i) => { add(i.link); (i.attachments || []).forEach((a) => add(a.fileId)); });
  (data.boardItems || []).forEach((b) => add(b.fileId));
  (data.tasks || []).forEach((t) => add(t.link));
  (data.calendarEvents || []).forEach((e) => add(e.link));
  (data.resources || []).forEach((r) => add(r.link));
  return ids;
}

function StoragePanel({ data }) {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cleaning, setCleaning] = useState(false);

  const boardBytes = new Blob([JSON.stringify(data)]).size;

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/drive-usage");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't read Drive usage.");
      setUsage(json);
    } catch (err) {
      setError(err.message || "Couldn't read Drive usage.");
    }
    setLoading(false);
  };

  const referenced = referencedFileIds(data);
  const orphans = usage ? usage.files.filter((f) => !referenced.has(f.id)) : [];
  const orphanBytes = orphans.reduce((s, f) => s + f.size, 0);

  const cleanOrphans = async () => {
    setCleaning(true);
    for (const f of orphans) {
      await fetch("/api/drive-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: f.id }),
      }).catch(() => {});
    }
    setCleaning(false);
    load();
  };

  return (
    <div className="card" style={{ maxWidth: 480, marginTop: 16 }}>
      <div className="section-title"><Layers size={16} color="var(--gold)" /> Storage</div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6, marginBottom: 12 }}>
        The board itself (every task, note, idea and comment) is <strong style={{ color: "var(--text)" }}>{fmtBytes(boardBytes)}</strong> — Supabase's free tier allows 500 MB, so there's a very long way to go before that's a concern.
        Photos and videos live in Drive, not in the database.
      </div>

      {!usage && (
        <button className="btn" onClick={load} disabled={loading}>{loading ? "Checking…" : "Check Drive usage"}</button>
      )}
      {error && <div style={{ fontSize: 11.5, color: "var(--alert)", marginTop: 8 }}>{error}</div>}

      {usage && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "8px 0", borderBottom: "1px solid var(--hair)" }}>
            <span style={{ color: "var(--muted)" }}>Files in the team Drive folder</span>
            <strong>{usage.fileCount}</strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "8px 0", borderBottom: "1px solid var(--hair)" }}>
            <span style={{ color: "var(--muted)" }}>Space used</span>
            <strong>{fmtBytes(usage.totalBytes)}</strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "8px 0" }}>
            <span style={{ color: "var(--muted)" }}>Leftovers nothing points at</span>
            <strong style={{ color: orphans.length ? "var(--alert)" : "var(--good)" }}>{orphans.length}{orphans.length ? ` · ${fmtBytes(orphanBytes)}` : ""}</strong>
          </div>

          {orphans.length > 0 && (
            <button className="btn" style={{ marginTop: 12, borderColor: "var(--alert)", color: "var(--alert)" }} onClick={cleanOrphans} disabled={cleaning}>
              <Trash2 size={13} /> {cleaning ? "Cleaning up…" : `Delete ${orphans.length} leftover file${orphans.length === 1 ? "" : "s"}`}
            </button>
          )}
          <button className="btn" style={{ marginTop: 12, marginLeft: orphans.length > 0 ? 8 : 0 }} onClick={load} disabled={loading}>{loading ? "Checking…" : "Refresh"}</button>
        </>
      )}
    </div>
  );
}

function TeamManage({ data, saveData }) {
  const profiles = data.profiles || [];
  const adminCode = data.adminCode || "";

  const [unlocked, setUnlocked] = useState(false);
  const [mode, setMode] = useState(adminCode ? "unlock" : "setup"); // unlock | setup
  const [enteredPin, setEnteredPin] = useState("");
  const [pinError, setPinError] = useState(false);

  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState(genCode());
  const [newCodeError, setNewCodeError] = useState("");
  const [editingProfile, setEditingProfile] = useState(null);
  const [editCode, setEditCode] = useState("");
  const [editCodeError, setEditCodeError] = useState("");
  const [copied, setCopied] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearPin, setClearPin] = useState("");
  const [clearPinError, setClearPinError] = useState(false);

  const initials = (name) => (name || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const codeTaken = (code, excludeId) => profiles.some((p) => p.pin === code && p.id !== excludeId);

  const pressUnlockDigit = (d) => {
    const next = (enteredPin + d).slice(0, 4);
    setEnteredPin(next);
    setPinError(false);
    if (next.length >= 4) {
      if (next === adminCode) { setUnlocked(true); setEnteredPin(""); }
      else { setPinError(true); setEnteredPin(""); }
    }
  };
  const pressSetupDigit = (d) => {
    const next = (enteredPin + d).slice(0, 4);
    setEnteredPin(next);
    if (next.length >= 4) {
      saveData({ ...data, adminCode: next });
      setUnlocked(true);
      setEnteredPin("");
    }
  };

  const createProfile = () => {
    if (!newName.trim()) return;
    if (!/^\d{4}$/.test(newCode)) { setNewCodeError("Code must be exactly 4 digits."); return; }
    if (codeTaken(newCode)) { setNewCodeError("That code is already assigned to someone else."); return; }
    const np = { id: uid(), name: newName.trim(), pin: newCode, color: PROFILE_COLORS[profiles.length % PROFILE_COLORS.length], isLead: profiles.length === 0 };
    saveData({ ...data, profiles: [...profiles, np] });
    setNewName("");
    setNewCode(genCode());
    setNewCodeError("");
  };
  const removeProfile = (id) => {
    saveData({ ...data, profiles: profiles.filter((p) => p.id !== id) });
    if (editingProfile && editingProfile.id === id) setEditingProfile(null);
  };
  const toggleLead = (id) => {
    saveData({ ...data, profiles: profiles.map((p) => (p.id === id ? { ...p, isLead: !p.isLead } : p)) });
  };
  const openEditCode = (p) => { setEditingProfile(p); setEditCode(p.pin); setEditCodeError(""); };
  const saveEditCode = () => {
    if (!/^\d{4}$/.test(editCode)) { setEditCodeError("Code must be exactly 4 digits."); return; }
    if (codeTaken(editCode, editingProfile.id)) { setEditCodeError("That code is already assigned to someone else."); return; }
    saveData({ ...data, profiles: profiles.map((x) => (x.id === editingProfile.id ? { ...x, pin: editCode } : x)) });
    setEditingProfile(null);
  };
  const copyCode = async (code) => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };
  const clearDemoContent = () => {
    const cleared = {
      ...data,
      tasks: [],
      calendarEvents: [],
      notes: [],
      content: [],
      ideas: [],
      ideaFolders: [],
      ideaDrawings: [],
      boardItems: [],
      resources: [],
      moodboard: [],
      approvedOrder: [],
    };
    // Whatever this wipes would otherwise leave its files sitting in Drive with
    // nothing pointing at them. Compare before and after so anything still
    // referenced elsewhere (meeting attachments, say) is left alone.
    const stillUsed = referencedFileIds(cleared);
    referencedFileIds(data).forEach((id) => { if (!stillUsed.has(id)) deleteDriveFile(id); });
    saveData(cleared);
    setClearConfirm(false);
    setClearPin("");
    setClearPinError(false);
  };
  const pressClearDigit = (d) => {
    const next = (clearPin + d).slice(0, 4);
    setClearPin(next);
    setClearPinError(false);
    if (next.length >= 4) {
      if (next === adminCode) clearDemoContent();
      else { setClearPinError(true); setClearPin(""); }
    }
  };

  const deletedTasks = data.deletedTasks || [];
  const restoreTask = (dt) => {
    const { deletedBy, deletedAt, ...task } = dt;
    saveData({ ...data, tasks: [task, ...data.tasks], deletedTasks: deletedTasks.filter((x) => x.id !== dt.id) });
  };
  const purgeTask = (id) => {
    saveData({ ...data, deletedTasks: deletedTasks.filter((x) => x.id !== id) });
  };
  const purgeAllDeleted = () => {
    saveData({ ...data, deletedTasks: [] });
  };

  if (!unlocked) {
    return (
      <div>
        <div className="topbar">
          <div><div className="page-title">Team</div><div className="page-sub">Who's on the roster, and their sign-in codes.</div></div>
        </div>
        <div className="card" style={{ maxWidth: 380, margin: "0 auto", textAlign: "center", padding: "32px 28px" }}>
          {mode === "setup" && !adminCode ? (
            <>
              <div className="login-sub" style={{ marginBottom: 8 }}><Shield size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Set your lead passcode</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8, lineHeight: 1.5 }}>Pick 4 digits only you know — this unlocks profile management everywhere in the app.</div>
            </>
          ) : (
            <div className="login-sub" style={{ marginBottom: 8 }}><Lock size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Enter lead passcode</div>
          )}
          <div className="pin-dots">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={`pin-dot ${i < enteredPin.length ? "filled" : ""}`} />
            ))}
          </div>
          {pinError && <div className="pin-error">Wrong passcode.</div>}
          <PinPad onDigit={adminCode ? pressUnlockDigit : pressSetupDigit} onBack={() => setEnteredPin(enteredPin.slice(0, -1))} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Team</div><div className="page-sub">Add or remove people — changes show up on the sign-in screen instantly.</div></div>
      </div>

      <div className="card" style={{ maxWidth: 480 }}>
        {editingProfile ? (
          <div className="code-reveal">
            <div style={{ fontSize: 13, fontWeight: 600 }}>{editingProfile.name}'s login code</div>
            <input
              className="code-input"
              value={editCode}
              autoFocus
              onChange={(e) => { setEditCode(e.target.value.replace(/\D/g, "").slice(0, 4)); setEditCodeError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") saveEditCode(); }}
              placeholder="0000"
            />
            {editCodeError && <div className="pin-error" style={{ marginTop: 8 }}>{editCodeError}</div>}
            <div className="copy-row">
              <button className="btn" onClick={() => setEditCode(genCode())}><RotateCw size={13} /> Random</button>
              <button className="btn" onClick={() => copyCode(editCode)}>{copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}</button>
              <button className="btn btn-gold" onClick={saveEditCode}>Save code</button>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 12 }}>Send this to {editingProfile.name} so they can sign in.</div>
            <button className="btn" style={{ marginTop: 14 }} onClick={() => setEditingProfile(null)}>Cancel</button>
          </div>
        ) : (
          <>
            <div className="admin-list">
              {profiles.length === 0 && <div className="empty" style={{ padding: "14px 0" }}>No profiles yet — add the first one below.</div>}
              {profiles.map((p) => (
                <div className="admin-row" key={p.id}>
                  <div className="profile-avatar-lg" style={{ width: 32, height: 32, fontSize: 11, background: `var(--${p.color}-soft)`, color: `var(--${p.color})` }}>{initials(p.name)}</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                  {p.isLead && <span className="pill" style={{ background: "var(--gold-soft)", color: "var(--gold)" }}>Employer</span>}
                  <button className="icon-btn" title={p.isLead ? "Remove employer access" : "Make this person an employer"} onClick={() => toggleLead(p.id)}><Shield size={13} color={p.isLead ? "var(--gold)" : undefined} /></button>
                  <button className="code code-btn" onClick={() => openEditCode(p)}>{p.pin}</button>
                  <button className="icon-btn" title="Change this person's code" onClick={() => openEditCode(p)}><Pencil size={13} /></button>
                  <button className="icon-btn" onClick={() => removeProfile(p.id)}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
            <div className="field"><label>Add a profile</label></div>
            <div className="field-row" style={{ alignItems: "flex-start" }}>
              <div className="field" style={{ marginBottom: 0, flex: 2 }}>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Their name" onKeyDown={(e) => { if (e.key === "Enter") createProfile(); }} />
              </div>
              <div className="field" style={{ marginBottom: 0, flex: 1 }}>
                <input
                  className="mono-input"
                  value={newCode}
                  onChange={(e) => { setNewCode(e.target.value.replace(/\D/g, "").slice(0, 4)); setNewCodeError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") createProfile(); }}
                  placeholder="Code"
                />
              </div>
            </div>
            {newCodeError && <div className="pin-error" style={{ marginTop: -8, marginBottom: 12, textAlign: "left" }}>{newCodeError}</div>}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button className="manage-link" style={{ width: "auto", margin: 0, border: "none", padding: "6px 4px" }} onClick={() => setNewCode(genCode())}><RotateCw size={12} /> Random code</button>
              <button className="btn btn-gold" onClick={createProfile}><Plus size={14} /> Add profile</button>
            </div>
          </>
        )}
      </div>

      {!editingProfile && (
        <div className="card" style={{ maxWidth: 480, marginTop: 16 }}>
          <div className="section-title"><Lightbulb size={16} color="var(--gold)" /> Load starter content</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
            Adds a handful of example duties, calendar posts, notes, and an idea — each clearly labelled "Example" — so the team can see how everything works. Safe to run even with real content already in place; it only adds, never overwrites.
          </div>
          <button className="btn" onClick={() => {
            const ex = buildExamples();
            saveData({
              ...data,
              tasks: [...data.tasks, ...ex.tasks],
              calendarEvents: [...data.calendarEvents, ...ex.calendarEvents],
              notes: [...data.notes, ...ex.notes],
              content: [...data.content, ...ex.content],
              ideas: [...data.ideas, ...ex.ideas],
              resources: [...data.resources, ...ex.resources],
            });
          }}><Plus size={14} /> Load starter content</button>
        </div>
      )}

      {!editingProfile && (
        <div className="card" style={{ maxWidth: 480, marginTop: 16 }}>
          <div className="topbar" style={{ marginBottom: 12 }}>
            <div className="section-title" style={{ marginBottom: 0 }}><Trash2 size={16} color="var(--gold)" /> Deleted duties · {deletedTasks.length}</div>
            {deletedTasks.length > 0 && <button className="btn" onClick={purgeAllDeleted}>Empty all</button>}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
            Anyone's deletions land here first instead of disappearing right away — you can restore a duty or clear it out for good.
          </div>
          {deletedTasks.length === 0 && <div className="empty" style={{ padding: "10px 0" }}>Nothing deleted recently.</div>}
          {deletedTasks.map((dt) => (
            <div key={dt.id} className="admin-row" style={{ marginBottom: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{dt.title}</div>
                <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
                  {dt.assignee ? `${dt.assignee} · ` : ""}deleted by {dt.deletedBy || "someone"} · {fmtDate(dt.deletedAt)}
                </div>
              </div>
              <button className="btn" style={{ padding: "5px 10px", fontSize: 11.5 }} onClick={() => restoreTask(dt)}>Restore</button>
              <button className="icon-btn" title="Delete permanently" onClick={() => purgeTask(dt.id)}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}

      {!editingProfile && <StoragePanel data={data} />}

      {!editingProfile && (
        <div className="card danger-zone" style={{ maxWidth: 480, marginTop: 16 }}>
          <div className="section-title" style={{ color: "var(--alert)" }}><AlertTriangle size={16} color="var(--alert)" /> Clear sample content</div>
          {!clearConfirm ? (
            <>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
                Wipes every task, calendar event, note, content item, idea, and resource — the placeholder content this app started with, or anything added since. Profiles and codes are kept.
              </div>
              <button className="btn" style={{ borderColor: "var(--alert)", color: "var(--alert)" }} onClick={() => { setClearConfirm(true); setClearPin(""); setClearPinError(false); }}>Clear all content</button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: "var(--alert)", marginBottom: 6, fontWeight: 600, textAlign: "center" }}>This can't be undone.</div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4, textAlign: "center" }}>Re-enter the lead passcode to confirm.</div>
              <div className="pin-dots">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className={`pin-dot ${i < clearPin.length ? "filled" : ""}`} />
                ))}
              </div>
              {clearPinError && <div className="pin-error">Wrong passcode.</div>}
              <PinPad onDigit={pressClearDigit} onBack={() => setClearPin(clearPin.slice(0, -1))} />
              <div style={{ textAlign: "center", marginTop: 12 }}>
                <button className="btn" onClick={() => { setClearConfirm(false); setClearPin(""); setClearPinError(false); }}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Notification bell ---------------------------------- */

function NotificationBell({ data, saveData, profile, setView }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const all = data.notifications || [];
  const mine = all.filter((n) => n.toProfile === profile || n.toProfile === null).sort((a, b) => b.id.localeCompare(a.id));
  const unread = mine.filter((n) => !(n.readBy || []).includes(profile));

  const markRead = (id) => {
    saveData({ ...data, notifications: all.map((n) => (n.id === id ? { ...n, readBy: [...new Set([...(n.readBy || []), profile])] } : n)) });
  };
  const markAllRead = () => {
    saveData({ ...data, notifications: all.map((n) => ((n.toProfile === profile || n.toProfile === null) ? { ...n, readBy: [...new Set([...(n.readBy || []), profile])] } : n)) });
  };
  const openNotif = (n) => {
    markRead(n.id);
    if (n.link) setView(n.link);
    setOpen(false);
  };

  // The dropdown used to live inside the sidebar, but the sidebar's slide-in
  // CSS transform turns it into the positioning/clipping boundary for anything
  // absolutely positioned inside it — so the panel was getting trapped there
  // instead of floating over the page. Portal it to <body> and position it from
  // the button's real on-screen location instead.
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 32);
      setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - width - 16), width });
    }
    setOpen((o) => !o);
  };

  const ICONS = { task: ListChecks, note: MessageSquare, announcement: Radio, message: Send, upload: Video, approved: CheckCircle2 };

  return (
    <div>
      <button ref={btnRef} className="btn-ghost btn" style={{ position: "relative", width: "100%", justifyContent: "flex-start", gap: 10 }} onClick={toggle}>
        <Bell size={16} />
        Notifications
        {unread.length > 0 && (
          <span style={{ marginLeft: "auto", background: "var(--alert)", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 6px" }}>{unread.length}</span>
        )}
      </button>
      {open && pos && createPortal(
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setOpen(false)} />
          <div style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, maxHeight: "min(360px, 70vh)", overflowY: "auto", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 10, boxShadow: "0 12px 30px rgba(0,0,0,0.4)", zIndex: 100, padding: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 6px 8px" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Notifications</span>
              {unread.length > 0 && <button onClick={markAllRead} style={{ fontSize: 10.5, color: "var(--gold)", background: "none", border: "none" }}>Mark all read</button>}
            </div>
            {unread.length === 0 && <div className="empty" style={{ padding: "16px 6px" }}>Nothing new.</div>}
            {unread.slice(0, 25).map((n) => {
              const Icon = ICONS[n.type] || Bell;
              return (
                <button key={n.id} onClick={() => openNotif(n)} style={{ display: "flex", gap: 9, width: "100%", textAlign: "left", padding: "8px 6px", borderRadius: 7, background: "var(--gold-soft)", border: "none", marginBottom: 3 }}>
                  <span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--panel)", color: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={13} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.35 }}>{n.text}</div>
                    <div style={{ fontSize: 9.5, color: "var(--muted)", marginTop: 2 }}>{fmtDate(n.date)}</div>
                  </div>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--gold)", flexShrink: 0, marginTop: 5 }} />
                </button>
              );
            })}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

/* ---------------------------------- Push notification opt-in ---------------------------------- */

const VAPID_PUBLIC_KEY = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_VAPID_PUBLIC_KEY) || "";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function saveSubscription(sub, profile) {
  const json = sub.toJSON();
  await supabase.from("push_subscriptions").upsert({
    profile_name: profile,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  }, { onConflict: "endpoint" });
}

function PushEnableButton({ profile }) {
  const [status, setStatus] = useState("checking"); // checking | off | on | unsupported | error
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        if (!cancelled) setStatus("unsupported");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        // A subscription can already exist from a previous tap even if the
        // backend never stored it (e.g. the table didn't exist yet) — make
        // sure it's (re)saved rather than trusting it's already on record.
        if (sub) await saveSubscription(sub, profile).catch(() => {});
        if (!cancelled) setStatus(sub ? "on" : "off");
      } catch {
        if (!cancelled) setStatus("off");
      }
    })();
    return () => { cancelled = true; };
  }, [profile]);

  const enable = async () => {
    if (!VAPID_PUBLIC_KEY) { setStatus("error"); return; }
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setBusy(false); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await saveSubscription(sub, profile);
      setStatus("on");
    } catch {
      setStatus("error");
    }
    setBusy(false);
  };

  if (status === "unsupported") return null; // e.g. iPhone not yet added to home screen
  if (status === "checking") return null;

  return (
    <button
      className="btn-ghost btn"
      style={{ width: "100%", justifyContent: "flex-start", gap: 10, fontSize: 12.5, marginBottom: 4 }}
      onClick={status === "off" || status === "error" ? enable : undefined}
      disabled={busy}
    >
      <Bell size={14} color={status === "on" ? "var(--good)" : undefined} />
      {status === "on" ? "Notifications on" : status === "error" ? "Couldn't enable — try again" : busy ? "Enabling…" : "Enable notifications"}
    </button>
  );
}

/* ---------------------------------- App shell ---------------------------------- */

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "myduties", label: "My Duties", icon: User },
  { id: "duties", label: "Team Duties", icon: ListChecks },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "meeting", label: "Meeting", icon: Radio },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "content", label: "Content Review", icon: Video },
  { id: "approved", label: "Approved", icon: CheckCircle2 },
  { id: "ideas", label: "Idea Bank", icon: Lightbulb },
  { id: "guidelines", label: "Guidelines", icon: BookOpen },
  { id: "analytics", label: "Analytics", icon: AnalyticsIcon },
  { id: "team", label: "Team", icon: Shield },
];

/* ------------------------- shared board plumbing ------------------------- */

// A save is only allowed to land on the exact row version it was written
// against, and `updated_at` is that version token. Postgres keeps microseconds
// but toISOString only writes milliseconds, so the spare digits carry some
// randomness: two people saving inside the same millisecond still get distinct
// tokens, and one of them is told to merge rather than both overwriting.
const nextStamp = (previous) => {
  let ms = Date.now();
  const previousMs = previous ? Date.parse(previous) : NaN;
  // A phone with a slow clock still has to produce a token newer than the one
  // it replaces, or its saves look older than they are and get skipped.
  if (Number.isFinite(previousMs) && ms <= previousMs) ms = previousMs + 1;
  const micros = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return new Date(ms).toISOString().replace("Z", `${micros}Z`);
};

// Long enough to collapse a burst — a drag, a run of votes, a flurry of
// strokes — into one save, short enough that nobody notices the wait.
const SAVE_DEBOUNCE_MS = 180;
// Backstop for anything realtime failed to deliver.
const RESYNC_MS = 45000;

// Every list the board carries. Filling in the missing ones on read means a
// board last saved before a feature existed still lines up, key for key,
// against one saved after it — which is what the merge compares.
const BOARD_LISTS = [
  "profiles", "tasks", "deletedTasks", "projects", "calendarEvents", "notes",
  "content", "ideas", "resources", "messages", "notifications", "moodboard",
  "approvedOrder", "meetingItems", "announcements", "ideaFolders",
  "ideaDrawings", "boardItems", "boardComments",
];

function normalizeBoard(raw) {
  const board = { ...(raw || {}) };
  for (const key of BOARD_LISTS) if (!Array.isArray(board[key])) board[key] = [];
  board.ideas = board.ideas.map(withVoteList);
  if (!Array.isArray(board.boardPalette)) board.boardPalette = [];
  if (!Array.isArray(board.savedTemplates)) board.savedTemplates = [];
  if (!Array.isArray(board.boardLinks)) board.boardLinks = [];
  if (!board.boardSurfaces || typeof board.boardSurfaces !== "object" || Array.isArray(board.boardSurfaces)) board.boardSurfaces = {};
  if (typeof board.adminCode !== "string") board.adminCode = "";
  if (!board.goals || typeof board.goals !== "object" || Array.isArray(board.goals)) board.goals = {};
  if (!board.goals.individualTargets || typeof board.goals.individualTargets !== "object") {
    board.goals = { ...board.goals, individualTargets: {} };
  }
  // Somebody has to be able to open team settings, so if no one is marked as
  // lead the first profile is.
  if (board.profiles.length > 0 && !board.profiles.some((p) => p.isLead)) {
    board.profiles = board.profiles.map((p, i) => (i === 0 ? { ...p, isLead: true } : p));
  }
  return board;
}

export default function TeamHub() {
  const [data, setData] = useState(null);
  const [view, setView] = useState("dashboard");
  const [navOpen, setNavOpen] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [loggedIn, setLoggedIn] = useState(null); // { id, name, color, pin }
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    // Stop the page behind the mobile menu from scrolling/panning while it's open.
    document.body.style.overflow = navOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [navOpen]);

  // --------------------------- shared board sync ---------------------------
  // One Supabase row holds the whole board, and every open screen edits it.
  // These refs are what src/syncState.js needs to merge those edits instead of
  // letting the last save win:
  //   dataRef     the board as it looks here right now, unsaved edits included
  //   baseRef     the server's board as we last saw it
  //   versionRef  that row's updated_at — the token we save against, so a save
  //               built on an out-of-date board is refused by Postgres rather
  //               than quietly wiping out whatever landed in the meantime
  const dataRef = useRef(null);
  const baseRef = useRef(null);
  const versionRef = useRef(null);
  const dirtyRef = useRef(false);
  const writingRef = useRef(false);
  const flushTimerRef = useRef(null);
  const failureRef = useRef(0);
  const lastSnapshotRef = useRef(0);
  // flush() runs from a timer, so it can't read who is signed in from a render.
  const loggedInRef = useRef(null);

  const applyLocal = (next) => { dataRef.current = next; setData(next); };
  loggedInRef.current = loggedIn;

  // Read the live board and fold our unsaved edits into it.
  const reconcile = async () => {
    const { data: row, error } = await supabase
      .from("hub_state").select("data, updated_at").eq("id", "main").maybeSingle();
    if (error || !row || !row.data) return false;
    const theirs = normalizeBoard(row.data);
    const merged = mergeState(baseRef.current, dataRef.current, theirs);
    baseRef.current = theirs;
    versionRef.current = row.updated_at;
    if (!deepEqual(merged, dataRef.current)) applyLocal(merged);
    if (!deepEqual(merged, theirs)) dirtyRef.current = true;
    return true;
  };

  const flush = async () => {
    if (writingRef.current || !dirtyRef.current || !dataRef.current) return;
    writingRef.current = true;
    dirtyRef.current = false;
    const mine = dataRef.current;
    let retryIn = 0;
    try {
      let write = supabase
        .from("hub_state")
        .update({ data: mine, updated_at: nextStamp(versionRef.current) })
        .eq("id", "main");
      // The guard that makes this safe: save only if the row is still the one
      // this edit was built on. If it isn't, nothing is written and no other
      // screen's work is lost — we get told to merge and try again.
      if (versionRef.current) write = write.eq("updated_at", versionRef.current);
      const { data: rows, error } = await write.select("updated_at");
      if (error) throw error;

      if (rows && rows.length === 1) {
        baseRef.current = mine;
        versionRef.current = rows[0].updated_at;
        failureRef.current = 0;
        setSaveError(false);
        // Piggy-backs on a save that already worked, so a snapshot can never be
        // the thing that breaks an edit, and only ever records a board that
        // actually made it to the server.
        if (Date.now() - lastSnapshotRef.current > HISTORY_EVERY_MS) {
          lastSnapshotRef.current = Date.now();
          takeSnapshot(mine, loggedInRef.current && loggedInRef.current.name, null);
        }
      } else {
        // Somebody saved first. That is normal, not a failure: take their
        // board, put our edit back on top, and go again after a little jitter
        // so two screens saving together don't keep colliding.
        await reconcile();
        dirtyRef.current = true;
        retryIn = 30 + Math.floor(Math.random() * 120);
      }
    } catch {
      // Offline, or the database said no. Keep the edit and keep trying; only
      // bother the team about it once it has clearly stopped being a blip.
      dirtyRef.current = true;
      failureRef.current += 1;
      if (failureRef.current > 3) setSaveError(true);
      retryIn = Math.min(8000, failureRef.current * 500);
    } finally {
      writingRef.current = false;
    }

    if (dirtyRef.current) setTimeout(flush, retryIn);
  };

  const scheduleFlush = () => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => { flushTimerRef.current = null; flush(); }, SAVE_DEBOUNCE_MS);
  };
  const flushNow = () => {
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    flush();
  };

  // What every page calls to change the board. The `data` it closes over is
  // the copy this render handed that page — which is the point: a handler that
  // spent ten seconds uploading a photo still knows which board its change was
  // written against, so the change gets laid onto the current board instead of
  // replacing it with a ten-second-old one.
  const saveData = (next) => {
    const latest = dataRef.current;
    applyLocal(!latest || latest === data ? next : mergeState(data, next, latest));
    dirtyRef.current = true;
    scheduleFlush();
  };

  useEffect(() => {
    let cancelled = false;
    let channel = null;

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    const onRemote = (payload) => {
      const row = payload && payload.new;
      if (cancelled || !row) return;
      // Our own save is already on screen; a save still in flight reconciles
      // itself when it lands.
      if (writingRef.current) return;
      if (row.updated_at === versionRef.current) return;
      if (row.updated_at && versionRef.current &&
          Date.parse(row.updated_at) < Date.parse(versionRef.current)) return;
      // Realtime leaves the row out once the board outgrows its payload limit.
      // Skipping those is what left screens sitting on hours-old boards, so
      // treat a missing row as "go and read it".
      if (!row.data) { reconcile().then(() => { if (dirtyRef.current) scheduleFlush(); }); return; }

      const theirs = normalizeBoard(row.data);
      const merged = mergeState(baseRef.current, dataRef.current, theirs);
      baseRef.current = theirs;
      versionRef.current = row.updated_at;
      if (!deepEqual(merged, dataRef.current)) applyLocal(merged);
      if (!deepEqual(merged, theirs)) { dirtyRef.current = true; scheduleFlush(); }
    };

    (async () => {
      const { data: row } = await supabase
        .from("hub_state").select("data, updated_at").eq("id", "main").maybeSingle();

      let board;
      let version;
      if (row && row.data) {
        board = normalizeBoard(row.data);
        version = row.updated_at;
      } else {
        board = normalizeBoard(seedData());
        version = nextStamp(null);
        const { data: seeded } = await supabase
          .from("hub_state")
          .upsert({ id: "main", data: board, updated_at: version })
          .select("updated_at").maybeSingle();
        if (seeded) version = seeded.updated_at;
      }
      if (cancelled) return;

      baseRef.current = board;
      versionRef.current = version;
      applyLocal(board);

      try {
        const savedId = localStorage.getItem("my-profile-id");
        if (savedId) {
          const match = board.profiles.find((p) => p.id === savedId);
          if (match) setLoggedIn(match);
        }
      } catch {
        // stay on login screen
      }
      setAuthReady(true);

      channel = supabase
        .channel("hub_state_live")
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "hub_state", filter: "id=eq.main" },
          onRemote
        )
        .subscribe();
    })();

    // Realtime misses things — a dropped socket, an oversized payload, a phone
    // that was asleep. Checking just the timestamp on a timer and whenever the
    // tab comes back is cheap, and it stops a screen drifting out of date,
    // which is the state a screen has to be in to overwrite anyone.
    const resync = async () => {
      if (cancelled || !dataRef.current || writingRef.current || document.hidden) return;
      const { data: head } = await supabase
        .from("hub_state").select("updated_at").eq("id", "main").maybeSingle();
      if (head && head.updated_at !== versionRef.current) {
        await reconcile();
        if (dirtyRef.current) scheduleFlush();
      }
    };
    // Leaving the tab shouldn't lose an edit still sitting in the debounce.
    const onVisibility = () => { if (document.hidden) flushNow(); else resync(); };

    const timer = setInterval(resync, RESYNC_MS);
    window.addEventListener("focus", resync);
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", resync);
      window.removeEventListener("pagehide", flushNow);
      document.removeEventListener("visibilitychange", onVisibility);
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    // Fires precise reminders while someone has the app open somewhere — a daily
    // digest (api/daily-reminders.js, run by Vercel Cron) is the backup for
    // reminders due when nobody has a tab open at that exact moment.
    const check = () => {
      if (!data || !loggedIn) return;
      const me = loggedIn.name;
      const now = new Date();
      const fired = [];
      for (const e of data.calendarEvents || []) {
        if (!e.remind || e.reminderSent || e.assignee !== me || !e.date) continue;
        const [h, m] = (e.time || "09:00").split(":").map(Number);
        const eventDt = new Date(e.date + "T00:00:00");
        eventDt.setHours(h || 0, m || 0, 0, 0);
        const remindAt = new Date(eventDt.getTime() - (e.reminderMinutesBefore || 30) * 60000);
        if (now >= remindAt && now <= eventDt) {
          sendPush(me, "Reminder", `${e.title} at ${e.time}`);
          fired.push(e.id);
        }
      }
      // Marking these off goes through saveData like any other edit, so a
      // reminder firing on a tab nobody has touched for hours can't roll the
      // whole board back to what that tab remembers.
      if (fired.length > 0) {
        saveData({
          ...data,
          calendarEvents: data.calendarEvents.map((e) => (fired.includes(e.id) ? { ...e, reminderSent: true } : e)),
        });
      }
    };
    check();
    const id = setInterval(check, 60000);
    return () => clearInterval(id);
  }, [data, loggedIn]);

  const handleLogin = (p) => {
    setLoggedIn(p);
    try { localStorage.setItem("my-profile-id", p.id); } catch { /* ignore */ }
  };
  const handleLogout = () => {
    setLoggedIn(null);
    try { localStorage.removeItem("my-profile-id"); } catch { /* ignore */ }
  };

  if (!data || !authReady) {
    return (
      <>
        <style>{CSS}</style>
        <div className="loading-screen">LOADING BRIEFING ROOM…</div>
      </>
    );
  }

  if (!loggedIn) {
    return (
      <>
        <style>{CSS}</style>
        <LoginScreen data={data} saveData={saveData} onLogin={handleLogin} />
      </>
    );
  }

  const profile = loggedIn.name;
  const initials = profile.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const myProfileObj = (data.profiles || []).find((p) => p.name === profile);
  const isEmployer = !!(myProfileObj && myProfileObj.isLead);

  // Unread counts shown on nav items (e.g. "Chat", "My Duties") — reuses the same
  // notification rows the bell uses, filtered to the ones that link to that page.
  const myUnreadNotifications = (data.notifications || []).filter(
    (n) => (n.toProfile === profile || n.toProfile === null) && !(n.readBy || []).includes(profile)
  );
  const navBadgeCount = (navId) => myUnreadNotifications.filter((n) => n.link === navId).length;
  const openNavItem = (navId) => {
    setView(navId);
    setNavOpen(false);
    const idsToMark = myUnreadNotifications.filter((n) => n.link === navId).map((n) => n.id);
    if (idsToMark.length > 0) {
      const idSet = new Set(idsToMark);
      saveData({
        ...data,
        notifications: (data.notifications || []).map((n) =>
          idSet.has(n.id) ? { ...n, readBy: [...new Set([...(n.readBy || []), profile])] } : n
        ),
      });
    }
  };

  const Comp = {
    dashboard: <Dashboard data={data} saveData={saveData} profile={profile} setView={setView} isEmployer={isEmployer} />,
    myduties: <MyDuties data={data} saveData={saveData} profile={profile} />,
    duties: <Duties data={data} saveData={saveData} profile={profile} />,
    calendar: <Calendar data={data} saveData={saveData} profile={profile} />,
    meeting: <Meeting data={data} saveData={saveData} profile={profile} />,
    chat: <Chat data={data} saveData={saveData} profile={profile} />,
    notes: <Notes data={data} saveData={saveData} />,
    content: <ContentReview data={data} saveData={saveData} profile={profile} isEmployer={isEmployer} />,
    approved: <ApprovedQueue data={data} saveData={saveData} profile={profile} />,
    ideas: <IdeaBank data={data} saveData={saveData} profile={profile} />,
    guidelines: <Guidelines data={data} saveData={saveData} profile={profile} />,
    analytics: <Analytics profile={profile} />,
    team: <TeamManage data={data} saveData={saveData} />,
  }[view];

  return (
    <div className="hub">
      <style>{CSS}</style>

      {/* Saves retry on their own, but a save that keeps failing used to do
          so in complete silence — the board simply stopped matching what
          everyone else saw. Say so instead. */}
      {saveError && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 60, background: "var(--alert)", color: "#fff", fontSize: 12, fontWeight: 600, padding: "8px 14px", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.35)", display: "flex", alignItems: "center", gap: 8 }}>
          <AlertTriangle size={14} /> Can't reach the board — still trying. Keep this tab open.
        </div>
      )}

      <button className="menu-toggle btn btn-ghost" style={{ position: "fixed", top: 16, left: 16, zIndex: 20 }} onClick={() => setNavOpen((o) => !o)}>
        <Menu size={18} />
      </button>

      <div className={`sidebar ${navOpen ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-dot" />
          <div>
            <div className="brand-text">Broadcast Desk</div>
            <div className="brand-sub">Social Ops</div>
          </div>
        </div>
        <div className="profile-box">
          <div className="profile-chip">
            <div className="av" style={{ background: `var(--${loggedIn.color})` }}>{initials}</div>
            <div className="info">
              <div className="name">{profile}{isEmployer && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: "var(--gold)", background: "var(--gold-soft)", padding: "2px 6px", borderRadius: 4, verticalAlign: "middle" }}>EMPLOYER</span>}</div>
              <button className="change" onClick={handleLogout}>switch profile</button>
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 8 }}>
          <NotificationBell data={data} saveData={saveData} profile={profile} setView={setView} />
          <PushEnableButton profile={profile} />
        </div>

        {NAV.filter((n) => (n.id !== "team" && n.id !== "approved") || isEmployer).map((n) => {
          const Icon = n.icon;
          const count = navBadgeCount(n.id);
          return (
            <button key={n.id} className={`nav-item ${view === n.id ? "active" : ""}`} onClick={() => openNavItem(n.id)}>
              <Icon size={16} /> {n.label}
              {count > 0 && (
                <span style={{ marginLeft: "auto", background: "var(--alert)", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 6px" }}>{count}</span>
              )}
            </button>
          );
        })}
        <div className="sidebar-foot">
          <div className="live-tag"><span className="dot" /> LIVE</div>
          <div style={{ marginTop: 6 }}>Everything here — board, profiles, and progress — is shared and saved for the whole team, even after updates.</div>
        </div>
      </div>

      <div className="main">{Comp}</div>
    </div>
  );
}
