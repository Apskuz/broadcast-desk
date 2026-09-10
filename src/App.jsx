import React, { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import {
  LayoutDashboard, ListChecks, CalendarDays, StickyNote, Video, Lightbulb,
  BookOpen, Plus, X, ChevronLeft, ChevronRight, ThumbsUp, MessageSquare,
  Trash2, CheckCircle2, Clock, AlertTriangle, Link2, Menu, Flame,
  Radio, Users, Pin, ExternalLink, Send, User, Pencil, Settings, Copy, Check, Lock, Shield, RotateCw, Bell, Image, Layers, Upload
} from "lucide-react";

/* ---------------------------------- helpers ---------------------------------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
function sendPush(toProfile, title, body) {
  try {
    fetch("/api/send-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toProfile, title, body }),
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
body{ font-family:'Inter',sans-serif; color:var(--text); background:var(--ink); margin:0; }
.hub{
  font-family:'Inter',sans-serif; color:var(--text); background:var(--ink);
  min-height:100vh; display:flex; position:relative; isolation:isolate;
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
.cal-cell{ min-height:82px; border:1px solid var(--hair); border-radius:8px; padding:6px; background:var(--panel); font-size:11.5px; cursor:pointer; transition:border-color .15s; }
.cal-cell:hover{ border-color:var(--gold); }
.cal-cell.out{ opacity:0.32; }
.cal-cell.today{ border-color:var(--gold); background:var(--gold-soft); }
.cal-cell .dnum{ font-weight:700; margin-bottom:4px; }
.cal-evt{ font-size:9.5px; background:var(--panel-raised); border-radius:4px; padding:2px 5px; margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-left:2px solid var(--gold); cursor:pointer; display:flex; align-items:center; gap:4px; }
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
.idea-grid{ grid-template-columns:repeat(auto-fill, minmax(250px,1fr)); }
.idea-card{ display:flex; flex-direction:column; gap:10px; }
.idea-title{ font-size:14px; font-weight:600; }
.idea-desc{ font-size:12px; color:var(--muted); line-height:1.5; }
.idea-foot{ display:flex; align-items:center; justify-content:space-between; margin-top:auto; }
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
.week-time-label{ font-size:9.5px; color:var(--muted); padding:4px 6px 0 0; text-align:right; border-top:1px solid var(--hair); }
.week-slot{ border-left:1px solid var(--hair); border-top:1px solid var(--hair); min-height:44px; padding:2px; position:relative; cursor:pointer; transition:background .12s; }
.week-slot:hover{ background:var(--panel-raised); }
.week-evt{ background:var(--gold); color:#171812; font-size:10px; font-weight:700; border-radius:5px; padding:3px 6px; margin-bottom:2px; line-height:1.3; overflow:hidden; cursor:pointer; display:flex; align-items:center; gap:4px; }
.week-evt.type-meeting{ background:var(--teal); }
.week-evt.type-deadline{ background:var(--alert); color:#fff; }
.week-evt.type-photo{ background:var(--teal); }
.week-evt.type-graphic{ background:var(--good); }

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
  const [newProjectName, setNewProjectName] = useState("");

  if (!task) return null;

  const updateTask = (patch) => {
    saveData({ ...data, tasks: data.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) });
  };
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
      <div className="field"><label>Title</label><input value={task.title} onChange={(e) => updateTask({ title: e.target.value })} /></div>
      <div className="field"><label>Details</label><textarea value={task.description || ""} onChange={(e) => updateTask({ description: e.target.value })} placeholder="Any brief, links, or notes" /></div>
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

function personColor(name) {
  if (!name) return "var(--muted)";
  const ramp = ["var(--gold)", "var(--teal)", "var(--alert)", "var(--good)"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 997;
  return ramp[hash % ramp.length];
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
  const [mode, setMode] = useState("week"); // "week" | "month" | "day"
  const [justMine, setJustMine] = useState(false);
  const [cursor, setCursor] = useState(new Date());
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", date: todayISO(), time: "09:00", type: "post", status: "planned", notes: "", assignee: "" });
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
      saveData({ ...data, calendarEvents: data.calendarEvents.map((e) => (e.id === editId ? { ...e, ...form } : e)) });
    } else {
      saveData({ ...data, calendarEvents: [...data.calendarEvents, { id: uid(), ...form }] });
    }
    setForm({ title: "", date: form.date, time: form.time, type: "post", status: "planned", notes: "", assignee: "" });
    setEditId(null);
    setShowForm(false);
  };
  const removeEvent = (id) => {
    saveData({ ...data, calendarEvents: data.calendarEvents.filter((e) => e.id !== id) });
    if (editId === id) { setEditId(null); setForm({ ...form, title: "" }); }
  };

  const openAdd = (iso, time) => {
    setForm({ title: "", date: iso, time: time || "09:00", type: "post", status: "planned", notes: "", assignee: profile || "" });
    setEditId(null);
    setShowForm(true);
  };
  const openEdit = (e) => {
    setForm({ title: e.title, date: e.date, time: e.time || "09:00", type: e.type || "post", status: e.status || "planned", notes: e.notes || "", assignee: e.assignee || "" });
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
            return (
              <div>
                {WEEK_HOURS.map((h) => {
                  const label = `${String(h).padStart(2, "0")}:00`;
                  const slotEvents = dayEvents.filter((e) => parseInt((e.time || "0").split(":")[0], 10) === h).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
                  return (
                    <div key={h} style={{ display: "flex", borderTop: "1px solid var(--hair)", minHeight: 52 }}>
                      <div style={{ width: 60, flexShrink: 0, fontSize: 11, color: "var(--muted)", paddingTop: 8 }}>{label}</div>
                      <div style={{ flex: 1, padding: "8px 0", cursor: "pointer" }} onClick={() => openAdd(dayIso, label)}>
                        {slotEvents.map((e) => {
                          const st = CAL_STATUS.find((s) => s.id === e.status) || CAL_STATUS[0];
                          return (
                            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--panel-raised)", borderLeft: `3px solid ${personColor(e.assignee)}`, borderRadius: 6, padding: "7px 10px", marginBottom: 6, fontSize: 13 }} onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}>
                              <span className="evt-dot" style={{ background: st.color }} />
                              <span style={{ fontWeight: 600 }}>{e.time}</span> {e.title}
                              {e.assignee && <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--muted)" }}>{e.assignee}</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      ) : mode === "month" ? (
        <div className="card">
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
                    <div className="cal-evt" key={e.id} title={e.title} style={{ borderLeftColor: personColor(e.assignee) }} onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}>
                      <span className="evt-dot" style={{ background: st.color }} />
                      {e.time ? `${e.time} · ` : ""}{e.title}
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
            {WEEK_HOURS.map((h) => (
              <React.Fragment key={h}>
                <div className="week-time-label">{String(h).padStart(2, "0")}:00</div>
                {weekDays.map((d) => {
                  const iso = isoOf(d);
                  const slotEvents = (eventsByDate[iso] || []).filter((e) => parseInt((e.time || "0").split(":")[0], 10) === h);
                  return (
                    <div key={iso + h} className="week-slot" onClick={() => openAdd(iso, `${String(h).padStart(2, "0")}:00`)}>
                      {slotEvents.map((e) => {
                        const st = CAL_STATUS.find((s) => s.id === e.status) || CAL_STATUS[0];
                        return (
                          <div key={e.id} className={`week-evt type-${e.type}`} title={`${e.time} · ${e.title}`} style={{ borderLeft: `3px solid ${personColor(e.assignee)}` }} onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}>
                            <span className="evt-dot light" style={{ background: st.color }} />
                            {e.time} {e.title}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {showForm && (
        <Modal title={editId ? "Edit calendar event" : "Add calendar event"} onClose={() => setShowForm(false)}>
          <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Product launch post" autoFocus /></div>
          <div className="field-row">
            <div className="field"><label>Date</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
            <div className="field"><label>Time</label><input type="time" value={form.time || "09:00"} onChange={(e) => setForm({ ...form, time: e.target.value })} /></div>
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
function driveEmbedUrl(url) {
  const m = (url || "").match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) || (url || "").match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? `https://drive.google.com/file/d/${m[1]}/preview` : null;
}

// Uploads a file straight to Google Drive from the browser (never through Vercel's own
// server, so large videos don't hit the ~4.5MB serverless request limit). Two small
// backend calls bracket the real upload: one to get an authorized upload slot, one to
// make the finished file viewable by the team.
function uploadToDrive(file, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      const startRes = await fetch("/api/drive-upload-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size }),
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || !startData.sessionUrl) {
        reject(new Error(startData.error || "Couldn't start the upload — is Google Drive connected yet?"));
        return;
      }

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
          resolve({ link: finalizeData.link, name: uploaded.name || file.name });
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
            body: JSON.stringify({ filename: file.name }),
          });
          const finalizeData = await finalizeRes.json().catch(() => ({}));
          if (!finalizeRes.ok || !finalizeData.link) {
            reject(new Error(finalizeData.error || "Network error during upload."));
            return;
          }
          resolve({ link: finalizeData.link, name: file.name });
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

function ContentReview({ data, saveData }) {
  const [showForm, setShowForm] = useState(false);
  const [open, setOpen] = useState(null);
  const [commentText, setCommentText] = useState("");
  const [form, setForm] = useState({ title: "", platform: "Instagram", link: "", assignee: "", format: "video" });
  const [scheduled, setScheduled] = useState({}); // { [contentId]: true } — just for the "added" confirmation text
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState("");

  const handleFileSelect = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError("");
    try {
      const result = await uploadToDrive(file, setUploadProgress);
      setForm((f) => ({ ...f, link: result.link, title: f.title || result.name.replace(/\.[^/.]+$/, "") }));
    } catch (err) {
      setUploadError(err.message || "Upload failed.");
    }
    setUploading(false);
    e.target.value = "";
  };

  const addItem = () => {
    if (!form.title.trim()) return;
    const item = { id: uid(), status: "review", comments: [], caption: "", ...form };
    saveData({ ...data, content: [item, ...data.content] });
    setForm({ title: "", platform: "Instagram", link: "", assignee: "", format: "video" });
    setShowForm(false);
  };
  const updateStatus = (id, status) => saveData({ ...data, content: data.content.map((c) => (c.id === id ? { ...c, status } : c)) });
  const removeItem = (id) => saveData({ ...data, content: data.content.filter((c) => c.id !== id) });
  const addComment = (id) => {
    if (!commentText.trim()) return;
    saveData({
      ...data,
      content: data.content.map((c) => c.id === id
        ? { ...c, comments: [...c.comments, { id: uid(), author: "Team Lead", text: commentText, date: todayISO() }] }
        : c),
    });
    setCommentText("");
  };
  const updateCaption = (id, caption) => saveData({ ...data, content: data.content.map((c) => (c.id === id ? { ...c, caption } : c)) });
  const addToCalendar = (c) => {
    const type = c.format === "photo" ? "photo" : c.format === "graphic" ? "graphic" : "post";
    const event = { id: uid(), title: c.title, date: todayISO(), time: "09:00", type, assignee: c.assignee || "", status: "planned", notes: "Scheduled from Content Review" };
    saveData({ ...data, calendarEvents: [...data.calendarEvents, event] });
    setScheduled({ ...scheduled, [c.id]: true });
  };

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Content Review</div><div className="page-sub">Drop in a link, leave feedback, mark it ready to publish.</div></div>
        <button className="btn btn-gold" onClick={() => setShowForm(true)}><Plus size={15} /> Add content</button>
      </div>

      <div className="content-list">
        {data.content.map((c) => {
          const st = CONTENT_STATUS.find((s) => s.id === c.status) || CONTENT_STATUS[0];
          const fmt = CONTENT_FORMATS.find((f) => f.id === c.format) || CONTENT_FORMATS[0];
          const FmtIcon = fmt.icon;
          const yt = youtubeId(c.link);
          const drive = !yt ? driveEmbedUrl(c.link) : null;
          const isOpen = open === c.id;
          return (
            <div className="content-item" key={c.id}>
              <div className="content-head" onClick={() => setOpen(isOpen ? null : c.id)}>
                <div className="content-thumb" style={{ color: fmt.color }}><FmtIcon size={19} /></div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div className="content-title">{c.title}</div>
                  <div className="content-tags">
                    <span className="pill" style={{ background: fmt.color + "22", color: fmt.color }}>{fmt.label}</span>
                    <span className="pill" style={{ background: "var(--panel-raised)", color: "var(--muted)" }}>{c.platform}</span>
                    <span className="pill" style={{ background: st.color + "22", color: st.color }}>{st.label}</span>
                    {c.assignee && <span className="pill" style={{ background: "var(--panel-raised)", color: "var(--muted)" }}>{c.assignee}</span>}
                    {c.comments.length > 0 && <span className="pill" style={{ background: "var(--panel-raised)", color: "var(--muted)" }}><MessageSquare size={10} style={{ verticalAlign: "-1px", marginRight: 3 }} />{c.comments.length}</span>}
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
                    <textarea value={c.caption || ""} onChange={(e) => updateCaption(c.id, e.target.value)} placeholder="The caption or copy that shipped with this piece…" />
                  </div>

                  {yt && (
                    <div style={{ position: "relative", paddingTop: "56.25%", marginBottom: 16, borderRadius: 8, overflow: "hidden" }}>
                      <iframe
                        src={`https://www.youtube.com/embed/${yt}`}
                        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
                        allowFullScreen title={c.title}
                      />
                    </div>
                  )}
                  {drive && (
                    <div style={{ position: "relative", paddingTop: "56.25%", marginBottom: 16, borderRadius: 8, overflow: "hidden" }}>
                      <iframe
                        src={drive}
                        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
                        allowFullScreen title={c.title}
                      />
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
        {data.content.length === 0 && <div className="empty">Nothing submitted yet.</div>}
      </div>

      {showForm && (
        <Modal title="Add content for review" onClose={() => setShowForm(false)}>
          <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Launch teaser — 15s cut" autoFocus /></div>

          <div className="field">
            <label>Upload video or photo</label>
            <label className="btn" style={{ width: "100%", justifyContent: "center", cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.7 : 1 }}>
              <Upload size={14} /> {uploading ? `Uploading… ${uploadProgress}%` : "Choose a file"}
              <input type="file" accept="video/*,image/*" onChange={handleFileSelect} disabled={uploading} style={{ display: "none" }} />
            </label>
            {uploading && (
              <div className="progress-track" style={{ marginTop: 8 }}>
                <div className="progress-fill" style={{ width: `${uploadProgress}%`, background: "var(--gold)" }} />
              </div>
            )}
            {uploadError && <div style={{ fontSize: 11.5, color: "var(--alert)", marginTop: 6 }}>{uploadError}</div>}
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
          <div className="modal-actions"><button className="btn" onClick={() => setShowForm(false)}>Cancel</button><button className="btn btn-gold" onClick={addItem} disabled={uploading}>Add</button></div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------- Idea bank ---------------------------------- */

function IdeaBank({ data, saveData }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", tags: "", author: "", link: "" });

  const addIdea = () => {
    if (!form.title.trim()) return;
    const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
    saveData({ ...data, ideas: [{ id: uid(), votes: 0, ...form, tags }, ...data.ideas] });
    setForm({ title: "", description: "", tags: "", author: form.author, link: "" });
    setShowForm(false);
  };
  const vote = (id) => saveData({ ...data, ideas: data.ideas.map((i) => (i.id === id ? { ...i, votes: i.votes + 1 } : i)) });
  const removeIdea = (id) => saveData({ ...data, ideas: data.ideas.filter((i) => i.id !== id) });

  const sorted = [...data.ideas].sort((a, b) => b.votes - a.votes);

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Idea Bank</div><div className="page-sub">Drop content ideas here — the team votes on what's next.</div></div>
        <button className="btn btn-gold" onClick={() => setShowForm(true)}><Plus size={15} /> Add idea</button>
      </div>
      <div className="grid idea-grid">
        {sorted.map((i) => {
          const yt = youtubeId(i.link);
          const drive = !yt ? driveEmbedUrl(i.link) : null;
          return (
          <div className="card idea-card" key={i.id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div className="idea-title">{i.title}</div>
              <button className="icon-btn" onClick={() => removeIdea(i.id)}><Trash2 size={13} /></button>
            </div>
            {i.description && <div className="idea-desc">{i.description}</div>}
            {(yt || drive) && (
              <div style={{ position: "relative", paddingTop: "56.25%", borderRadius: 8, overflow: "hidden" }}>
                <iframe
                  src={yt ? `https://www.youtube.com/embed/${yt}` : drive}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
                  allowFullScreen title={i.title}
                />
              </div>
            )}
            {i.link && !yt && !drive && (
              <a href={i.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: "var(--gold)", display: "inline-flex", alignItems: "center", gap: 5, textDecoration: "none" }}><Link2 size={11} /> View reference</a>
            )}
            {i.tags && i.tags.length > 0 && (
              <div className="content-tags">
                {i.tags.map((t) => <span className="pill" key={t} style={{ background: "var(--teal-soft)", color: "var(--teal)" }}>{t}</span>)}
              </div>
            )}
            <div className="idea-foot">
              <span style={{ fontSize: 11, color: "var(--muted)" }}>{i.author || "Anonymous"}</span>
              <button className="vote-btn" onClick={() => vote(i.id)}><ThumbsUp size={13} /> {i.votes}</button>
            </div>
          </div>
        );})}
        {sorted.length === 0 && <div className="empty">No ideas yet — be the first to add one.</div>}
      </div>

      {showForm && (
        <Modal title="Add an idea" onClose={() => setShowForm(false)}>
          <div className="field"><label>Idea</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Myth-busting series" autoFocus /></div>
          <div className="field"><label>Description</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What's the concept?" /></div>
          <div className="field"><label>Video or reference link (optional)</label><input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="Paste a YouTube, Drive, or inspiration link" /></div>
          <div className="field-row">
            <div className="field"><label>Tags (comma separated)</label><input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="Reels, Series" /></div>
            <div className="field"><label>Your name</label><input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} placeholder="e.g. Alex" /></div>
          </div>
          <div className="modal-actions"><button className="btn" onClick={() => setShowForm(false)}>Cancel</button><button className="btn btn-gold" onClick={addIdea}>Add idea</button></div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------- Meeting (agenda + announcements) ---------------------------------- */

function Meeting({ data, saveData, profile }) {
  const [agendaText, setAgendaText] = useState("");
  const [announceText, setAnnounceText] = useState("");

  const meetingItems = data.meetingItems || [];
  const announcements = data.announcements || [];

  const addAgendaItem = () => {
    if (!agendaText.trim()) return;
    saveData({ ...data, meetingItems: [{ id: uid(), text: agendaText.trim(), author: profile || "Team", date: todayISO(), done: false }, ...meetingItems] });
    setAgendaText("");
  };
  const toggleAgendaDone = (id) => saveData({ ...data, meetingItems: meetingItems.map((m) => (m.id === id ? { ...m, done: !m.done } : m)) });
  const removeAgendaItem = (id) => saveData({ ...data, meetingItems: meetingItems.filter((m) => m.id !== id) });
  const clearDiscussed = () => saveData({ ...data, meetingItems: meetingItems.filter((m) => !m.done) });

  const addAnnouncement = () => {
    if (!announceText.trim()) return;
    const notifications = [...(data.notifications || []), makeNotification({ toProfile: null, type: "announcement", text: `${profile || "Team"} posted an announcement`, link: "dashboard", fromProfile: profile })];
    saveData({ ...data, announcements: [...announcements, { id: uid(), text: announceText.trim(), author: profile || "Team", date: todayISO() }], notifications });
    sendPush(null, "New announcement", announceText.trim().slice(0, 100));
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
          <div className="comment-form" style={{ marginBottom: 16 }}>
            <textarea placeholder="Something to bring up next meeting…" value={agendaText} onChange={(e) => setAgendaText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addAgendaItem(); } }} />
            <button className="btn btn-gold" style={{ alignSelf: "flex-end" }} onClick={addAgendaItem}><Plus size={14} /></button>
          </div>
          {sortedAgenda.map((m) => (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--hair)" }}>
              <button className={`check-btn ${m.done ? "done" : ""}`} onClick={() => toggleAgendaDone(m.id)}><CheckCircle2 size={12} /></button>
              <div style={{ flex: 1, fontSize: 13, textDecoration: m.done ? "line-through" : "none", opacity: m.done ? 0.55 : 1 }}>{m.text}</div>
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
      sendPush(null, `${profile} in Team Chat`, text.trim().slice(0, 100));
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

/* ---------------------------------- Guidelines / resources ---------------------------------- */

function Guidelines({ data, saveData }) {
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

  return (
    <div>
      <div className="topbar">
        <div><div className="page-title">Guidelines & Resources</div><div className="page-sub">Everything the team needs to stay on-brand and unblocked.</div></div>
        <button className="btn btn-gold" onClick={() => setShowForm(true)}><Plus size={15} /> Add resource</button>
      </div>

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
    saveData({
      ...data,
      tasks: [],
      calendarEvents: [],
      notes: [],
      content: [],
      ideas: [],
      resources: [],
    });
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

  const ICONS = { task: ListChecks, note: MessageSquare, announcement: Radio, message: Send };

  return (
    <div style={{ position: "relative" }}>
      <button className="btn-ghost btn" style={{ position: "relative", width: "100%", justifyContent: "flex-start", gap: 10 }} onClick={() => setOpen(!open)}>
        <Bell size={16} />
        Notifications
        {unread.length > 0 && (
          <span style={{ marginLeft: "auto", background: "var(--alert)", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 6px" }}>{unread.length}</span>
        )}
      </button>
      {open && (
        <div style={{ position: "absolute", left: 0, top: "100%", marginTop: 6, width: 300, maxHeight: 360, overflowY: "auto", background: "var(--panel-raised)", border: "1px solid var(--hair)", borderRadius: 10, boxShadow: "0 12px 30px rgba(0,0,0,0.4)", zIndex: 50, padding: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 6px 8px" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Notifications</span>
            {unread.length > 0 && <button onClick={markAllRead} style={{ fontSize: 10.5, color: "var(--gold)", background: "none", border: "none" }}>Mark all read</button>}
          </div>
          {mine.length === 0 && <div className="empty" style={{ padding: "16px 6px" }}>Nothing yet.</div>}
          {mine.slice(0, 25).map((n) => {
            const Icon = ICONS[n.type] || Bell;
            const isUnread = !(n.readBy || []).includes(profile);
            return (
              <button key={n.id} onClick={() => openNotif(n)} style={{ display: "flex", gap: 9, width: "100%", textAlign: "left", padding: "8px 6px", borderRadius: 7, background: isUnread ? "var(--gold-soft)" : "transparent", border: "none", marginBottom: 3 }}>
                <span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--panel)", color: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={13} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.35 }}>{n.text}</div>
                  <div style={{ fontSize: 9.5, color: "var(--muted)", marginTop: 2 }}>{fmtDate(n.date)}</div>
                </div>
                {isUnread && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--gold)", flexShrink: 0, marginTop: 5 }} />}
              </button>
            );
          })}
        </div>
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
  { id: "ideas", label: "Idea Bank", icon: Lightbulb },
  { id: "guidelines", label: "Guidelines", icon: BookOpen },
  { id: "team", label: "Team", icon: Shield },
];

export default function TeamHub() {
  const [data, setData] = useState(null);
  const [view, setView] = useState("dashboard");
  const [navOpen, setNavOpen] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [loggedIn, setLoggedIn] = useState(null); // { id, name, color, pin }
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let channel = null;

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    (async () => {
      let loadedData = null;
      const { data: row, error } = await supabase.from("hub_state").select("data").eq("id", "main").single();

      if (row && row.data) {
        loadedData = row.data;
      } else {
        loadedData = seedData();
        await supabase.from("hub_state").upsert({ id: "main", data: loadedData });
      }
      if (!loadedData.profiles) loadedData.profiles = [];
      if (!loadedData.deletedTasks) loadedData.deletedTasks = [];
      if (!loadedData.messages) loadedData.messages = [];
      if (!loadedData.notifications) loadedData.notifications = [];
      if (!loadedData.projects) loadedData.projects = [];
      if (loadedData.profiles.length > 0 && !loadedData.profiles.some((p) => p.isLead)) {
        loadedData = { ...loadedData, profiles: loadedData.profiles.map((p, i) => (i === 0 ? { ...p, isLead: true } : p)) };
      }

      if (cancelled) return;
      setData(loadedData);

      try {
        const savedId = localStorage.getItem("my-profile-id");
        if (savedId) {
          const match = loadedData.profiles.find((p) => p.id === savedId);
          if (match) setLoggedIn(match);
        }
      } catch {
        // stay on login screen
      }
      if (!cancelled) setAuthReady(true);

      channel = supabase
        .channel("hub_state_live")
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "hub_state", filter: "id=eq.main" },
          (payload) => { if (!cancelled && payload.new && payload.new.data) setData(payload.new.data); }
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  const saveData = async (next) => {
    setData(next);
    try {
      const { error } = await supabase.from("hub_state").update({ data: next, updated_at: new Date().toISOString() }).eq("id", "main");
      setSaveError(!!error);
    } catch {
      setSaveError(true);
    }
  };

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

  const Comp = {
    dashboard: <Dashboard data={data} saveData={saveData} profile={profile} setView={setView} isEmployer={isEmployer} />,
    myduties: <MyDuties data={data} saveData={saveData} profile={profile} />,
    duties: <Duties data={data} saveData={saveData} profile={profile} />,
    calendar: <Calendar data={data} saveData={saveData} profile={profile} />,
    meeting: <Meeting data={data} saveData={saveData} profile={profile} />,
    chat: <Chat data={data} saveData={saveData} profile={profile} />,
    notes: <Notes data={data} saveData={saveData} />,
    content: <ContentReview data={data} saveData={saveData} />,
    ideas: <IdeaBank data={data} saveData={saveData} />,
    guidelines: <Guidelines data={data} saveData={saveData} />,
    team: <TeamManage data={data} saveData={saveData} />,
  }[view];

  return (
    <div className="hub">
      <style>{CSS}</style>

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

        {NAV.filter((n) => n.id !== "team" || isEmployer).map((n) => {
          const Icon = n.icon;
          return (
            <button key={n.id} className={`nav-item ${view === n.id ? "active" : ""}`} onClick={() => { setView(n.id); setNavOpen(false); }}>
              <Icon size={16} /> {n.label}
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
