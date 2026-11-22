/**
 * A local stand-in for the outside services the app talks to (Google Fonts, the stock sites and the AI
 * services in mock-ai.ts), so the tests never go to the internet. The test instance points at it through the
 * environment (scripts/test-server.mjs); the real app always uses the fixed public hosts.
 *   startMock(5191) -> { close, hits }
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { handleAi, isAiPath, type AiRequest } from './mock-ai';

const ROOT = path.resolve(import.meta.dirname, '..');
const FONTS = path.join(ROOT, 'node_modules', '@fontsource', 'assistant', 'files');

export interface Mock {
  base: string;
  hits: string[];
  close(): Promise<void>;
  /** Files the stock answers point at (served from here). */
  files: Record<string, { type: string; body: Buffer }>;
  /** Every request to the AI services, with its body (scripts/mock-ai.ts). */
  ai: AiRequest[];
}

export function startMock(port = 5191, media: Record<string, { type: string; body: Buffer }> = {}): Promise<Mock> {
  const base = `http://127.0.0.1:${port}`;
  const hits: string[] = [];
  const ai: AiRequest[] = [];
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', base);
    hits.push(`${req.method} ${u.pathname}${u.search} ${req.headers.authorization ? 'auth:' + req.headers.authorization.slice(0, 12) : ''}`.trim());
    // ---- AI services (transcription, chat models, narration) ----
    if (isAiPath(u.pathname)) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          if (!handleAi(req, res, u, Buffer.concat(chunks), ai)) json(res, 404, { error: 'not found' });
        } catch (e) {
          json(res, 500, { error: String((e as Error).message) });
        }
      });
      return;
    }
    // ---- Google Fonts ----
    if (u.pathname === '/css2') {
      const fam = (u.searchParams.get('family') ?? '').split(':')[0];
      if (fam !== 'Mock Sans') return json(res, 400, { error: 'unknown family' });
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end(
        ['400', '700']
          .map((w) => `@font-face {\n  font-family: 'Mock Sans';\n  font-style: normal;\n  font-weight: ${w};\n  src: url(${base}/s/mocksans/v1/${w}.ttf) format('truetype');\n}`)
          .join('\n') +
          // a face on another host must be ignored
          `\n@font-face { font-family: 'Mock Sans'; font-weight: 900; src: url(http://example.invalid/evil.ttf) format('truetype'); }\n`,
      );
    }
    const font = /^\/s\/mocksans\/v1\/(400|700)\.ttf$/.exec(u.pathname);
    if (font) {
      res.writeHead(200, { 'Content-Type': 'font/ttf' });
      return res.end(fs.readFileSync(path.join(FONTS, `assistant-latin-${font[1]}-normal.woff`)));
    }
    // ---- stock ----
    if (u.pathname === '/openverse/v1/images/' || u.pathname === '/openverse/v1/audio/') {
      const audio = u.pathname.includes('audio');
      return json(res, 200, {
        result_count: 1,
        results: [
          audio
            ? { id: 'ov-a1', title: 'Mock tune', creator: 'Mock Artist', license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', foreign_landing_url: 'https://example.org/tune', url: `${base}/files/tune.mp3`, duration: 3000, filetype: 'mp3' }
            : { id: 'ov-i1', title: 'Mock picture', creator: 'Mock Photographer', license: 'by-sa', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', foreign_landing_url: 'https://example.org/pic', url: `${base}/files/pic.png`, thumbnail: `${base}/files/pic.png`, width: 320, height: 180 },
        ],
      });
    }
    if (u.pathname === '/pexels/v1/search' || u.pathname === '/pexels/videos/search') {
      if (req.headers.authorization !== 'test-pexels-key-1234') return json(res, 401, { error: 'bad key' });
      if (u.pathname.includes('videos'))
        return json(res, 200, { videos: [{ id: 11, url: 'https://www.pexels.com/video/11/', width: 320, height: 180, duration: 2, image: `${base}/files/pic.png`, user: { name: 'Mock Filmer', url: 'https://www.pexels.com/@mock' }, video_files: [{ link: `${base}/files/clip.mp4`, width: 320, height: 180, file_type: 'video/mp4', quality: 'sd' }] }] });
      return json(res, 200, { photos: [{ id: 12, url: 'https://www.pexels.com/photo/12/', width: 320, height: 180, alt: 'Mock photo', photographer: 'Mock Shooter', photographer_url: 'https://www.pexels.com/@shooter', src: { large: `${base}/files/pic.png`, medium: `${base}/files/pic.png`, tiny: `${base}/files/pic.png` } }] });
    }
    if (u.pathname === '/pixabay/api/' || u.pathname === '/pixabay/api/videos/') {
      if (u.searchParams.get('key') !== 'test-pixabay-key-5678') return json(res, 400, { error: 'bad key' });
      if (u.pathname.includes('videos'))
        return json(res, 200, { hits: [{ id: 21, pageURL: 'https://pixabay.com/videos/21/', tags: 'mock, clip', duration: 2, user: 'MockUser', videos: { small: { url: `${base}/files/clip.mp4`, width: 320, height: 180, thumbnail: `${base}/files/pic.png` } } }] });
      return json(res, 200, { hits: [{ id: 22, pageURL: 'https://pixabay.com/photos/22/', tags: 'mock, photo', user: 'MockUser', webformatURL: `${base}/files/pic.png`, previewURL: `${base}/files/pic.png`, largeImageURL: `${base}/files/pic.png`, imageWidth: 320, imageHeight: 180 }] });
    }
    // ---- for the downloader's own tests ----
    if (u.pathname === '/redirect') {
      res.writeHead(302, { Location: u.searchParams.get('to') ?? '/' });
      return res.end();
    }
    if (u.pathname === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html></html>');
    }
    const file = /^\/files\/([\w.-]+)$/.exec(u.pathname);
    if (file && media[file[1]]) {
      res.writeHead(200, { 'Content-Type': media[file[1]].type, 'Content-Length': media[file[1]].body.length });
      return res.end(media[file[1]].body);
    }
    json(res, 404, { error: 'not found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        base,
        hits,
        files: media,
        ai,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}
