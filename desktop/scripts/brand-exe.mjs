/**
 * Put the application icon and version metadata into a Windows executable.
 *
 * electron-builder normally does this with `rcedit`, which is a Windows binary it
 * runs under a bundled x86_64 wine - so on Apple silicon without Rosetta it
 * cannot run at all, and the Windows build stops before it starts. This does the
 * same job by editing the PE resource directory directly, in JavaScript, which
 * works on any host.
 *
 *   node scripts/brand-exe.mjs "release/win-unpacked/openDAQ Viewer.exe"
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON = join(HERE, '..', 'build', 'icon.ico');

// US English, Unicode - what Windows Explorer reads by default.
const LANGUAGE = 1033;
const CODEPAGE = 1200;

const target = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('usage: node scripts/brand-exe.mjs <path to .exe>');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const executable = NtExecutable.from(readFileSync(target));
const resources = NtExecutableResource.from(executable);

const icon = Data.IconFile.from(readFileSync(ICON));
Resource.IconGroupEntry.replaceIconsForResource(
  resources.entries,
  1,
  LANGUAGE,
  icon.icons.map((item) => item.data),
);

const [versionInfo] = Resource.VersionInfo.fromEntries(resources.entries);
versionInfo.setFileVersion(major, minor, patch, 0, LANGUAGE);
versionInfo.setProductVersion(major, minor, patch, 0, LANGUAGE);
versionInfo.setStringValues(
  { lang: LANGUAGE, codepage: CODEPAGE },
  {
    ProductName: 'openDAQ Viewer',
    FileDescription: 'openDAQ Viewer',
    CompanyName: 'openDAQ Viewer contributors',
    LegalCopyright: 'openDAQ Viewer contributors',
    OriginalFilename: 'openDAQ Viewer.exe',
    InternalName: 'openDAQ Viewer',
  },
);
versionInfo.outputToResourceEntries(resources.entries);

resources.outputResource(executable);
writeFileSync(target, Buffer.from(executable.generate()));

console.log(`branded ${target}`);
console.log(`  icon: ${icon.icons.length} sizes from build/icon.ico`);
console.log(`  version: ${pkg.version}`);
