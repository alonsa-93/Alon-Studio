import { useSyncExternalStore } from 'react';
import { api } from './store';

/**
 * Fonts the user added (uploads and Google Fonts). The files are the same TTF / OTF the export gives
 * libass, loaded here with the FontFace API so the player shows exactly what the export burns in.
 */
export interface FontFamilyInfo {
  family: string;
  source: 'upload' | 'google';
  faces: { id: string; weight: number; italic: boolean; url: string }[];
}

let list: FontFamilyInfo[] = [];
const subs = new Set<() => void>();
const loaded = new Map<string, FontFace>();

function apply(next: FontFamilyInfo[]) {
  if (!Array.isArray(next)) return;
  const keep = new Set<string>();
  for (const fam of next)
    for (const f of fam.faces) {
      keep.add(f.id);
      if (loaded.has(f.id) || typeof FontFace === 'undefined') continue;
      const face = new FontFace(fam.family, `url(${f.url})`, { weight: String(f.weight), style: f.italic ? 'italic' : 'normal' });
      document.fonts.add(face);
      void face.load().catch(() => {});
      loaded.set(f.id, face);
    }
  for (const [id, face] of loaded)
    if (!keep.has(id)) {
      document.fonts.delete(face);
      loaded.delete(id);
    }
  list = next;
  subs.forEach((fn) => fn());
}

export async function refreshFonts() {
  try {
    apply(await api<FontFamilyInfo[]>('/api/fonts'));
  } catch {
    /* the list stays as it was; the built-in fonts still work */
  }
}

export const setFonts = (next: FontFamilyInfo[]) => apply(next);

export function useFonts(): FontFamilyInfo[] {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => list,
  );
}
