import type { Layout, Logo } from './layout';

export type Aspect = '9:16' | '16:9' | '1:1' | '4:5';
export type TrackKind = 'video' | 'text' | 'audio';
export type ClipKind = 'video' | 'image' | 'audio' | 'text' | 'caption';
export type AnimType = 'fade' | 'slide' | 'zoom' | 'pop' | 'typewriter';
export type TransitionType =
  | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'zoom' | 'dip'
  | 'slide-down' | 'zoom-out' | 'spin' | 'blur' | 'flash' | 'dip-white' | 'wipe-left' | 'wipe-right' | 'wipe-up' | 'wipe-down';
export const TRANSITION_TYPES: TransitionType[] = ['fade', 'dip', 'dip-white', 'flash', 'blur', 'zoom', 'zoom-out', 'spin', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down'];
export type BlendMode = 'normal' | 'screen' | 'lighten' | 'multiply' | 'overlay';
export const BLEND_MODES: BlendMode[] = ['normal', 'screen', 'lighten', 'multiply', 'overlay'];
export type Ease = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold';
export const EASES: Ease[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'];

/** A point of a clip's motion. t = seconds from the clip start; x / y as ClipFx.posX / posY; rotation in degrees.
 *  `ease` shapes the way from this keyframe to the next one. */
export interface Keyframe {
  t: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  ease: Ease;
}

export interface MediaAsset {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio';
  file: string; // file name inside data/media
  proxy?: string; // browser-friendly copy, when the original codec can't play in the browser
  thumb?: string;
  duration: number; // seconds (images: 0)
  width?: number;
  height?: number;
  hasAudio: boolean;
  wave?: string; // waveform image
  libraryId?: string; // built-in sound effect this asset was copied from
  credit?: MediaCredit; // stock: licence and who made it
  source?: string; // the address it was downloaded from (stock or "import from a link")
}

/** Licence and credit of a downloaded asset, shown in the library and listed by /credits. */
export interface MediaCredit {
  provider: string; // Openverse, Pexels, Pixabay
  title?: string;
  author?: string;
  authorUrl?: string;
  license: string;
  licenseUrl?: string;
  sourceUrl?: string;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  captions?: boolean; // the dedicated captions track
  muted?: boolean;
  hidden?: boolean;
}

export interface TextStyle {
  font: string;
  size: number; // px in project resolution
  color: string; // #rrggbb
  bg: string | null; // #rrggbb or null for no box
  bold: boolean;
  x: number; // 0..1 centre position
  y: number; // 0..1
  outline?: string; // outline colour when there is no box (default black)
  highlight?: string | null; // captions: colour of the word being spoken
}

/** Picture settings of a video / image clip. Every field is optional; missing = neutral. */
export interface ClipFx {
  fit?: 'contain' | 'cover';
  scale?: number; // 0.2..3
  posX?: number; // offset as a fraction of the frame width (-1..1)
  posY?: number;
  opacity?: number; // 0..1
  flip?: boolean;
  look?: string; // id of the colour preset the values came from
  brightness?: number; // 0.5..1.5
  contrast?: number; // 0.5..1.5
  saturation?: number; // 0..2
  temperature?: number; // -1 (cool) .. 1 (warm)
  sepia?: number; // 0..1
  blur?: number; // px in project resolution
  rotation?: number; // degrees, clockwise (-180..180)
  blend?: BlendMode; // how the picture mixes with the layers under it (default normal)
}

export interface CaptionWord {
  s: number; // seconds from the clip start
  e: number;
  w: string;
}

export interface Anim {
  type: AnimType;
  duration: number;
}

export interface Transition {
  type: TransitionType;
  duration: number;
}

export interface Clip {
  id: string;
  trackId: string;
  kind: ClipKind;
  start: number; // timeline seconds
  duration: number;
  mediaId?: string;
  offset: number; // seconds into the source media
  text?: string;
  style?: Partial<TextStyle>; // text clips: own style. captions: overrides on top of project.captionStyle
  volume: number; // 0..2
  fadeIn?: number; // audio fade seconds
  fadeOut?: number;
  animIn?: Anim | null;
  animOut?: Anim | null;
  transition?: Transition | null; // transition from the previous clip on the same track into this one
  music?: boolean; // background music / sound effect: left out of the transcription
  speed?: number; // playback rate of the source (video / audio), default 1
  fx?: ClipFx;
  words?: CaptionWord[]; // captions: per-word timing from the transcription
  keyframes?: Keyframe[]; // video / image motion; when present it overrides fx posX / posY / scale / rotation / opacity
}

export interface ProjectSettings {
  aspect: Aspect;
  width: number;
  height: number;
  fps: 30 | 60;
}

export interface Project {
  id: string;
  name: string;
  rev: number;
  updatedAt: string;
  settings: ProjectSettings;
  media: MediaAsset[];
  tracks: Track[]; // index 0 = top layer
  clips: Clip[];
  captionStyle: TextStyle;
  inPoint: number | null;
  outPoint: number | null;
  background?: string; // canvas colour behind the clips (default black)
  captionAnim?: Anim | null; // entry animation given to every caption
  layout?: Layout; // how the two bottom video tracks share the frame (default single)
  logo?: Logo | null; // a picture on every frame of the export
  titleFont?: string; // font given to new titles that do not name one (default: Arial)
}

export const RESOLUTIONS: Record<Aspect, { label: string; width: number; height: number }[]> = {
  '9:16': [
    { label: '720p', width: 720, height: 1280 },
    { label: '1080p', width: 1080, height: 1920 },
    { label: '4K', width: 2160, height: 3840 },
  ],
  '16:9': [
    { label: '720p', width: 1280, height: 720 },
    { label: '1080p', width: 1920, height: 1080 },
    { label: '4K', width: 3840, height: 2160 },
  ],
  '1:1': [
    { label: '720p', width: 720, height: 720 },
    { label: '1080p', width: 1080, height: 1080 },
    { label: '4K', width: 2160, height: 2160 },
  ],
  '4:5': [
    { label: '720p', width: 720, height: 900 },
    { label: '1080p', width: 1080, height: 1350 },
    { label: '4K', width: 2160, height: 2700 },
  ],
};
export const ASPECTS = Object.keys(RESOLUTIONS) as Aspect[];

export const FONTS = ['Arial', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Courier New', 'David', 'Aharoni', 'Gisha'];

export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: 'Arial',
  size: 96,
  color: '#ffffff',
  bg: null,
  bold: true,
  x: 0.5,
  y: 0.5,
};

export const DEFAULT_CAPTION_STYLE: TextStyle = {
  font: 'Arial',
  size: 64,
  color: '#ffffff',
  bg: '#000000',
  bold: true,
  x: 0.5,
  y: 0.82,
};

export const ANIM_LABELS: Record<AnimType, string> = { fade: 'דהייה', slide: 'החלקה', zoom: 'זום', pop: 'פופ', typewriter: 'מכונת כתיבה' };
export const TRANSITION_LABELS: Record<TransitionType, string> = {
  fade: 'מיזוג',
  'slide-left': 'החלקה שמאלה',
  'slide-right': 'החלקה ימינה',
  'slide-up': 'החלקה למעלה',
  zoom: 'זום',
  dip: 'דהייה לשחור',
  'slide-down': 'החלקה למטה',
  'zoom-out': 'זום החוצה',
  spin: 'סיבוב',
  blur: 'טשטוש',
  flash: 'הבזק',
  'dip-white': 'דהייה ללבן',
  'wipe-left': 'מחיקה שמאלה',
  'wipe-right': 'מחיקה ימינה',
  'wipe-up': 'מחיקה למעלה',
  'wipe-down': 'מחיקה למטה',
};
export const BLEND_LABELS: Record<BlendMode, string> = { normal: 'רגיל', screen: 'הבהרה (Screen)', lighten: 'בהיר יותר (Lighten)', multiply: 'הכפלה (Multiply)', overlay: 'שכבת על (Overlay)' };
export const EASE_LABELS: Record<Ease, string> = { linear: 'קבוע', 'ease-in': 'האצה', 'ease-out': 'האטה', 'ease-in-out': 'האצה והאטה', hold: 'קפיצה (בלי מעבר)' };

export interface Job {
  id: string;
  projectId: string;
  type: 'export' | 'captions' | 'import' | 'translate';
  engine?: 'local' | 'cloud'; // captions: where the speech was transcribed
  status: 'running' | 'done' | 'error';
  progress: number; // 0..1
  message?: string;
  stage?: string; // captions: audio | download | load | transcribe
  elapsed?: number; // seconds since the job started
  eta?: number | null; // estimated seconds left (null = not known yet)
  pos?: number; // captions: seconds of audio transcribed so far
  total?: number; // captions: seconds of audio in total
  startedAt?: number;
  cancelled?: boolean;
  dl?: number; // captions, first run: model bytes downloaded so far
  dlTotal?: number;
  mediaId?: string; // import: the media it added
  error?: string;
  file?: string; // export file name
  url?: string;
  result?: unknown;
}

export interface Look {
  id: string;
  label: string;
  fx: Pick<ClipFx, 'brightness' | 'contrast' | 'saturation' | 'temperature' | 'sepia'>;
}
export const LOOKS: Look[] = [
  { id: 'vivid', label: 'חי', fx: { saturation: 1.4, contrast: 1.1 } },
  { id: 'warm', label: 'חם', fx: { temperature: 0.6, saturation: 1.1 } },
  { id: 'cool', label: 'קר', fx: { temperature: -0.6, contrast: 1.05 } },
  { id: 'bw', label: 'שחור-לבן', fx: { saturation: 0, contrast: 1.15 } },
  { id: 'vintage', label: 'וינטג׳', fx: { sepia: 0.6, contrast: 0.92, brightness: 1.05 } },
  { id: 'dramatic', label: 'דרמטי', fx: { contrast: 1.35, saturation: 0.85, brightness: 0.95 } },
  { id: 'faded', label: 'דהוי', fx: { contrast: 0.8, brightness: 1.1, saturation: 0.8 } },
  { id: 'cinema', label: 'קולנועי', fx: { contrast: 1.18, saturation: 0.9, temperature: -0.25 } },
  { id: 'sunny', label: 'שמשי', fx: { brightness: 1.12, temperature: 0.35, saturation: 1.2 } },
];

export const CAPTION_PRESETS: { id: string; label: string; style: Partial<TextStyle> }[] = [
  { id: 'classic', label: 'קלאסי', style: { font: 'Arial', color: '#ffffff', bg: null, outline: '#000000', highlight: null, bold: true } },
  { id: 'box', label: 'קופסה', style: { font: 'Arial', color: '#ffffff', bg: '#000000', highlight: null, bold: true } },
  { id: 'yellow', label: 'צהוב', style: { font: 'Arial', color: '#ffe500', bg: null, outline: '#000000', highlight: null, bold: true } },
  { id: 'karaoke', label: 'מילה מודגשת', style: { font: 'Arial', color: '#ffffff', bg: null, outline: '#000000', highlight: '#ffe500', bold: true } },
  { id: 'brand', label: 'כתום', style: { font: 'Arial', color: '#ffffff', bg: '#ff6a3d', highlight: null, bold: true } },
  { id: 'light', label: 'בהיר', style: { font: 'Segoe UI', color: '#1d1c1a', bg: '#ffffff', highlight: '#ff6a3d', bold: true } },
  { id: 'marker', label: 'מרקר', style: { font: 'Arial', color: '#111111', bg: '#ffe500', highlight: null, bold: true } },
  { id: 'neon', label: 'ניאון', style: { font: 'Arial', color: '#7df9ff', bg: null, outline: '#001a33', highlight: '#ff3df5', bold: true } },
  { id: 'minimal', label: 'עדין', style: { font: 'Segoe UI', color: '#ffffff', bg: null, outline: '#000000', highlight: null, bold: false } },
  { id: 'mint', label: 'מנטה', style: { font: 'Arial', color: '#ffffff', bg: '#1d1c1a', highlight: '#3dffb0', bold: true } },
];

/** Ready-made title styles for the text library, `add_text { preset }` and MCP. Fields not given keep the defaults. */
export const TEXT_PRESETS: { id: string; label: string; sample: string; style: Partial<TextStyle> }[] = [
  { id: 'title', label: 'כותרת', sample: 'כותרת ראשית', style: { size: 120, y: 0.3, bold: true } },
  { id: 'subtitle', label: 'כותרת משנה', sample: 'כותרת משנה', style: { size: 72, y: 0.42, bold: false } },
  { id: 'display', label: 'כותרת תצוגה', sample: 'גדול', style: { size: 200, y: 0.45, bold: true, outline: '#000000' } },
  { id: 'kicker', label: 'כותרת עליונה', sample: 'חדש', style: { size: 44, y: 0.2, bold: true, color: '#ff6a3d' } },
  { id: 'lower-third', label: 'שם ותפקיד', sample: 'שם מלא · תפקיד', style: { size: 52, x: 0.66, y: 0.84, bold: true, bg: '#141414', color: '#ffffff' } },
  { id: 'cta', label: 'קריאה לפעולה', sample: 'הירשמו עכשיו', style: { size: 68, y: 0.86, bold: true, bg: '#ff6a3d', color: '#ffffff' } },
  { id: 'boxed', label: 'טקסט על רקע', sample: 'טקסט על רקע', style: { size: 64, y: 0.8, bg: '#000000' } },
  { id: 'tag', label: 'תווית צבעונית', sample: 'תווית', style: { size: 60, y: 0.15, bg: '#ff6a3d', color: '#ffffff' } },
  { id: 'highlight', label: 'מרקר', sample: 'חשוב לדעת', style: { size: 70, y: 0.6, bold: true, bg: '#ffe500', color: '#111111' } },
  { id: 'quote', label: 'ציטוט', sample: '"משפט שנשאר בראש"', style: { size: 76, y: 0.5, bold: false, font: 'Times New Roman', color: '#fff7e0' } },
];

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
