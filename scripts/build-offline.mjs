import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
(async () => {
  const root = path.join(process.cwd(), '.next', 'static');
  const paths = await readdir(root, { recursive: true, withFileTypes: true });
  const assets = paths.filter(e => e.isFile()).map(e => '/_next/static/' + path.relative(root, path.join(e.parentPath, e.name)).replaceAll('\\', '/'));
  const build = (await readFile('.next/BUILD_ID', 'utf8')).trim();
  await writeFile('public/sw-assets.js', `self.AZIZ_BUILD=${JSON.stringify(build)};self.AZIZ_ASSETS=${JSON.stringify(assets)};\n`);
  console.log(`Prepared ${assets.length} offline assets for build ${build}.`);
})().catch(e => { console.error(e); process.exitCode = 1; });
