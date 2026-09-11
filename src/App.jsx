import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabaseClient";
import { mergeState, deepEqual } from "./syncState";
import { useLiveBoard } from "./livePresence";
import {
  LayoutDashboard, ListChecks, CalendarDays, StickyNote, Video, Lightbulb,
  BookOpen, Plus, X, ChevronLeft, ChevronRight, ThumbsUp, MessageSquare,
  Trash2, CheckCircle2, Clock, AlertTriangle, Link2, Menu, Flame,
  Radio, Users, Pin, ExternalLink, Send, User, Pencil, Settings, Copy, Check, Lock, Shield, RotateCw, Bell, Image, Layers, Upload, Play, Globe, Palette, Type as TypeIcon, Folder, FolderOpen
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
function useDraggable(onDragEnd, onClick, onDragMove) {
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
      const dx = p.clientX - startX;
      const dy = p.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) movedRef.current = true;
      const next = { id, x: Math.max(0, origX + dx), y: Math.max(0, origY + dy) };
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
      if (movedRef.current && posRef.current) onDragEnd(posRef.current.id, posRef.current.x, posRef.current.y);
      else if (!movedRef.current && onClick) onClick(id);
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

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

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
  { id: "planned", label: "Planned", color: "var(--muted)" },
  { id: "ready", label: "Ready to post", color: "var(--gold)" },
  { id: "posted", label: "Posted", color: "var(--good)" },
  { id: "skipped", label: "Skipped", color: "var(--alert)" },
];
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
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

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

  useEffect(() => {
    setLocalTitle(task ? task.title : "");
    setLocalDescription(task ? task.description || "" : "");
  }, [taskId]);

  const updateTask = (patch) => {
    saveData({ ...data, tasks: data.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) });
  };
  const debouncedUpdateTask = useDebouncedCallback(updateTask, 500);

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
                    const st = CAL_STATUS.find((s) => s.id === e.status) || CAL_STATUS[0];
                    const top = ((e.startMin - gridStartMin) / 60) * hourHeight;
                    const height = Math.max(((e.endMin - e.startMin) / 60) * hourHeight - 2, minEventHeight.day);
                    const widthPct = 100 / e.totalCols;
                    return (
                      <div
                        key={e.id}
                        onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}
                        style={{ position: "absolute", top, height, left: `${e.col * widthPct}%`, width: `calc(${widthPct}% - 4px)`, background: personColor(e.assignee, data.profiles), color: "#171812", borderRadius: 6, padding: "5px 8px", fontSize: 11.5, fontWeight: 600, overflow: "hidden", cursor: "pointer", zIndex: 2 }}
                      >
                        <span className="evt-dot" style={{ background: st.color, marginRight: 4 }} />
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
                  const st = CAL_STATUS.find((s) => s.id === e.status) || CAL_STATUS[0];
                  return (
                    <div className="cal-evt" key={e.id} title={e.title} style={{ borderLeftColor: personColor(e.assignee, data.profiles), borderLeftWidth: 3 }} onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}>
                      <span className="evt-dot" style={{ background: st.color }} />
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
                    const st = CAL_STATUS.find((s) => s.id === e.status) || CAL_STATUS[0];
                    const top = ((e.startMin - gridStartMin) / 60) * hourHeight;
                    const height = Math.max(((e.endMin - e.startMin) / 60) * hourHeight - 2, minEventHeight.week);
                    const widthPct = 100 / e.totalCols;
                    return (
                      <div
                        key={e.id}
                        title={`${e.time}${e.endTime ? `–${e.endTime}` : ""} · ${e.title}`}
                        onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}
                        style={{ position: "absolute", top, height, left: `${e.col * widthPct}%`, width: `calc(${widthPct}% - 3px)`, background: personColor(e.assignee, data.profiles), color: "#171812", borderRadius: 5, padding: "2px 5px", fontSize: 9.5, fontWeight: 700, lineHeight: 1.3, overflow: "hidden", cursor: "pointer", zIndex: 2 }}
                      >
                        <span className="evt-dot light" style={{ background: st.color }} />
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
                const st = CAL_STATUS.find((s) => s.id === e.status) || CAL_STATUS[0];
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
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", tags: "", author: "", link: "", color: IDEA_COLORS[0] });
  const [showFolderForm, setShowFolderForm] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [openFolderId, setOpenFolderId] = useState(null);
  const [openIdeaId, setOpenIdeaId] = useState(null);

  const folders = data.ideaFolders || [];
  const ideas = data.ideas || [];

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

  const saveFolderPos = (id, x, y) => saveData({ ...data, ideaFolders: folders.map((f) => (f.id === id ? { ...f, x, y } : f)) });
  const saveIdeaPos = (id, x, y) => saveData({ ...data, ideas: ideas.map((i) => (i.id === id ? { ...i, x, y } : i)) });
  const folderDrag = useDraggable(saveFolderPos, (id) => setOpenFolderId(id), onDragSignal);
  const ideaDrag = useDraggable(saveIdeaPos, (id) => setOpenIdeaId(id), onDragSignal);

  const addFolder = () => {
    if (!folderName.trim()) return;
    const count = folders.length;
    saveData({ ...data, ideaFolders: [...folders, { id: uid(), name: folderName.trim(), x: 40 + (count % 5) * 140, y: 40 + Math.floor(count / 5) * 130, color: IDEA_COLORS[count % IDEA_COLORS.length] }] });
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
    saveData({
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
    saveData({ ...data, ideas: [item, ...ideas] });
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
  const vote = (id) => saveData({
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
    if (item) (item.attachments || []).forEach((a) => deleteDriveFile(a.fileId));
    saveData({ ...data, ideas: ideas.filter((i) => i.id !== id) });
    setOpenIdeaId(null);
  };
  const moveToFolder = (id, folderId) => saveData({ ...data, ideas: ideas.map((i) => (i.id === id ? { ...i, folderId: folderId || null } : i)) });
  const setIdeaColor = (id, color) => saveData({ ...data, ideas: ideas.map((i) => (i.id === id ? { ...i, color } : i)) });

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
      saveData({
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
    saveData({ ...data, ideas: ideas.map((i) => (i.id === ideaId ? { ...i, attachments: (i.attachments || []).filter((a) => a.fileId !== fileId) } : i)) });
  };

  const openIdea = openIdeaId ? positioned.find((i) => i.id === openIdeaId) : null;
  const openYt = openIdea ? youtubeId(openIdea.link) : null;
  const openDrive = openIdea && !openYt ? driveEmbedUrl(openIdea.link) : null;

  const BOARD_W = 1400, BOARD_H = 900;

  // ---- drawing layer ----
  const drawings = (data.ideaDrawings || []).filter((d) => (openFolderId ? d.folderId === openFolderId : !d.folderId));
  const [tool, setTool] = useState("move"); // move | pen | line | rect | circle | erase
  const [drawColor, setDrawColor] = useState(IDEA_COLORS[0]);
  const [draft, setDraft] = useState(null); // shape being drawn right now, not yet saved
  const boardRef = useRef(null);
  const draftRef = useRef(null);
  const drawingMode = tool !== "move";

  const pointOn = (e) => {
    const rect = boardRef.current.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: Math.round(p.clientX - rect.left), y: Math.round(p.clientY - rect.top) };
  };

  const startDraw = (e) => {
    if (!drawingMode || tool === "erase") return;
    e.preventDefault();
    const { x, y } = pointOn(e);
    if (tool === "text") {
      // Drop a text box where you tapped and start typing straight away.
      const created = addBoardItem({ type: "text", x, y, w: 220, text: "", color: drawColor });
      setEditingTextId(created.id);
      setEditingText("");
      setTool("move");
      return;
    }
    const shape = tool === "pen"
      ? { tool: "pen", color: drawColor, points: [x, y] }
      : { tool, color: drawColor, x1: x, y1: y, x2: x, y2: y };
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
      saveData({ ...data, ideaDrawings: [...(data.ideaDrawings || []), { id: uid(), folderId: openFolderId || null, ...shapeToSave }] });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
  };

  const eraseShape = (id) => saveData({ ...data, ideaDrawings: (data.ideaDrawings || []).filter((d) => d.id !== id) });
  const clearDrawings = () => saveData({ ...data, ideaDrawings: (data.ideaDrawings || []).filter((d) => (openFolderId ? d.folderId !== openFolderId : !!d.folderId)) });

  const renderShape = (s, key, isDraft) => {
    const common = { stroke: s.color, strokeWidth: 3, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" };
    const hit = tool === "erase" && !isDraft
      ? { stroke: "transparent", strokeWidth: 16, fill: "none", style: { cursor: "pointer", pointerEvents: "stroke" }, onClick: () => eraseShape(s.id) }
      : null;
    const shapes = [];
    if (s.tool === "pen") {
      const pts = [];
      for (let i = 0; i < s.points.length; i += 2) pts.push(`${s.points[i]},${s.points[i + 1]}`);
      const d = pts.join(" ");
      if (hit) shapes.push(<polyline key={`${key}-hit`} points={d} {...hit} />);
      shapes.push(<polyline key={key} points={d} {...common} />);
    } else if (s.tool === "line") {
      if (hit) shapes.push(<line key={`${key}-hit`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} {...hit} />);
      shapes.push(<line key={key} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} {...common} />);
    } else if (s.tool === "rect") {
      const box = { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), width: Math.abs(s.x2 - s.x1), height: Math.abs(s.y2 - s.y1) };
      if (hit) shapes.push(<rect key={`${key}-hit`} {...box} {...hit} />);
      shapes.push(<rect key={key} {...box} rx={4} {...common} />);
    } else if (s.tool === "circle") {
      const el = { cx: (s.x1 + s.x2) / 2, cy: (s.y1 + s.y2) / 2, rx: Math.abs(s.x2 - s.x1) / 2, ry: Math.abs(s.y2 - s.y1) / 2 };
      if (hit) shapes.push(<ellipse key={`${key}-hit`} {...el} {...hit} />);
      shapes.push(<ellipse key={key} {...el} {...common} />);
    }
    return shapes;
  };

  const TOOLS = [
    { id: "move", label: "Move", icon: Pin },
    { id: "text", label: "Text", icon: TypeIcon },
    { id: "pen", label: "Pen", icon: Pencil },
    { id: "line", label: "Line", icon: ChevronRight },
    { id: "rect", label: "Box", icon: Layers },
    { id: "circle", label: "Circle", icon: Globe },
    { id: "erase", label: "Erase", icon: Trash2 },
  ];

  // ---- loose pictures and text placed straight on the board ----
  // Separate from idea cards: these are for laying out a case — a wall of
  // reference shots with notes around them — rather than pitching one idea.
  const allBoardItems = data.boardItems || [];
  const boardItems = allBoardItems.filter((b) => (openFolderId ? b.folderId === openFolderId : !b.folderId));
  const [editingTextId, setEditingTextId] = useState(null);
  const [editingText, setEditingText] = useState("");
  const [resizing, setResizing] = useState(null); // { id, w }
  const boardFileInputRef = useRef(null);
  const [boardUploading, setBoardUploading] = useState(false);
  const [boardUploadProgress, setBoardUploadProgress] = useState(0);

  const saveBoardItemPos = (id, x, y) => saveData({ ...data, boardItems: allBoardItems.map((b) => (b.id === id ? { ...b, x, y } : b)) });
  const boardItemDrag = useDraggable(saveBoardItemPos, (id) => {
    const item = allBoardItems.find((b) => b.id === id);
    if (!item) return;
    if (tool === "erase") return removeBoardItem(id);
    if (item.type === "text") { setEditingTextId(id); setEditingText(item.text || ""); live.signal({ kind: "write", itemId: id }); }
    else setLightbox({ fileId: item.fileId, kind: item.kind, name: item.name });
  }, onDragSignal);

  const addBoardItem = (item) => {
    const created = { id: uid(), folderId: openFolderId || null, ...item };
    saveData({ ...data, boardItems: [...allBoardItems, created] });
    return created;
  };
  const removeBoardItem = (id) => {
    const item = allBoardItems.find((b) => b.id === id);
    if (item && item.fileId) deleteDriveFile(item.fileId);
    saveData({ ...data, boardItems: allBoardItems.filter((b) => b.id !== id) });
    if (editingTextId === id) setEditingTextId(null);
  };
  const commitText = () => {
    live.stop();
    if (!editingTextId) return;
    const id = editingTextId;
    const text = editingText;
    setEditingTextId(null);
    // An empty text box is just clutter — drop it rather than leave a blank.
    if (!text.trim()) return removeBoardItem(id);
    saveData({ ...data, boardItems: allBoardItems.map((b) => (b.id === id ? { ...b, text } : b)) });
  };

  const handleBoardFileSelect = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
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
        x: 60 + (count % 5) * 60,
        y: 60 + (count % 5) * 40,
        w: 260,
      });
    } catch {
      // the picker can just be used again — nothing half-created is left behind
    }
    setBoardUploading(false);
    e.target.value = "";
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
      latest = Math.max(80, Math.min(900, Math.round(startW + (q.clientX - startX))));
      setResizing({ id: item.id, w: latest });
    };
    const end = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      setResizing(null);
      saveData({ ...data, boardItems: allBoardItems.map((b) => (b.id === item.id ? { ...b, w: latest } : b)) });
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
        <span style={{ display: "flex", gap: 5, marginLeft: 4 }}>
          {IDEA_COLORS.map((c) => (
            <button key={c} onClick={() => setDrawColor(c)} title="Pen and text colour" style={{ width: 20, height: 20, borderRadius: "50%", background: c, border: drawColor === c ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer" }} />
          ))}
        </span>
        {drawings.length > 0 && (
          <button className="btn" style={{ padding: "6px 10px", fontSize: 12, marginLeft: "auto" }} onClick={clearDrawings}>Clear drawing</button>
        )}
      </div>

      <div style={{ position: "relative", width: "100%", overflow: "auto", border: "1px solid var(--hair)", borderRadius: 12, background: "var(--panel)" }}>
        <div
          ref={boardRef}
          onMouseDown={startDraw}
          onTouchStart={startDraw}
          style={{ position: "relative", width: BOARD_W, height: BOARD_H, backgroundImage: "radial-gradient(rgba(237,235,227,0.06) 1px, transparent 1px)", backgroundSize: "22px 22px", cursor: drawingMode && tool !== "erase" ? "crosshair" : "default", touchAction: drawingMode ? "none" : "auto" }}
        >
          <svg
            width={BOARD_W}
            height={BOARD_H}
            // The layer itself never catches clicks — only the strokes do, and
            // only while erasing — so cards and pictures underneath stay usable.
            style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 3 }}
          >
            {drawings.map((s) => renderShape(s, s.id, false))}
            {draft && renderShape(draft, "draft", true)}
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
                style={{
                  position: "absolute", left: pos.x, top: pos.y, width,
                  pointerEvents: drawingMode && tool !== "erase" ? "none" : "auto",
                  cursor: isEditing ? "text" : tool === "erase" ? "pointer" : "grab",
                  userSelect: isEditing ? "text" : "none",
                  touchAction: "none", zIndex: 2,
                }}
              >
                {b.type === "image" ? (
                  <div style={{ position: "relative" }}>
                    <img
                      src={driveThumbSrc(b.fileId, "s800")} onError={hideBrokenThumb}
                      alt={b.name || ""}
                      draggable={false}
                      style={{ width: "100%", borderRadius: 8, display: "block", boxShadow: "0 4px 14px rgba(0,0,0,0.4)", background: "var(--panel-raised)" }}
                    />
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
                    style={{ width: "100%", minHeight: 70, background: "var(--panel-raised)", color: "var(--text)", border: `1px solid ${b.color || "var(--gold)"}`, borderRadius: 6, padding: "8px 10px", fontSize: 14, lineHeight: 1.45, resize: "none" }}
                  />
                ) : (
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: b.color || "var(--text)", fontSize: 15, lineHeight: 1.45, padding: "6px 8px", textShadow: "0 1px 3px rgba(0,0,0,0.5)" }}>
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
                style={{ position: "absolute", left: pos.x, top: pos.y, width: 116, cursor: "grab", userSelect: "none", touchAction: "none", pointerEvents: drawingMode ? "none" : "auto", textAlign: "center" }}
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
                style={{ position: "absolute", left: pos.x, top: pos.y, width: 152, minHeight: 88, pointerEvents: drawingMode ? "none" : "auto", background: i.color, borderRadius: 8, padding: "10px 11px", boxShadow: "0 4px 10px rgba(0,0,0,0.35)", cursor: "grab", userSelect: "none", touchAction: "none" }}
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

          {!currentFolder && folders.length === 0 && boardIdeas.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13, padding: 20, textAlign: "center" }}>
              Nothing here yet — add an idea or a folder to get started.
            </div>
          )}
          {currentFolder && boardIdeas.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 }}>
              Nothing in this folder yet.
            </div>
          )}
        </div>
      </div>

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
                <div style={{ display: "inline-block", background: m.from === profile ? "var(--gold)" : "var(--panel-raised)", color: m.from === profile ? "#171812" : "var(--text)", padding: "8px 12px", borderRadius: 10, fontSize: 13, maxWidth: "75%", textAlign: "left" }}>{m.text}</div>
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
  "ideaDrawings", "boardItems",
];

function normalizeBoard(raw) {
  const board = { ...(raw || {}) };
  for (const key of BOARD_LISTS) if (!Array.isArray(board[key])) board[key] = [];
  board.ideas = board.ideas.map(withVoteList);
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

  const applyLocal = (next) => { dataRef.current = next; setData(next); };

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
