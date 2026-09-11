/* --------------------------------------------------------------------------
 * The develop room.
 *
 * Lightroom's right-hand column, panel for panel, wrapped around the shader in
 * photoRender.js. Everything in here only ever changes numbers — the picture in
 * Drive is never touched — so Cancel really does cancel, undo on the board works
 * afterwards, and a look can be copied onto the next photo.
 *
 * Laid out for a desk but usable on a phone: below 900px the panels stack under
 * the picture instead of sitting beside it.
 * ------------------------------------------------------------------------ */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  X, RotateCw, RotateCcw, FlipHorizontal, FlipVertical, Crop as CropIcon, Pipette,
  Sliders, Wand2, Copy, ClipboardPaste, Download, Eye, Undo2, Trash2,
  Circle as CircleIcon, Minus, Brush, ChevronDown, ChevronRight, Check,
} from "lucide-react";
import {
  EDIT_PANELS, EDIT_DEFAULTS, MASK_SLIDERS, MASK_ADJUST_DEFAULTS,
  HSL_BANDS, PRESET_GROUPS, CROP_RATIOS, CURVE_LINE,
  fullEdit, fullMask, trimEdit, isFlatCurve, touchedPanels, curveLUT, histogramOf, autoTone,
} from "./photoEdit";
import { renderPhoto, renderToBlob, rendererAvailable, turnedAspect, MAX_MASKS } from "./photoRender";

const GOLD = "var(--gold)";
const uid = () => Math.random().toString(36).slice(2, 10);

/* ------------------------------ small pieces ------------------------------ */

// Double-clicking a slider puts it back, which is the one shortcut everybody
// who has used Lightroom reaches for without being told.
function Slider({ label, value, min, max, step = 1, reset = 0, onChange, suffix = "" }) {
  const at = value ?? 0;
  const shown = step < 1 ? String(Math.round(at * 100) / 100) : String(Math.round(at));
  const touched = Math.abs(at - reset) > 0.0001;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, marginBottom: 3 }}>
        <span style={{ color: touched ? "var(--text)" : "var(--muted)" }}>{label}</span>
        <span className="mono" style={{ color: touched ? GOLD : "var(--muted)" }}>
          {at > 0 && min < 0 ? "+" : ""}{shown}{suffix}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={at}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(reset)}
        title="Double-click to put this one back"
        style={{ width: "100%", accentColor: GOLD, height: 18 }}
      />
    </div>
  );
}

function Section({ title, dot, open, onToggle, children, right }) {
  return (
    <div style={{ borderBottom: "1px solid var(--hair)" }}>
      <div
        onClick={onToggle}
        role="button"
        style={{
          display: "flex", alignItems: "center", gap: 7, padding: "10px 12px",
          color: "var(--text)", cursor: "pointer", userSelect: "none",
        }}
      >
        {open ? <ChevronDown size={13} color="var(--muted)" /> : <ChevronRight size={13} color="var(--muted)" />}
        <span style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 700 }}>{title}</span>
        {dot && <span style={{ width: 5, height: 5, borderRadius: "50%", background: GOLD }} />}
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>{right}</span>
      </div>
      {open && <div style={{ padding: "0 12px 12px" }}>{children}</div>}
    </div>
  );
}

const BTN = {
  padding: "5px 9px", fontSize: 11, borderRadius: 7, cursor: "pointer",
  background: "var(--panel-raised)", border: "1px solid var(--hair)", color: "var(--text)",
  display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
};
const BTN_ON = { ...BTN, borderColor: GOLD, color: GOLD, background: "var(--gold-soft)" };

/* --------------------------------- curve ---------------------------------- */

