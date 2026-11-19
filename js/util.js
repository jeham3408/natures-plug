// Small helpers shared by the UI modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** 2893 -> "2,893"; null -> "–". */
export function fmt(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return "–";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "JOHAN SVERDRUP" -> "Johan Sverdrup", "FRAM H-NORD" -> "Fram H-Nord". Wellbore names such as "34/8-1" are left alone. */
export function title(s) {
  if (!s) return "";
  if (/\d/.test(s) && /[/]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}

/** "HORDALAND GP" -> "Hordaland Gp", "SOGNEFJORD FM" -> "Sognefjord Fm". */
export const strat = (s) => (s ? title(s).replace(/ Ss$/, " ss") : "");

/** Same rule as the exporter: file-name safe id for a well or wellbore name. */
export const safeId = (name) => String(name).replace(/[^0-9A-Za-z-]+/g, "_").replace(/^_+|_+$/g, "");

/** "DRILLING_PROGRAMME" -> "Drilling programme". */
export function docType(t) {
  if (!t) return "Report";
  const s = t.replace(/_/g, " ").toLowerCase().replace(/\bwl\b/, "wireline").replace(/\bewl\b/, "wireline").replace(/\bmwd\b/, "MWD").replace(/\bvsp\b/, "VSP");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Run fn at most once per animation frame. */
export function frame(fn) {
  let queued = false;
  return (...a) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...a); });
  };
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** A tick step of 1, 2 or 5 times a power of ten that gives roughly `target` ticks over `span`. */
export function niceStep(span, target = 6) {
  const raw = span / Math.max(1, target), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

/** Colour tokens read from CSS, so canvas and SVG follow the theme. */
export function cssVars(names) {
  const cs = getComputedStyle(document.documentElement), out = {};
  for (const n of names) out[n] = cs.getPropertyValue("--" + n).trim();
  return out;
}

export const reducedMotion = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Floating tooltip shared by lists and tracks. */
export function showTip(el, html, x, y) {
  el.innerHTML = html;
  el.hidden = false;
  const r = el.getBoundingClientRect(), W = innerWidth, H = innerHeight;
  let left = x + 14, top = y + 14;
  if (left + r.width > W - 8) left = Math.max(8, x - r.width - 14);
  if (top + r.height > H - 8) top = Math.max(8, y - r.height - 14);
  el.style.left = left + "px";
  el.style.top = top + "px";
}

export const factUrl = {
  dev: (id) => `https://factpages.sodir.no/en/wellbore/PageView/Development/All/${id}`,
  exp: (id) => `https://factpages.sodir.no/en/wellbore/PageView/Exploration/All/${id}`,
  field: (id) => `https://factpages.sodir.no/en/field/PageView/All/${id}`,
};
