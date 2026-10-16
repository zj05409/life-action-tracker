import { mkdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['index.html', 'styles.css', 'app.js', 'state.js', 'gestures.js', 'assets/guide-data.js', 'favicon.svg', 'manifest.webmanifest', 'CONTENT-LICENSE.txt'];
await rm(path.join(root, 'dist'), { recursive: true, force: true });
await mkdir(path.join(root, 'dist', 'assets'), { recursive: true });
const hash = createHash('sha256');
for (const file of files) {
  hash.update(await readFile(path.join(root, file)));
  await copyFile(path.join(root, file), path.join(root, 'dist', file));
}
const version = hash.digest('hex').slice(0, 16);
const sw = (await readFile(path.join(root, 'sw.js'), 'utf8')).replace('life-in-progress-source-v1', `life-in-progress-${version}`);
await writeFile(path.join(root, 'dist', 'sw.js'), sw);
await writeFile(path.join(root, 'dist', '.nojekyll'), '');
console.log(`Built static site: dist/ (cache ${version})`);
