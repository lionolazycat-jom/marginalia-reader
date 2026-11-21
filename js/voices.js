// Voice picker for read aloud: filter the phone's voices by gender and accent, hear a sample,
// and shade the tone (lighter, warmer, older, deeper). The voices themselves come from the device.
import { h, dialog } from './util.js';
import { state, saveUI } from './store.js';
import { sortVoices } from './reader.js';

const FEMALE = /\b(female|woman)\b|samantha|karen|moira|tessa|fiona|victoria|allison|\bava\b|susan|zira|\baria\b|jenny|libby|sonia|natasha|emma|\bamy\b|joanna|kendra|kimberly|salli|\bivy\b|nicole|olivia|serena|veena|heera|kalpana|shelley|sandy|\bflo\b|nora|catherine|hazel|linda|heather|jessa|michelle|\bana\b|clara|yara|ayanna|neerja|aditi|raveena|zoe|siri.*(female)|google (uk|us) english female|kyoko|amelie|alice|paulina|monica|luciana|joana|lekha|sara|ellen|anna/i;
const MALE = /\b(male|man)\b|daniel|alex\b|\bfred\b|\btom\b|oliver|david|\bmark\b|\bguy\b|ryan|james|george|richard|rishi|aaron|arthur|gordon|\blee\b|rocko|eddy|reed|thomas|liam|brian|matthew|christopher|eric|roger|steffan|connor|prabhat|hemant|google uk english male|rocko|grandpa|jorge|diego|luca|xander/i;
export const genderOf = (v) => (/female|woman/i.test(v.name) ? 'f' : MALE.test(v.name) ? 'm' : FEMALE.test(v.name) ? 'f' : '?');

const REGION = { US: 'American', GB: 'British', AU: 'Australian', IN: 'Indian', IE: 'Irish', ZA: 'South African', NZ: 'New Zealand', SG: 'Singapore', CA: 'Canadian', MY: 'Malaysian', PH: 'Filipino', NG: 'Nigerian', KE: 'Kenyan', HK: 'Hong Kong', SC: 'Scottish' };
export const accentOf = (v) => {
  const [lang, reg] = (v.lang || '').replace('_', '-').split('-');
  if (!reg) return (lang || '').toUpperCase();
  return (REGION[reg.toUpperCase()] || reg.toUpperCase()) + (lang.toLowerCase() === 'en' ? '' : ` (${lang})`);
};

export const TONES = [
  { key: 'bright', label: 'Younger, brighter', pitch: 1.18, rate: 1 },
  { key: 'natural', label: 'As the voice is', pitch: 1, rate: 1 },
  { key: 'warm', label: 'Warm and low', pitch: 0.88, rate: 0.97 },
  { key: 'older', label: 'Older, gentler', pitch: 0.8, rate: 0.9 },
  { key: 'deep', label: 'Deep', pitch: 0.68, rate: 0.95 },
];
export const toneOf = () => TONES.find((t) => t.key === (state.ui.ttsTone || 'natural')) || TONES[1];

const SAMPLE = 'It was a quiet morning, and the lamp keeper climbed the stairs once more. “Another day,” she said softly.';

export function previewVoice(voice, style = {}) {
  try {
    const synth = window.speechSynthesis; synth.cancel();
    const u = new SpeechSynthesisUtterance(SAMPLE);
    const t = toneOf();
    u.rate = Math.min(3, Math.max(0.4, (state.ui.ttsRate || 1) * t.rate * (style.rate || 1)));
    u.pitch = Math.min(2, Math.max(0.5, t.pitch * (style.pitch || 1)));
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    synth.speak(u);
  } catch {}
}

export async function openVoicePicker({ voices, lang, onChange }) {
  const all = sortVoices(voices, lang);
  let gen = 'any', acc = 'any';
  const accents = [...new Set(all.map(accentOf))].sort();
  const chip = (label, on, fn) => h('button', { type: 'button', class: `vp-chip ${on ? 'on' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: fn }, label);
  const list = h('div.vp-list');
  const gRow = h('div.vp-row'), aRow = h('div.vp-row'), tRow = h('div.vp-row');
  const draw = () => {
    gRow.replaceChildren(...[['any', 'Any voice'], ['f', 'Woman'], ['m', 'Man']].map(([k, l]) => chip(l, gen === k, () => { gen = k; draw(); })));
    aRow.replaceChildren(chip('Any accent', acc === 'any', () => { acc = 'any'; draw(); }), ...accents.slice(0, 14).map((a) => chip(a, acc === a, () => { acc = a; draw(); })));
    const tone = toneOf();
    tRow.replaceChildren(...TONES.map((t) => chip(t.label, tone.key === t.key, async () => { await saveUI({ ttsTone: t.key }); onChange?.(); draw(); previewVoice(all.find((v) => v.voiceURI === state.ui.ttsVoice) || all[0]); })));
    const shown = all.filter((v) => (gen === 'any' || genderOf(v) === gen || (genderOf(v) === '?' && gen === 'any')) && (acc === 'any' || accentOf(v) === acc));
    list.replaceChildren(...(shown.length ? shown : []).map((v) => {
      const on = v.voiceURI === state.ui.ttsVoice;
      return h('div', { class: `vp-item ${on ? 'on' : ''}` },
        h('div.vp-name', h('strong', v.name.replace(/^(Microsoft|Google)\s+/i, '')), h('span', `${accentOf(v)}${genderOf(v) === 'f' ? ' · woman' : genderOf(v) === 'm' ? ' · man' : ''}${v.localService ? '' : ' · needs internet'}`)),
        h('button.btn.vp-play', { type: 'button', onclick: () => previewVoice(v) }, 'Hear'),
        h('button', { type: 'button', class: `btn ${on ? 'btn-primary' : ''}`, onclick: async () => { await saveUI({ ttsVoice: v.voiceURI }); onChange?.(); draw(); } }, on ? 'Chosen' : 'Use'));
    }));
    if (!shown.length) list.append(h('p.hint', all.length ? 'No voice on this phone matches. Try “Any voice” or “Any accent”.' : 'This phone hasn’t listed any voices yet. Open it again in a moment, or install voices in your phone’s text-to-speech settings.'));
  };
  draw();
  const body = h('div.vp',
    h('p.hint', 'These voices live on your phone, so they sound like the phone. You can shade them below, or add better ones (see the note at the bottom).'),
    h('div.vp-label', 'Voice'), gRow,
    h('div.vp-label', 'Accent'), aRow,
    h('div.vp-label', 'Tone'), tRow,
    list,
    h('details.vp-help', h('summary', 'Want more natural voices?'),
      h('p', 'Android: Settings → System → Languages → Text-to-speech output → install Google or Samsung voices, and pick a high-quality voice pack for your language.'),
      h('p', 'iPhone: Settings → Accessibility → Spoken Content → Voices → English → choose one marked Enhanced or Premium (Ava, Evan, Nicky, Zoe, Daniel) and download it.'),
      h('p', 'Voices with “needs internet” are usually the best-sounding ones; they pause when you’re offline.')));
  await dialog({ title: 'Choose a voice', body, wide: true, actions: [{ label: 'Done', value: true, primary: true }] });
  try { window.speechSynthesis.cancel(); } catch {}
}
