/**
 * Inline SVG icons (feather-style strokes) so the UI doesn't depend on
 * platform emoji rendering.
 */

const wrap = (paths, size = 17) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" `
  + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" '
  + `stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  sound: wrap('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 6a9 9 0 0 1 0 12"/>'),
  wind: wrap('<path d="M4 8h9.5a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 12h14.5a2.5 2.5 0 1 1-2.5 2.5"/><path d="M5 16h5.5a2 2 0 1 1-2 2"/>'),
  book: wrap('<path d="M2 4.5h6.5A3.5 3.5 0 0 1 12 8v12.5a3 3 0 0 0-3-3H2z"/><path d="M22 4.5h-6.5A3.5 3.5 0 0 0 12 8v12.5a3 3 0 0 1 3-3h7z"/>'),
  download: wrap('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>', 15),
  trash: wrap('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 15),
  pencil: wrap('<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>', 20),
  close: wrap('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 15),
};
