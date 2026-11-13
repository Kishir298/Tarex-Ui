import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseVersion, mergeManifests, validateSignature} from './release.mjs';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('CI versions advance and remain valid Windows installer versions',()=>{
  assert.equal(releaseVersion('0.10.0',6),'0.10.6');
  assert.equal(releaseVersion('0.10.0',7),'0.10.7');
  assert.throws(()=>releaseVersion('0.10.0',65536));
  assert.throws(()=>releaseVersion('0.10.0','invalid'));
});
test('publication requires all platforms with version-bound signature metadata and this release URL',()=>{
  const version='0.10.6',repo='owner/repo',tag='build-6-1';
  const signature=Buffer.from(`untrusted comment: fixture\nsignature\ntrusted comment: timestamp:1\tfile:fixture\tversion:${version}\nsignature`).toString('base64');
  const targets=['darwin-aarch64','darwin-x86_64','linux-x86_64','windows-x86_64','windows-x86_64-msi','windows-x86_64-nsis'];
  const fragments=targets.map(target=>({version,platforms:{[target]:{url:`https://github.com/${repo}/releases/download/${tag}/${target}`,signature}}}));
  assert.equal(Object.keys(mergeManifests(fragments,version,repo,tag).platforms).length,6);
  assert.throws(()=>mergeManifests(fragments.slice(1),version,repo,tag));
  assert.throws(()=>mergeManifests([...fragments,fragments[0]],version,repo,tag));
  assert.throws(()=>mergeManifests(fragments,version,repo,'different-tag'));
  assert.throws(()=>validateSignature(signature,'0.10.7'));
});

test('stamping keeps app, Cargo workspace, lockfile and CI versions identical',()=>{
  const directory=mkdtempSync(join(tmpdir(),'tarex-release-'));
  try {
    mkdirSync(join(directory,'src-tauri'));
    writeFileSync(join(directory,'package.json'),JSON.stringify({version:'0.10.0'}));
    writeFileSync(join(directory,'src-tauri/tauri.conf.json'),JSON.stringify({version:'0.10.0'}));
    writeFileSync(join(directory,'src-tauri/Cargo.toml'),'[package]\r\nname = "tarex"\r\nversion = "0.10.0"\r\n[workspace.package]\r\nversion = "0.10.0"\r\n');
    writeFileSync(join(directory,'src-tauri/Cargo.lock'),['tarex','tarex-cli','tarex-control-protocol'].map(name=>`[[package]]\r\nname = "${name}"\r\nversion = "0.10.0"\r\n`).join('\r\n'));
    const environment=join(directory,'environment');
    execFileSync(process.execPath,[fileURLToPath(new URL('./release.mjs',import.meta.url)),'stamp'],{cwd:directory,env:{...process.env,GITHUB_RUN_NUMBER:'6',GITHUB_ENV:environment}});
    assert.equal(JSON.parse(readFileSync(join(directory,'package.json'))).version,'0.10.6');
    assert.equal(JSON.parse(readFileSync(join(directory,'src-tauri/tauri.conf.json'))).version,'0.10.6');
    assert.equal((readFileSync(join(directory,'src-tauri/Cargo.lock'),'utf8').match(/version = "0.10.6"/g)||[]).length,3);
    assert.equal((readFileSync(join(directory,'src-tauri/Cargo.toml'),'utf8').match(/version = "0.10.6"/g)||[]).length,2);
    assert.equal(readFileSync(environment,'utf8'),'TAREX_RELEASE_VERSION=0.10.6\n');
  } finally {rmSync(directory,{recursive:true,force:true});}
});
