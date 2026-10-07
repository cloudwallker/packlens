import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { RuntimeProfile } from './model.ts';
export const require = createRequire(import.meta.url);
const expected: Record<string, string> = { '@npmcli/arborist': '10.0.3', 'npm-packlist': '11.3.0', 'ignore-walk': '9.0.0' };
const expectedHashes: Record<string,string> = { 'npm-packlist':'5d0f84da339159590d746d343d12cb7708add8ffc96841002fc67e87fd714505', 'ignore-walk':'10610ac2fdc62669c21893f3ff772f2dc8b5831b54d80040629a121aae70c0d6' };
function packagePath(name: string, loader = require): string { let dir = dirname(loader.resolve(name)); for (;;) { try { const path = join(dir, 'package.json'); if (JSON.parse(readFileSync(path, 'utf8')).name === name) return path; } catch {} const parent = dirname(dir); if (parent === dir) throw new Error('PROFILE_UNAVAILABLE'); dir = parent; } }
export function runtimeProfile(): RuntimeProfile {
  const versions: Record<string, string> = {}; const cliVersions: Record<string, string> = {};
  const sourceHashes = Object.fromEntries(Object.keys(expectedHashes).map(name => [name,createHash('sha256').update(readFileSync(require.resolve(name))).digest('hex')]));
  for (const name of Object.keys(expected)) versions[name] = JSON.parse(readFileSync(packagePath(name), 'utf8')).version;
  const packRequire = createRequire(packagePath('npm-packlist'));
  versions.glob = JSON.parse(readFileSync(packagePath('glob', packRequire), 'utf8')).version;
  const ignoreRequire = createRequire(packagePath('ignore-walk', packRequire));
  versions.minimatch = JSON.parse(readFileSync(packagePath('minimatch', ignoreRequire), 'utf8')).version;
  const arboristRequire=createRequire(packagePath('@npmcli/arborist'));
  const pkgPath=packagePath('@npmcli/package-json',arboristRequire);
  versions['@npmcli/package-json']=JSON.parse(readFileSync(pkgPath,'utf8')).version;
  versions['npm-normalize-package-bin']=JSON.parse(readFileSync(packagePath('npm-normalize-package-bin',createRequire(pkgPath)),'utf8')).version;
  try {
    const cliPath = packagePath('npm'); cliVersions.npm = JSON.parse(readFileSync(cliPath, 'utf8')).version;
    const cliRequire = createRequire(cliPath);
    for (const name of Object.keys(expected)) cliVersions[name] = JSON.parse(readFileSync(packagePath(name, cliRequire), 'utf8')).version;
    const cliPack = createRequire(packagePath('npm-packlist', cliRequire));
    cliVersions.glob = JSON.parse(readFileSync(packagePath('glob', cliPack), 'utf8')).version;
    cliVersions.minimatch = JSON.parse(readFileSync(packagePath('minimatch', createRequire(packagePath('ignore-walk', cliPack))), 'utf8')).version;
    const cliPkgPath=packagePath('@npmcli/package-json',cliRequire);
    cliVersions['@npmcli/package-json']=JSON.parse(readFileSync(cliPkgPath,'utf8')).version;
    cliVersions['npm-normalize-package-bin']=JSON.parse(readFileSync(packagePath('npm-normalize-package-bin',createRequire(cliPkgPath)),'utf8')).version;
  } catch { /* npm CLI is a development oracle and is not required offline at runtime. */ }
  const profile: RuntimeProfile = { profileId: 'npm-single-package-v1', nodeVersion: process.versions.node, versions, cliVersions, sourceHashes, adapterVersion: 'packlens-recording-v1', supportedFeatures: ['standalone', 'nested-ignore', 'files-positive', 'files-negation', 'files-brace-glob', 'empty-files', 'forced-metadata', 'main-bin-browser'], lifecycleScripts: false, globalConfigApplied: false, standalone: true, matched: false };
  profile.matched = profileMatches(profile); return profile;
}
export function profileMatches(profile: RuntimeProfile): boolean { return profile.nodeVersion==='24.15.0' && Object.entries(expected).every(([k,v]) => profile.versions[k]===v) && profile.versions.glob==='13.0.6' && profile.versions.minimatch==='10.2.5' && profile.versions['@npmcli/package-json']==='8.0.0' && profile.versions['npm-normalize-package-bin']==='6.0.0' && Object.entries(expectedHashes).every(([k,v]) => profile.sourceHashes[k]===v); }
export async function rootNode(path: string, manifest: Record<string, unknown>): Promise<any> {
  const { Node } = require('@npmcli/arborist');
  const arboristRequire = createRequire(packagePath('@npmcli/arborist'));
  const PackageJson = arboristRequire('@npmcli/package-json');
  const pkg = new PackageJson().fromContent(structuredClone(manifest));
  // Node.syncNormalize skips the release's async bin step. Running only this
  // original in-memory step matches loadActual/CLI without filesystem reads.
  await pkg.normalize({ steps: ['bin'] });
  return new Node({ path, pkg: pkg.content });
}
