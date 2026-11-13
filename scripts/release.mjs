import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function releaseVersion(base, build) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/.exec(base);
  if (!match || !/^\d+$/.test(String(build))) throw new Error('Invalid release version or build number');
  const [major, minor, patch] = match.slice(1).map(Number);
  const next = patch + Number(build);
  if (Number(build) < 1 || major > 255 || minor > 255 || next > 65535) throw new Error('Version exceeds installer limits');
  return `${major}.${minor}.${next}`;
}

export function validateSignature(signature, version) {
  const decoded = Buffer.from(signature.trim(), 'base64').toString('utf8');
  const trusted = decoded.split(/\r?\n/).find(line => line.startsWith('trusted comment:'));
  if (!trusted?.split('\t').includes(`version:${version}`)) throw new Error('Artifact signature lacks the release version');
  return signature.trim();
}

export function mergeManifests(fragments, version, repo, tag) {
  const required = ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64', 'windows-x86_64-msi', 'windows-x86_64-nsis'];
  const platforms = {};
  const prefix = `https://github.com/${repo}/releases/download/${tag}/`;
  for (const fragment of fragments) {
    if (fragment.version !== version) throw new Error('Mixed release versions');
    for (const [target, asset] of Object.entries(fragment.platforms)) {
      if (platforms[target] || !asset.url.startsWith(prefix)) throw new Error('Duplicate target or unexpected artifact URL');
      platforms[target] = {url: asset.url, signature: validateSignature(asset.signature, version)};
    }
  }
  if (required.some(target => !platforms[target])) throw new Error('Release is missing an updater platform');
  return {version, notes: `Tarex UI ${version}. Updates are cryptographically signed.`, pub_date: new Date().toISOString(), platforms};
}

function files(directory) {
  return readdirSync(directory, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}

function main(mode) {
  const build = process.env.GITHUB_RUN_NUMBER;
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const repo = process.env.GITHUB_REPOSITORY;
  const tag = `build-${build}-${attempt}`;
  if (mode === 'stamp') {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const version = releaseVersion(pkg.version, build);
    pkg.version = version;
    writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    config.version = version;
    writeFileSync('src-tauri/tauri.conf.json', `${JSON.stringify(config, null, 2)}\n`);
    const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').replaceAll('\r\n','\n');
    if ((cargo.match(/^version = "[^"]+"$/gm)||[]).length !== 2) throw new Error('Unexpected Cargo version fields');
    const manifest = cargo.replace(/^version = "[^"]+"$/gm, `version = "${version}"`);
    writeFileSync('src-tauri/Cargo.toml', manifest);
    const lock = readFileSync('src-tauri/Cargo.lock', 'utf8').replaceAll('\r\n','\n').replace(/(\[\[package\]\]\nname = "(?:tarex|tarex-cli|tarex-control-protocol)"\nversion = ")[^"]+("\n)/g, (_match, start, end) => `${start}${version}${end}`);
    writeFileSync('src-tauri/Cargo.lock', lock);
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `TAREX_RELEASE_VERSION=${version}\n`);
    console.log(version);
    return;
  }
  const version = process.env.TAREX_RELEASE_VERSION || releaseVersion(JSON.parse(readFileSync('package.json', 'utf8')).version, build);
  if (!repo || !/^\d+$/.test(build) || !/^\d+$/.test(attempt)) throw new Error('Missing GitHub release context');
  const output = 'release-assets';
  if (mode === 'collect') {
    const target = process.env.TAREX_CLI_TARGET;
    const choices = {
      'aarch64-apple-darwin': [['dmg','.dmg'],['macos','.app.tar.gz','darwin-aarch64']],
      'x86_64-apple-darwin': [['dmg','.dmg'],['macos','.app.tar.gz','darwin-x86_64']],
      'x86_64-unknown-linux-gnu': [['deb','.deb'],['rpm','.rpm'],['appimage','.AppImage','linux-x86_64']],
      'x86_64-pc-windows-msvc': [['nsis','.exe','windows-x86_64-nsis'],['msi','.msi','windows-x86_64-msi']],
    }[target];
    if (!choices) throw new Error('Unknown build target');
    mkdirSync(output, {recursive:true});
    const platforms = {};
    for (const [directory, extension, platform] of choices) {
      const matches = files(join('src-tauri/target', target, 'release/bundle', directory)).filter(path => path.endsWith(extension));
      if (matches.length !== 1) throw new Error(`Expected one ${extension}, found ${matches.length}`);
      const name = `Tarex-UI-${target}${extension}`;
      const destination = join(output, name);
      copyFileSync(matches[0], destination);
      if (!platform) continue;
      // Sign the final bytes, including the post-processed AppImage.
      execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['tauri','signer','sign','--app-version',version,destination], {stdio:'pipe',shell:process.platform === 'win32'});
      const signature = validateSignature(readFileSync(`${destination}.sig`, 'utf8'), version);
      platforms[platform] = {url:`https://github.com/${repo}/releases/download/${tag}/${name}`,signature};
      if (platform === 'windows-x86_64-nsis') platforms['windows-x86_64'] = platforms[platform];
    }
    writeFileSync(join(output, `updater-${target}.json`), JSON.stringify({version,platforms}));
    return;
  }
  if (mode !== 'manifest') throw new Error('Usage: release.mjs stamp|collect|manifest');
  const fragments = readdirSync(output).filter(name => /^updater-.*\.json$/.test(name)).map(name => JSON.parse(readFileSync(join(output, name), 'utf8')));
  const manifest = mergeManifests(fragments, version, repo, tag);
  for (const asset of Object.values(manifest.platforms)) {
    if (!readdirSync(output).includes(decodeURIComponent(basename(new URL(asset.url).pathname)))) throw new Error('Manifest references a missing file');
  }
  writeFileSync(join(output,'latest.json'), `${JSON.stringify(manifest,null,2)}\n`);
  const sums = readdirSync(output).filter(name => name !== 'SHA256SUMS').sort().map(name => `${createHash('sha256').update(readFileSync(join(output,name))).digest('hex')}  ${name}`);
  writeFileSync(join(output,'SHA256SUMS'), `${sums.join('\n')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv[2]);
