// Reading settings model, themes and fonts.

export const FONTS = {
  literata: { label: 'Literata', stack: '"Literata", "Iowan Old Style", Georgia, serif', note: 'Made for screens' },
  sourceserif: { label: 'Source Serif', stack: '"Source Serif 4", "Iowan Old Style", Georgia, serif', note: 'Crisp, modern' },
  garamond: { label: 'EB Garamond', stack: '"EB Garamond", Garamond, "Times New Roman", serif', note: 'Classic book' },
  newsreader: { label: 'Newsreader', stack: '"Newsreader", Georgia, serif', note: 'Editorial' },
  atkinson: { label: 'Atkinson', stack: '"Atkinson Hyperlegible", Verdana, sans-serif', note: 'Highly legible' },
  plex: { label: 'Plex Sans', stack: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif', note: 'Clean sans' },
  system: { label: 'System', stack: 'ui-serif, Georgia, "Times New Roman", serif', note: 'Device font' },
  mono: { label: 'Plex Mono', stack: '"IBM Plex Mono", ui-monospace, Menlo, monospace', note: 'Monospace' },
};

// bg, fg, muted, line (rules/borders), sel (selection), chrome (toolbar bg)
export const THEMES = {
  paper: { label: 'Paper', bg: '#F8F6F1', fg: '#24221E', muted: '#77726A', line: '#E4E0D8', chrome: '#F8F6F1', dark: false },
  white: { label: 'White', bg: '#FFFFFF', fg: '#161616', muted: '#6B6B6B', line: '#E6E6E6', chrome: '#FFFFFF', dark: false },
  sepia: { label: 'Sepia', bg: '#F1E6CF', fg: '#47392A', muted: '#86745D', line: '#DFD0B2', chrome: '#EFE3CA', dark: false },
  sage: { label: 'Sage', bg: '#E4E9E0', fg: '#25302A', muted: '#66736A', line: '#CFD8CB', chrome: '#E1E7DD', dark: false },
  dusk: { label: 'Dusk', bg: '#272624', fg: '#DAD4C8', muted: '#958F84', line: '#3A3835', chrome: '#2C2B29', dark: true },
  night: { label: 'Night', bg: '#000000', fg: '#B9B3A8', muted: '#77736C', line: '#1E1E1E', chrome: '#0B0B0B', dark: true },
  custom: { label: 'Custom', dark: false },
};

export const HL_COLORS = {
  yellow: { label: 'Yellow', css: '#F5D46B' },
  green: { label: 'Green', css: '#9FD39A' },
  blue: { label: 'Blue', css: '#93C2EE' },
  pink: { label: 'Pink', css: '#F2A7C3' },
  orange: { label: 'Orange', css: '#F4B07A' },
};

export const ACCENTS = {
  bookcloth: { label: 'Bookcloth', light: '#2F5D50', dark: '#7FB8A6' },
  ink: { label: 'Ink', light: '#2D4E80', dark: '#8EB0E6' },
  oxblood: { label: 'Oxblood', light: '#7D2F33', dark: '#E39A9C' },
  ochre: { label: 'Ochre', light: '#8C6216', dark: '#E2B865' },
  plum: { label: 'Plum', light: '#5F3C66', dark: '#C7A2CE' },
  graphite: { label: 'Graphite', light: '#3C4148', dark: '#B9C0C9' },
};

export const TOOLBAR_ITEMS = {
  toc: 'Contents',
  search: 'Search in book',
  display: 'Display settings',
  tts: 'Read aloud',
  sounds: 'Background sounds',
  annotations: 'Highlights & notes',
  bookmark: 'Bookmark',
  fullscreen: 'Full screen',
};

export const DEFAULT_READING = {
  theme: 'paper',
  customBg: '#F4EFE6',
  customFg: '#2B2723',
  font: 'literata',
  fontSize: 19,
  lineHeight: 1.6,
  paraSpacing: 0.5,
  indent: false,
  align: 'justify',
  fontWeight: 400,
  margin: 40,
  vMargin: 44,
  maxWidth: 680,
  spread: 'auto',
  flowLayout: 'paged',
  hyphenate: true,
  pageAnim: 'slide',
  zoom: 'auto',
  letterSpacing: 0,
  pdfLayout: 'scroll',
  pdfTint: true,
  pdfCoverAlone: true,
};

export const DEFAULT_UI = {
  appTheme: 'auto',
  accent: 'bookcloth',
  customAccent: '',
  libraryView: 'grid',
  librarySort: 'opened',
  toolbarAutoHide: true,
  toolbar: Object.fromEntries(Object.keys(TOOLBAR_ITEMS).map((k) => [k, true])),
  goalMinutes: 20,
  goalBooks: 12,
  translateTo: 'English',
  ttsRate: 1,
  ttsVoice: '',
  ttsStyle: 'natural',
  sounds: {},
  soundsMaster: 0.8,
  tapToTurn: true,
};

/** The per-book keys (everything a reader might tune per book). */
export const PER_BOOK_KEYS = Object.keys(DEFAULT_READING);

export function themeColors(s) {
  if (s.theme === 'custom') {
    const dark = luminance(s.customBg) < 0.35;
    return { bg: s.customBg, fg: s.customFg, muted: mix(s.customFg, s.customBg, 0.45), line: mix(s.customFg, s.customBg, 0.85), chrome: s.customBg, dark };
  }
  return THEMES[s.theme] || THEMES.paper;
}

function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
}
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return '#' + A.map((v, i) => Math.round(v * (1 - t) + B[i] * t).toString(16).padStart(2, '0')).join('');
}
