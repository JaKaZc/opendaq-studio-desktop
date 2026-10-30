// electron-builder afterPack hook.
//
// `electronLanguages` trims the language packs on Windows and Linux, but on
// macOS Chromium keeps them inside the Electron framework, where the option
// does not reach: 54 folders and about 30 MB that an English-only UI never
// loads. This keeps en.lproj and removes the rest, before the app is signed.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources');
  if (!fs.existsSync(resources)) return;
  let removed = 0;
  for (const entry of fs.readdirSync(resources)) {
    if (!entry.endsWith('.lproj') || entry === 'en.lproj') continue;
    fs.rmSync(path.join(resources, entry), { recursive: true, force: true });
    removed += 1;
  }
  console.log(`  • afterPack  removed ${removed} Electron language packs, kept en.lproj`);
};