// The point curve, drawn and dragged directly. Clicking the line adds a point,
// double-clicking one takes it away, and the ends can only slide up and down —
// which is what stops you accidentally making a curve that has no black in it.
function CurveEditor({ points, onChange, channel }) {
  const ref = useRef(null);
  const size = 220;
  const drag = useRef(null);

  const toCanvas = (p) => ({ x: (p.x / 255) * size, y: size - (p.y / 255) * size });
  const fromEvent = (e) => {
    const r = ref.current.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    return {
      x: Math.max(0, Math.min(255, ((pt.clientX - r.left) / r.width) * 255)),
      y: Math.max(0, Math.min(255, 255 - ((pt.clientY - r.top) / r.height) * 255)),
    };
  };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr; canvas.height = size * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    ctx.strokeStyle = "rgba(237,235,227,0.08)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = (i / 4) * size;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(237,235,227,0.14)";
    ctx.beginPath(); ctx.moveTo(0, size); ctx.lineTo(size, 0); ctx.stroke();

    const lut = curveLUT(points);
    ctx.strokeStyle = channel === "curveR" ? "#D9564B" : channel === "curveG" ? "#6FBE7A"
      : channel === "curveB" ? "#5A7FD9" : "#EDEBE3";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * size, y = size - lut[i] * size;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = GOLD;
    for (const p of points) {
      const c = toCanvas(p);
      ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2); ctx.fill();
    }
  }, [points, channel]);

  const nearest = (at) => {
    let best = -1, bestD = 14;
    points.forEach((p, i) => {
      const d = Math.hypot((p.x - at.x) * (size / 255), (p.y - at.y) * (size / 255));
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  const start = (e) => {
    e.preventDefault();
    const at = fromEvent(e);
    let index = nearest(at);
    if (index < 0) {
      const next = [...points, { x: at.x, y: at.y }].sort((a, b) => a.x - b.x);
      index = next.findIndex((p) => p.x === at.x && p.y === at.y);
      onChange(next);
    }
    drag.current = index;

    const move = (ev) => {
      if (drag.current == null) return;
      ev.preventDefault();
      const to = fromEvent(ev);
      onChange((current) => {
        const next = current.map((p) => ({ ...p }));
        const i = drag.current;
        if (!next[i]) return current;
        // The two end points own the ends of the range; only the ones in
        // between can move sideways, and then only between their neighbours.
        if (i === 0) next[i].x = 0;
        else if (i === next.length - 1) next[i].x = 255;
        else next[i].x = Math.max(next[i - 1].x + 3, Math.min(next[i + 1].x - 3, to.x));
        next[i].y = to.y;
        return next;
      });
    };
    const end = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  return (
    <canvas
      ref={ref}
      onPointerDown={start}
      onDoubleClick={(e) => {
        const i = nearest(fromEvent(e));
        if (i > 0 && i < points.length - 1) onChange(points.filter((_, k) => k !== i));
      }}
      style={{
        width: "100%", maxWidth: size, aspectRatio: "1 / 1", display: "block", margin: "0 auto 8px",
        background: "var(--ink)", border: "1px solid var(--hair)", borderRadius: 8, touchAction: "none", cursor: "crosshair",
      }}
    />
  );
}

/* ------------------------------ grading wheel ----------------------------- */

// Hue round the outside, saturation from the middle out — the same gesture as
// Lightroom's wheels, because picking a colour by dragging one dot is quicker
// than setting two numbers and thinking about what they mean.
function GradeWheel({ label, value, onChange }) {
  const ref = useRef(null);
  const size = 96;

  const set = (e) => {
    const r = ref.current.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    const dx = (pt.clientX - r.left) / r.width - 0.5;
    const dy = (pt.clientY - r.top) / r.height - 0.5;
    const dist = Math.min(1, Math.hypot(dx, dy) * 2);
    const hue = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    onChange({ ...value, h: Math.round((hue + 360) % 360), s: Math.round(dist * 100) });
  };
  const start = (e) => {
    e.preventDefault();
    set(e);
    const move = (ev) => set(ev);
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const angle = ((value.h - 90) * Math.PI) / 180;
  const radius = (value.s / 100) * 0.5;
  const left = `${(0.5 + Math.cos(angle) * radius) * 100}%`;
  const top = `${(0.5 + Math.sin(angle) * radius) * 100}%`;

  return (
    <div style={{ textAlign: "center", flex: "1 1 90px", minWidth: 84 }}>
      <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 5 }}>{label}</div>
      <div
        ref={ref} onPointerDown={start}
        style={{
          width: size, height: size, margin: "0 auto", borderRadius: "50%", position: "relative",
          touchAction: "none", cursor: "crosshair", border: "1px solid var(--hair)",
          // Red at the top and clockwise from there, so the dot's angle is the
          // hue number: 0 up, 120 at green, 240 at blue.
          background: "radial-gradient(circle, #EDEBE3 0%, rgba(237,235,227,0) 72%), conic-gradient(from 0deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
        }}
      >
        <span style={{
          position: "absolute", left, top, width: 11, height: 11, marginLeft: -5.5, marginTop: -5.5,
          borderRadius: "50%", border: "2px solid #12141B", background: "#EDEBE3", boxShadow: "0 0 0 1px rgba(255,255,255,0.5)",
        }} />
      </div>
      <input
        type="range" min={-100} max={100} value={value.l}
        onChange={(e) => onChange({ ...value, l: Number(e.target.value) })}
        title="Luminance"
        style={{ width: size, accentColor: GOLD, marginTop: 5 }}
      />
      {(value.s || value.l) ? (
        <button onClick={() => onChange({ h: 0, s: 0, l: 0 })} style={{ ...BTN, padding: "2px 6px", fontSize: 9.5, marginTop: 2 }}>Clear</button>
      ) : null}
    </div>
  );
}

/* -------------------------------- histogram ------------------------------- */

function Histogram({ hist }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = 240, h = 64;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!hist) return;
    // Additive, so where all three channels overlap you get white — which is
    // exactly the reading you want: white means neutral.
    ctx.globalCompositeOperation = "lighter";
    const channels = [["r", "rgba(217,86,75,0.75)"], ["g", "rgba(111,190,122,0.75)"], ["b", "rgba(90,127,217,0.75)"]];
    for (const [key, colour] of channels) {
      const counts = hist[key];
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < hist.bins; i++) {
        const x = (i / (hist.bins - 1)) * w;
        // A square root keeps the shape readable: a raw count is all spike and
        // no body on anything but a very even picture.
        const y = h - Math.sqrt(counts[i] / hist.peak) * h;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    }
  }, [hist]);
  return (
    <canvas ref={ref} style={{ width: "100%", height: 64, display: "block", background: "var(--ink)", borderRadius: 6, border: "1px solid var(--hair)" }} />
  );
}

/* --------------------------------- editor --------------------------------- */

