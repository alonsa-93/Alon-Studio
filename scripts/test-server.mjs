// Isolated test instance: port 5182 and a throwaway data folder, so tests never touch real projects.
//   node scripts/test-server.mjs
// Override with PORT / ALON_DATA_DIR. The access key for tests is read from <data>/access-key.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const env = {
  ...process.env,
  PORT: process.env.PORT ?? '5182',
  ALON_DATA_DIR: process.env.ALON_DATA_DIR ?? path.join(os.tmpdir(), 'alon-test-data'),
  // outside services go to the local mock the tests start (scripts/mock-providers.ts), never to the internet
  ALON_GOOGLE_FONTS_CSS: process.env.ALON_GOOGLE_FONTS_CSS ?? 'http://127.0.0.1:5191',
  ALON_GOOGLE_FONTS_FILES: process.env.ALON_GOOGLE_FONTS_FILES ?? 'http://127.0.0.1:5191',
  ALON_STOCK_BASE: process.env.ALON_STOCK_BASE ?? 'http://127.0.0.1:5191',
  ALON_AI_BASE: process.env.ALON_AI_BASE ?? 'http://127.0.0.1:5191',
};
delete env.ALON_OPEN;
console.log(`test instance: http://localhost:${env.PORT}  data: ${env.ALON_DATA_DIR}`);
const child = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts'], { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());