export default function PhotoEditor({ src, name, look, crop, lookClip, onSave, onCopyLook, onExport, onClose }) {
  const [edit, setEdit] = useState(() => fullEdit(look));
  const [cropBox, setCropBox] = useState(() => crop || { x: 0, y: 0, w: 1, h: 1 });
  const [ratio, setRatio] = useState("free");
  const [mode, setMode] = useState("adjust");      // adjust | crop | mask
  const [peek, setPeek] = useState(false);
  const [showMask, setShowMask] = useState(false);
  const [activeMask, setActiveMask] = useState(null);
  const [curveChannel, setCurveChannel] = useState("curveRGB");
  const [mixerBand, setMixerBand] = useState("red");
  const [mixerMode, setMixerMode] = useState("h");
  const [open, setOpen] = useState({ light: true, color: true });
  const [hist, setHist] = useState(null);
  const [image, setImage] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState("");
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 900);
  const [picking, setPicking] = useState(false);   // eyedropper armed

  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const frameRef = useRef(0);
  const histAt = useRef(0);
  const supported = useMemo(() => rendererAvailable(), []);

  /* ---- load the picture once; every frame after that is the shader's ---- */
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => { if (alive) setImage(img); };
    img.onerror = () => { if (alive) setFailed(true); };
    img.src = src;
    return () => { alive = false; };
  }, [src]);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { if (mode !== "adjust") setMode("adjust"); else onClose(); }
      if (e.key === "\\") { e.preventDefault(); setPeek((p) => !p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onClose]);

  /* ---- one frame per animation tick, however fast a slider is dragged ---- */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const ok = renderPhoto({
      image,
      // Holding Before keeps the framing and drops the look: you are comparing
      // the grade, not asking where the picture went.
      preview: peek ? fullEdit({
        spin: edit.spin, straighten: edit.straighten, flipH: edit.flipH, flipV: edit.flipV,
        perspV: edit.perspV, perspH: edit.perspH, perspRotate: edit.perspRotate,
        geoAspect: edit.geoAspect, geoScale: edit.geoScale, geoX: edit.geoX, geoY: edit.geoY,
      }) : edit,
      // While cropping you need to see what you are cutting away, so the whole
      // picture is drawn and the rectangle sits over it.
      crop: mode === "crop" ? null : cropBox,
      out: canvas,
      maxSize: narrow ? 1100 : 1600,
      showMask: showMask && mode === "mask" && activeMask != null,
    });
    if (!ok) return;
    // The histogram reads the finished frame, so it shows what is actually on
    // screen rather than a guess from the numbers. Reading pixels back off the
    // GPU is the one slow thing here, so it happens a few times a second rather
    // than on every frame of a slider being dragged.
    const now = Date.now();
    if (now - histAt.current > 120) {
      histAt.current = now;
      setHist(histogramOf(canvas));
    }
  }, [image, edit, cropBox, peek, showMask, mode, activeMask, narrow]);

  useEffect(() => {
    if (!supported || !image) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frameRef.current);
  }, [paint, supported, image]);

  /* ---------------------------- changing things --------------------------- */
  const set = (patch) => setEdit((e) => ({ ...e, ...(typeof patch === "function" ? patch(e) : patch) }));
  const setBand = (band, patch) => setEdit((e) => ({ ...e, hsl: { ...e.hsl, [band]: { ...e.hsl[band], ...patch } } }));
  const touched = useMemo(() => touchedPanels(edit), [edit]);

  const resetPanel = (panel) => {
    const patch = {};
    for (const s of panel.sliders) patch[s.key] = EDIT_DEFAULTS[s.key];
    if (panel.id === "curve") {
      patch.curveRGB = CURVE_LINE; patch.curveR = CURVE_LINE; patch.curveG = CURVE_LINE; patch.curveB = CURVE_LINE;
    }
    if (panel.id === "mixer") patch.hsl = EDIT_DEFAULTS.hsl;
    if (panel.id === "grading") {
      patch.gradeShadow = { h: 0, s: 0, l: 0 }; patch.gradeMid = { h: 0, s: 0, l: 0 };
      patch.gradeHigh = { h: 0, s: 0, l: 0 }; patch.gradeGlobal = { h: 0, s: 0, l: 0 };
    }
    if (panel.id === "geometry") { patch.spin = 0; patch.flipH = false; patch.flipV = false; }
    set(patch);
  };

  const applyPreset = (preset) => {
    // A preset replaces the look but never the framing: which bit of the photo
    // you chose, and which way up it is, are decisions about this picture.
    const keep = {
      spin: edit.spin, straighten: edit.straighten, flipH: edit.flipH, flipV: edit.flipV,
      perspV: edit.perspV, perspH: edit.perspH, perspRotate: edit.perspRotate,
      geoAspect: edit.geoAspect, geoScale: edit.geoScale, geoX: edit.geoX, geoY: edit.geoY,
      masks: edit.masks,
    };
    setEdit({ ...fullEdit(preset.look), ...keep });
  };

  const auto = () => {
    if (!canvasRef.current) return;
    // Read the picture as it comes out of the geometry pass only, so Auto is
    // judging the original tones rather than whatever is already dialled in.
    const scratch = document.createElement("canvas");
    const ok = renderPhoto({ image, preview: fullEdit({ spin: edit.spin, straighten: edit.straighten, flipH: edit.flipH, flipV: edit.flipV }), crop: cropBox, out: scratch, maxSize: 400 });
    if (!ok) return;
    set(autoTone(histogramOf(scratch)));
  };

  // Clicking something that should be neutral and letting the maths work out
  // what temperature makes it so — the one white-balance gesture that is
  // quicker than sliding two sliders about.
  const pickWhite = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * canvas.width);
    const y = Math.round(((e.clientY - r.top) / r.height) * canvas.height);
    const scratch = document.createElement("canvas");
    if (!renderPhoto({ image, preview: fullEdit({ ...edit, temp: 0, tint: 0 }), crop: cropBox, out: scratch, maxSize: 1600 })) return;
    let px;
    try {
      px = scratch.getContext("2d").getImageData(
        Math.max(0, Math.min(scratch.width - 1, Math.round(x * (scratch.width / canvas.width)))),
        Math.max(0, Math.min(scratch.height - 1, Math.round(y * (scratch.height / canvas.height)))),
        1, 1,
      ).data;
    } catch { return; }
    const [r0, g0, b0] = px;
    if (r0 + g0 + b0 < 24) { setPicking(false); return; }   // black tells you nothing
    const grey = (r0 + g0 + b0) / 3;
    set({
      temp: Math.max(-100, Math.min(100, Math.round(((grey - r0) / Math.max(1, grey)) * 130))),
      tint: Math.max(-100, Math.min(100, Math.round(((g0 - grey) / Math.max(1, grey)) * 130))),
    });
    setPicking(false);
  };

  /* --------------------------------- masks -------------------------------- */
  const masks = edit.masks;
  const mask = activeMask != null ? masks[activeMask] : null;
  const patchMask = (patch) => setEdit((e) => ({
    ...e,
    masks: e.masks.map((m, i) => (i === activeMask ? { ...m, ...patch } : m)),
  }));
  const patchMaskAdjust = (patch) => setEdit((e) => ({
    ...e,
    masks: e.masks.map((m, i) => (i === activeMask ? { ...m, adjust: { ...m.adjust, ...patch } } : m)),
  }));
  const addMask = (type) => {
    const fresh = fullMask({ id: uid(), type });
    setEdit((e) => ({ ...e, masks: [...e.masks, fresh] }));
    setActiveMask(masks.length);
    setMode("mask");
    setShowMask(true);
  };
  const removeMask = (index) => {
    setEdit((e) => ({ ...e, masks: e.masks.filter((_, i) => i !== index) }));
    setActiveMask(null);
  };

  // Dragging on the picture while a mask is picked: the middle of a radial, the
  // two ends of a linear, or a brush stroke.
  const stagePoint = (e) => {
    const canvas = canvasRef.current;
    const r = canvas.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    return {
      x: Math.max(0, Math.min(1, (pt.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (pt.clientY - r.top) / r.height)),
    };
  };

  const startMaskDrag = (e, grab) => {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev) => {
      const p = stagePoint(ev);
      if (grab === "centre") patchMask({ cx: p.x, cy: p.y });
      else if (grab === "size") {
        patchMask({ rx: Math.max(0.02, Math.abs(p.x - mask.cx)), ry: Math.max(0.02, Math.abs(p.y - mask.cy)) });
      } else if (grab === "a") patchMask({ x1: p.x, y1: p.y });
      else if (grab === "b") patchMask({ x2: p.x, y2: p.y });
    };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const startBrush = (e) => {
    if (!mask || mask.type !== "brush") return;
    e.preventDefault();
    const erase = e.altKey || e.shiftKey;
    const dab = (ev) => {
      const p = stagePoint(ev);
      setEdit((current) => ({
        ...current,
        masks: current.masks.map((m, i) => (i === activeMask
          ? { ...m, strokes: [...m.strokes, { x: p.x, y: p.y, r: m.brushSize, erase }] }
          : m)),
      }));
    };
    dab(e);
    const move = (ev) => dab(ev);
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  /* --------------------------------- crop --------------------------------- */
  const imgAspect = image ? image.naturalWidth / image.naturalHeight : 1;
  // The crop rectangle lives on the picture as it looks now — turned, flipped,
  // straightened — so every shape calculation goes through that, not the
  // proportions of the file on disk.
  const devAspect = image ? turnedAspect(image.naturalWidth, image.naturalHeight, edit) : 1;

  const applyRatio = (id) => {
    setRatio(id);
    const entry = CROP_RATIOS.find((r) => r.id === id);
    if (!entry || entry.ratio === null) return;
    const want = entry.ratio === "original" ? devAspect : entry.ratio;
    // Grow from the middle to the biggest box of that shape that still fits.
    const boxAspect = want / devAspect;             // in normalised picture units
    let w = 1, h = 1 / boxAspect;
    if (h > 1) { h = 1; w = boxAspect; }
    setCropBox({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  };

  const startCropDrag = (e, corner) => {
    e.preventDefault();
    e.stopPropagation();
    const start = cropBox;
    const origin = stagePoint(e);
    const entry = CROP_RATIOS.find((r) => r.id === ratio);
    const lock = entry && entry.ratio !== null
      ? (entry.ratio === "original" ? devAspect : entry.ratio) / devAspect
      : null;

    const move = (ev) => {
      const p = stagePoint(ev);
      const dx = p.x - origin.x, dy = p.y - origin.y;
      let next = { ...start };
      if (corner === "move") {
        next.x = Math.max(0, Math.min(1 - start.w, start.x + dx));
        next.y = Math.max(0, Math.min(1 - start.h, start.y + dy));
      } else {
        const right = corner.includes("e"), bottom = corner.includes("s");
        let x1 = right ? start.x : Math.max(0, Math.min(start.x + start.w - 0.04, start.x + dx));
        let y1 = bottom ? start.y : Math.max(0, Math.min(start.y + start.h - 0.04, start.y + dy));
        let x2 = right ? Math.min(1, Math.max(start.x + 0.04, start.x + start.w + dx)) : start.x + start.w;
        let y2 = bottom ? Math.min(1, Math.max(start.y + 0.04, start.y + start.h + dy)) : start.y + start.h;
        if (lock) {
          // Keep the locked shape by letting the height follow the width.
          const w = x2 - x1;
          const h = w / lock;
          if (bottom) y2 = y1 + h; else y1 = y2 - h;
          if (y1 < 0 || y2 > 1) {
            const hh = Math.min(y2, 1) - Math.max(y1, 0);
            const ww = hh * lock;
            if (right) x2 = x1 + ww; else x1 = x2 - ww;
            y1 = Math.max(0, y1); y2 = Math.min(1, y2);
          }
        }
        next = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
      setCropBox(next);
    };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  /* -------------------------------- leaving ------------------------------- */
  const save = () => {
    const trimmed = trimEdit(edit);
    const finalCrop = cropBox.w >= 0.999 && cropBox.h >= 0.999 && cropBox.x < 0.001 && cropBox.y < 0.001
      ? null : cropBox;
    onSave(trimmed, finalCrop, imgAspect);
  };

  const exportCopy = async () => {
    if (!onExport || !image) return;
    setBusy("Rendering a copy…");
    try {
      const blob = await renderToBlob({ image, look: trimEdit(edit), crop: cropBox, maxSize: 2400 });
      if (!blob) { setBusy("That didn't render."); setTimeout(() => setBusy(""), 3000); return; }
      setBusy("Saving it to Drive…");
      await onExport(blob);
      setBusy("");
    } catch {
      setBusy("Couldn't save the copy.");
      setTimeout(() => setBusy(""), 3000);
    }
  };

  /* --------------------------------- render ------------------------------- */
  const anyEdit = !!trimEdit(edit);

  const stage = (
    <div
      ref={stageRef}
      style={{
        flex: "1 1 auto", minWidth: 0, minHeight: narrow ? 300 : 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "#0B0C10", padding: narrow ? 10 : 18, position: "relative", overflow: "hidden",
      }}
    >
      {!supported ? (
        <div style={{ color: "var(--muted)", fontSize: 12.5, textAlign: "center", maxWidth: 320, lineHeight: 1.5 }}>
          This browser won't give us WebGL, which is what does the work here.
          The picture panel on the board still works — this room needs it.
        </div>
      ) : failed ? (
        <div style={{ color: "var(--muted)", fontSize: 12.5 }}>That picture wouldn't load.</div>
      ) : !image ? (
        <div style={{ color: "var(--muted)", fontSize: 12.5 }}>Loading the picture…</div>
      ) : (
        <div style={{ position: "relative", maxWidth: "100%", maxHeight: "100%", lineHeight: 0 }}>
          <canvas
            ref={canvasRef}
            onPointerDown={picking ? undefined : mode === "mask" && mask && mask.type === "brush" ? startBrush : undefined}
            onClick={picking ? pickWhite : undefined}
            style={{
              maxWidth: "100%", maxHeight: narrow ? "46vh" : "78vh", display: "block", borderRadius: 4,
              cursor: picking ? "crosshair" : mode === "mask" && mask && mask.type === "brush" ? "cell" : "default",
              touchAction: "none",
            }}
          />

          {/* ---- crop frame ---- */}
          {mode === "crop" && (
            <div style={{ position: "absolute", inset: 0 }}>
              <div
                onPointerDown={(e) => startCropDrag(e, "move")}
                style={{
                  position: "absolute",
                  left: `${cropBox.x * 100}%`, top: `${cropBox.y * 100}%`,
                  width: `${cropBox.w * 100}%`, height: `${cropBox.h * 100}%`,
                  border: "1px solid rgba(255,255,255,0.9)", cursor: "move", touchAction: "none",
                  boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                  backgroundImage: "linear-gradient(rgba(255,255,255,0.28) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.28) 1px, transparent 1px)",
                  backgroundSize: "33.33% 33.33%",
                }}
              >
                {["nw", "ne", "sw", "se"].map((corner) => (
                  <span
                    key={corner}
                    onPointerDown={(e) => startCropDrag(e, corner)}
                    style={{
                      position: "absolute", width: 16, height: 16, background: "#fff", borderRadius: 3,
                      [corner.includes("n") ? "top" : "bottom"]: -8,
                      [corner.includes("w") ? "left" : "right"]: -8,
                      cursor: `${corner}-resize`, touchAction: "none",
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ---- mask handles ---- */}
          {mode === "mask" && mask && mask.type === "radial" && (
            <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              <span
                onPointerDown={(e) => startMaskDrag(e, "centre")}
                style={{
                  position: "absolute", left: `${mask.cx * 100}%`, top: `${mask.cy * 100}%`,
                  width: `${mask.rx * 200}%`, height: `${mask.ry * 200}%`, transform: "translate(-50%, -50%)",
                  border: `1.5px solid ${GOLD}`, borderRadius: "50%", pointerEvents: "auto", cursor: "move", touchAction: "none",
                }}
              />
              <span
                onPointerDown={(e) => startMaskDrag(e, "size")}
                style={{
                  position: "absolute", left: `${(mask.cx + mask.rx) * 100}%`, top: `${mask.cy * 100}%`,
                  width: 14, height: 14, marginLeft: -7, marginTop: -7, borderRadius: "50%",
                  background: GOLD, border: "2px solid #12141B", pointerEvents: "auto", cursor: "ew-resize", touchAction: "none",
                }}
              />
            </div>
          )}
          {mode === "mask" && mask && mask.type === "linear" && (
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
              <line
                x1={`${mask.x1 * 100}%`} y1={`${mask.y1 * 100}%`} x2={`${mask.x2 * 100}%`} y2={`${mask.y2 * 100}%`}
                stroke={GOLD} strokeWidth="1.5" strokeDasharray="5 4"
              />
              {[["a", mask.x1, mask.y1], ["b", mask.x2, mask.y2]].map(([grab, x, y]) => (
                <circle
                  key={grab} cx={`${x * 100}%`} cy={`${y * 100}%`} r="7"
                  fill={GOLD} stroke="#12141B" strokeWidth="2"
                  style={{ pointerEvents: "auto", cursor: "move" }}
                  onPointerDown={(e) => startMaskDrag(e, grab)}
                />
              ))}
            </svg>
          )}

          {peek && (
            <span style={{ position: "absolute", top: 8, left: 8, fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 5, background: "rgba(0,0,0,0.7)", color: "#fff" }}>
              BEFORE
            </span>
          )}
        </div>
      )}

      {busy && (
        <div style={{ position: "absolute", bottom: 12, left: 0, right: 0, textAlign: "center", fontSize: 11, color: GOLD }}>{busy}</div>
      )}
    </div>
  );

  const panels = (
    <div style={{
      width: narrow ? "100%" : 296, flexShrink: 0, boxSizing: "border-box",
      background: "var(--panel)", borderLeft: narrow ? "none" : "1px solid var(--hair)",
      borderTop: narrow ? "1px solid var(--hair)" : "none",
      overflowY: "auto", overflowX: "hidden",
    }}>
      <div style={{ padding: 12, borderBottom: "1px solid var(--hair)" }}>
        <Histogram hist={hist} />
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 9 }}>
          <button style={BTN} onClick={auto} title="Read the picture and set the six light sliders"><Wand2 size={11} /> Auto</button>
          <button
            style={BTN}
            onMouseDown={() => setPeek(true)} onMouseUp={() => setPeek(false)} onMouseLeave={() => setPeek(false)}
            onTouchStart={() => setPeek(true)} onTouchEnd={() => setPeek(false)}
            disabled={!anyEdit} title="Hold to see the original (or press \\)"
          ><Eye size={11} /> Before</button>
          <button style={BTN} onClick={() => setEdit(fullEdit(null))} disabled={!anyEdit}><Undo2 size={11} /> Reset</button>
        </div>
      </div>

      {/* ---- presets ---- */}
      <Section title="Presets" open={!!open.presets} onToggle={() => setOpen((o) => ({ ...o, presets: !o.presets }))}>
        {PRESET_GROUPS.map((group) => (
          <div key={group.id} style={{ marginBottom: 9 }}>
            <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 4 }}>{group.label}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {group.presets.map((preset) => (
                <button key={preset.id} style={BTN} onClick={() => applyPreset(preset)}>{preset.label}</button>
              ))}
            </div>
          </div>
        ))}
      </Section>

      {/* ---- every numbered panel ---- */}
      {EDIT_PANELS.map((panel) => (
        <Section
          key={panel.id}
          title={panel.label}
          dot={touched[panel.id]}
          open={!!open[panel.id]}
          onToggle={() => setOpen((o) => ({ ...o, [panel.id]: !o[panel.id] }))}
          right={touched[panel.id] ? (
            <button style={{ ...BTN, padding: "2px 6px", fontSize: 9.5 }} onClick={() => resetPanel(panel)}>Reset</button>
          ) : null}
        >
          {panel.custom === "curve" && (
            <>
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                {[["curveRGB", "RGB"], ["curveR", "R"], ["curveG", "G"], ["curveB", "B"]].map(([key, text]) => (
                  <button
                    key={key} onClick={() => setCurveChannel(key)}
                    style={{ ...(curveChannel === key ? BTN_ON : BTN), flex: 1, justifyContent: "center", padding: "4px 0" }}
                  >{text}{!isFlatCurve(edit[key]) ? " ·" : ""}</button>
                ))}
              </div>
              <CurveEditor
                channel={curveChannel}
                points={edit[curveChannel]}
                onChange={(next) => set((e) => ({ ...e, [curveChannel]: typeof next === "function" ? next(e[curveChannel]) : next }))}
              />
              <button
                style={{ ...BTN, width: "100%", justifyContent: "center", marginBottom: 10 }}
                onClick={() => set({ [curveChannel]: CURVE_LINE })}
                disabled={isFlatCurve(edit[curveChannel])}
              >Straighten this channel</button>
              <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 6 }}>Parametric</div>
            </>
          )}

          {panel.custom === "mixer" && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 9 }}>
                {HSL_BANDS.map((b) => {
                  const v = edit.hsl[b.id];
                  const on = mixerBand === b.id;
                  return (
                    <button
                      key={b.id} onClick={() => setMixerBand(b.id)}
                      title={b.label}
                      style={{
                        width: 26, height: 26, borderRadius: "50%", background: b.swatch, cursor: "pointer", padding: 0,
                        border: on ? "2px solid var(--text)" : (v.h || v.s || v.l) ? `2px solid ${GOLD}` : "2px solid transparent",
                      }}
                    />
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 4, marginBottom: 9 }}>
                {[["h", "Hue"], ["s", "Sat"], ["l", "Lum"], ["band", "One colour"]].map(([key, text]) => (
                  <button
                    key={key} onClick={() => setMixerMode(key)}
                    style={{ ...(mixerMode === key ? BTN_ON : BTN), flex: 1, justifyContent: "center", padding: "4px 0", fontSize: 10 }}
                  >{text}</button>
                ))}
              </div>
              {mixerMode === "band" ? (
                // One colour, all three of its numbers — for when you are
                // chasing a single hue through the picture.
                <>
                  <div style={{ fontSize: 10.5, color: "var(--text)", marginBottom: 6 }}>
                    {HSL_BANDS.find((b) => b.id === mixerBand).label}
                  </div>
                  <Slider label="Hue" min={-100} max={100} value={edit.hsl[mixerBand].h} onChange={(v) => setBand(mixerBand, { h: v })} />
                  <Slider label="Saturation" min={-100} max={100} value={edit.hsl[mixerBand].s} onChange={(v) => setBand(mixerBand, { s: v })} />
                  <Slider label="Luminance" min={-100} max={100} value={edit.hsl[mixerBand].l} onChange={(v) => setBand(mixerBand, { l: v })} />
                </>
              ) : (
                // One number across all eight bands, which is how you balance
                // a whole picture's colour against itself.
                HSL_BANDS.map((b) => (
                  <Slider
                    key={b.id} label={b.label} min={-100} max={100}
                    value={edit.hsl[b.id][mixerMode]}
                    onChange={(v) => setBand(b.id, { [mixerMode]: v })}
                  />
                ))
              )}
            </>
          )}

          {panel.custom === "grading" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              <GradeWheel label="Shadows" value={edit.gradeShadow} onChange={(v) => set({ gradeShadow: v })} />
              <GradeWheel label="Midtones" value={edit.gradeMid} onChange={(v) => set({ gradeMid: v })} />
              <GradeWheel label="Highlights" value={edit.gradeHigh} onChange={(v) => set({ gradeHigh: v })} />
              <GradeWheel label="Global" value={edit.gradeGlobal} onChange={(v) => set({ gradeGlobal: v })} />
            </div>
          )}

          {panel.custom === "geometry" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
              <button style={BTN} onClick={() => set({ spin: (edit.spin + 270) % 360 })}><RotateCcw size={11} /></button>
              <button style={BTN} onClick={() => set({ spin: (edit.spin + 90) % 360 })}><RotateCw size={11} /></button>
              <button style={edit.flipH ? BTN_ON : BTN} onClick={() => set({ flipH: !edit.flipH })}><FlipHorizontal size={11} /></button>
              <button style={edit.flipV ? BTN_ON : BTN} onClick={() => set({ flipV: !edit.flipV })}><FlipVertical size={11} /></button>
              <button style={mode === "crop" ? BTN_ON : BTN} onClick={() => setMode(mode === "crop" ? "adjust" : "crop")}><CropIcon size={11} /> Crop</button>
            </div>
          )}

          {panel.sliders.map((s) => (
            <Slider
              key={s.key} label={s.label} min={s.min} max={s.max} step={s.step}
              reset={EDIT_DEFAULTS[s.key]}
              value={edit[s.key]}
              onChange={(v) => set({ [s.key]: v })}
            />
          ))}

          {panel.id === "color" && (
            <button style={picking ? BTN_ON : BTN} onClick={() => setPicking((p) => !p)}>
              <Pipette size={11} /> {picking ? "Click something grey…" : "Pick a neutral"}
            </button>
          )}
        </Section>
      ))}

      {/* ---- masks ---- */}
      <Section
        title={`Masks${masks.length ? ` (${masks.length})` : ""}`}
        dot={masks.length > 0}
        open={!!open.masks}
        onToggle={() => setOpen((o) => ({ ...o, masks: !o.masks }))}
      >
        <div style={{ display: "flex", gap: 4, marginBottom: 9 }}>
          <button style={BTN} onClick={() => addMask("radial")} disabled={masks.length >= MAX_MASKS}><CircleIcon size={11} /> Radial</button>
          <button style={BTN} onClick={() => addMask("linear")} disabled={masks.length >= MAX_MASKS}><Minus size={11} /> Linear</button>
          <button style={BTN} onClick={() => addMask("brush")} disabled={masks.length >= MAX_MASKS}><Brush size={11} /> Brush</button>
        </div>
        {!masks.length && (
          <div style={{ fontSize: 10.5, color: "var(--muted)", lineHeight: 1.45 }}>
            A mask limits everything under it to part of the picture — darken a sky,
            lift a face, sharpen one thing and leave the rest alone.
          </div>
        )}
        {masks.map((m, i) => (
          <div key={m.id || i} style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <button
                onClick={() => { setActiveMask(activeMask === i ? null : i); setMode("mask"); }}
                style={{ ...(activeMask === i ? BTN_ON : BTN), flex: 1, justifyContent: "flex-start" }}
              >
                {m.type === "radial" ? <CircleIcon size={10} /> : m.type === "linear" ? <Minus size={10} /> : <Brush size={10} />}
                {m.type[0].toUpperCase() + m.type.slice(1)} {i + 1}
                {m.invert ? " · inverted" : ""}
              </button>
              <button style={{ ...BTN, padding: "5px 7px" }} onClick={() => removeMask(i)} title="Remove this mask">
                <Trash2 size={11} />
              </button>
            </div>

            {activeMask === i && (
              <div style={{ padding: "9px 0 4px 8px", borderLeft: `2px solid ${GOLD}`, marginTop: 6 }}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                  <button style={m.invert ? BTN_ON : BTN} onClick={() => patchMask({ invert: !m.invert })}>Invert</button>
                  <button style={showMask ? BTN_ON : BTN} onClick={() => setShowMask((s) => !s)}>Show</button>
                  {m.type === "brush" && (
                    <button style={BTN} onClick={() => patchMask({ strokes: [] })} disabled={!m.strokes.length}>Clear</button>
                  )}
                </div>
                <Slider label="Amount" min={0} max={100} reset={100} value={m.amount} onChange={(v) => patchMask({ amount: v })} />
                {m.type === "radial" && (
                  <>
                    <Slider label="Feather" min={0} max={100} reset={50} value={m.feather} onChange={(v) => patchMask({ feather: v })} />
                    <Slider label="Angle" min={-180} max={180} value={m.angle} onChange={(v) => patchMask({ angle: v })} />
                  </>
                )}
                {m.type === "brush" && (
                  <>
                    <Slider label="Brush size" min={1} max={40} reset={8} value={Math.round(m.brushSize * 100)} onChange={(v) => patchMask({ brushSize: v / 100 })} />
                    <Slider label="Brush feather" min={0} max={100} reset={50} value={m.brushFeather} onChange={(v) => patchMask({ brushFeather: v })} />
                    <Slider label="Flow" min={5} max={100} reset={100} value={m.brushFlow} onChange={(v) => patchMask({ brushFlow: v })} />
                    <div style={{ fontSize: 10, color: "var(--muted)", margin: "2px 0 9px", lineHeight: 1.4 }}>
                      Drag on the picture to paint. Hold Shift or Alt to rub out.
                    </div>
                  </>
                )}
                <div style={{ fontSize: 9.5, color: "var(--muted)", margin: "9px 0 6px" }}>What it does there</div>
                {MASK_SLIDERS.map((s) => (
                  <Slider
                    key={s.key} label={s.label} min={s.min} max={s.max} step={s.step}
                    value={m.adjust[s.key]}
                    onChange={(v) => patchMaskAdjust({ [s.key]: v })}
                  />
                ))}
                <button
                  style={{ ...BTN, width: "100%", justifyContent: "center", marginTop: 4 }}
                  onClick={() => patchMask({ adjust: { ...MASK_ADJUST_DEFAULTS } })}
                >Put this mask's numbers back</button>
              </div>
            )}
          </div>
        ))}
      </Section>

      <div style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 5 }}>
        <button style={BTN} onClick={() => onCopyLook(trimEdit(edit))} disabled={!anyEdit}><Copy size={11} /> Copy settings</button>
        {lookClip && (
          <button style={BTN} onClick={() => setEdit(fullEdit(lookClip))}><ClipboardPaste size={11} /> Paste settings</button>
        )}
        {onExport && (
          <button style={BTN} onClick={exportCopy} disabled={!image || !!busy}><Download size={11} /> Save a copy to Drive</button>
        )}
      </div>
    </div>
  );

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 220, background: "var(--ink)", display: "flex", flexDirection: "column" }}>
      {/* ---- top bar ---- */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "9px 12px",
        borderBottom: "1px solid var(--hair)", background: "var(--panel)", flexWrap: "wrap",
      }}>
        <Sliders size={15} color={GOLD} />
        <span style={{ fontSize: 12.5, fontWeight: 600, marginRight: 4, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name || "Picture"}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          <button style={mode === "adjust" ? BTN_ON : BTN} onClick={() => setMode("adjust")}>Develop</button>
          <button style={mode === "crop" ? BTN_ON : BTN} onClick={() => setMode("crop")}><CropIcon size={11} /> Crop</button>
          <button style={mode === "mask" ? BTN_ON : BTN} onClick={() => setMode("mask")}><Brush size={11} /> Mask</button>
        </div>

        {mode === "crop" && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginLeft: 6 }}>
            {CROP_RATIOS.map((r) => (
              <button key={r.id} style={ratio === r.id ? BTN_ON : BTN} onClick={() => applyRatio(r.id)}>{r.label}</button>
            ))}
            <button style={BTN} onClick={() => { setCropBox({ x: 0, y: 0, w: 1, h: 1 }); setRatio("free"); }}>Whole picture</button>
          </div>
        )}

        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <button style={BTN} onClick={onClose}>Cancel</button>
          <button style={{ ...BTN, borderColor: GOLD, background: GOLD, color: "#12141B", fontWeight: 600 }} onClick={save}>
            <Check size={12} /> Done
          </button>
          <button className="icon-btn" onClick={onClose}><X size={17} /></button>
        </div>
      </div>

      <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: narrow ? "column" : "row" }}>
        {stage}
        {panels}
      </div>
    </div>,
    document.body,
  );
}
