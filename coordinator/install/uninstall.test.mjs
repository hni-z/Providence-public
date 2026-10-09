import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { registerUninstaller, revokeOwnDevice, uninstall, removeOwnedPlan, windowsUninstallEntry, writeWindowsCleanupPlan, within } from './uninstall.mjs';

function write(path, text) { mkdirSync(dirname(path), {recursive:true,mode:0o700}); writeFileSync(path,text,{mode:0o600}); }
function fixture({ registered = true, config = true } = {}) {
  const home = mkdtempSync(join(tmpdir(),'providence-remove-'));
  const installation = join(home,'.providence/installation'), companion = join(home,'.providence/companion');
  const release = join(installation,'releases','a'.repeat(64));
  const runtime = join(installation,`runtimes/node-v22.23.3-${process.platform === 'win32' ? 'win' : process.platform}-arm64`);
  const execPath = join(runtime, process.platform === 'win32' ? 'node.exe' : 'bin/node');
  write(join(release,'.providence-manifest.json'),JSON.stringify({version:'a'.repeat(64),archiveZipSha256:'b'.repeat(64),archiveTarGzSha256:'c'.repeat(64)}));
  write(join(release,'.providence-archive-sha256'),'c'.repeat(64));
  write(join(release,'coordinator/install/uninstall.mjs'),'fixture-owned-source');
  write(join(release,'coordinator/node_modules/dependency/index.js'),'fixture-locked-dependency');
  write(execPath,'fixture-private-node');
  write(join(runtime,'.providence-archive-sha256'),'d'.repeat(64));
  const workspace=join(home,'ProvidenceWorkspace'); write(join(workspace,'important.md'),'user document');
  write(join(home,'.codex/auth.json'),'fixture-existing-user-auth');
  mkdirSync(companion,{recursive:true,mode:0o700});
  const device = { deviceId:'device-fixture',token:'e'.repeat(64),url:'wss://providence.hani.so/worker',workspace,keepAwake:false };
  if(config)write(join(companion,'device.json'),JSON.stringify(device));
  if(registered)registerUninstaller({home,releaseDirectory:release,execPath});
  return {home,installation,companion,release,runtime,execPath,workspace,device};
}
const confirmed = async (_url, options) => ({status:200,json:async()=>({revoked:true,deviceId:JSON.parse(options.body).deviceId})});
const gone = () => { throw Object.assign(new Error('gone'),{code:'ESRCH'}); };
const options = f => ({home:f.home,yes:true,fetcher:confirmed,probe:gone,wait:async()=>{},env:{}});

test('registration saves uninstall before account setup and inventories locked dependencies', () => {
  const f=fixture({config:false});
  try {
    const entry=process.platform==='win32'?'uninstall.ps1':'uninstall';
    assert.ok(existsSync(join(f.companion,entry)));
    const registry=JSON.parse(readFileSync(join(f.installation,'.providence-owned.json'),'utf8'));
    assert.ok(registry.trees.find(tree=>tree.root.startsWith('releases/')).files.some(file=>file.path==='coordinator/node_modules/dependency/index.js'));
    assert.equal(existsSync(join(f.companion,'device.json')),false);
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('successful local uninstall preserves user Codex authentication, workspace, and other Providence folders', async () => {
  const f=fixture();
  try {
    write(join(f.home,'.providence/other-project/state.json'),'unrelated');
    const result=await uninstall(options(f));
    assert.equal(result.removed,true);assert.equal(result.revocation,'confirmed');
    assert.equal(existsSync(f.installation),false);assert.equal(existsSync(f.companion),false);
    assert.equal(readFileSync(join(f.home,'.codex/auth.json'),'utf8'),'fixture-existing-user-auth');
    assert.equal(readFileSync(join(f.workspace,'important.md'),'utf8'),'user document');
    assert.equal(readFileSync(join(f.home,'.providence/other-project/state.json'),'utf8'),'unrelated');
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('cancelled setup can be uninstalled without contacting a provider', async () => {
  const f=fixture({config:false});
  try {
    const result=await uninstall({...options(f),fetcher:()=>assert.fail('no enrollment exists')});
    assert.equal(result.removed,true);assert.equal(result.revocation,'not-needed');
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('declining confirmation changes nothing and makes no network request', async () => {
  const f=fixture();
  try {
    const before=readFileSync(join(f.installation,'.providence-owned.json'));
    const result=await uninstall({...options(f),yes:false,ask:async()=>false,fetcher:()=>assert.fail('not confirmed')});
    assert.equal(result.reason,'cancelled');assert.deepEqual(readFileSync(join(f.installation,'.providence-owned.json')),before);
    assert.ok(existsSync(join(f.companion,'device.json')));
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('offline removal requires a separate acknowledgement and remains remotely unconfirmed', async () => {
  const f=fixture();let asked=0;
  try {
    const offline=async()=>{throw new Error('network unavailable');};
    const held=await uninstall({...options(f),fetcher:offline,askOffline:async()=>{asked++;return false;}});
    assert.equal(held.reason,'offline_not_confirmed');assert.equal(asked,1);assert.ok(existsSync(join(f.companion,'device.json')));
    const removed=await uninstall({...options(f),fetcher:offline,allowOffline:true,askOffline:()=>assert.fail('explicit offline flag')});
    assert.equal(removed.removed,true);assert.equal(removed.revocation,'unconfirmed');
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('unknown background stop preserves all local ownership and credentials', async () => {
  const f=fixture();
  try {
    write(join(f.companion,'device.json.background.json'),'{}');
    const before=readFileSync(join(f.installation,'.providence-owned.json'));
    const result=await uninstall({...options(f),manage:async()=>({installed:true,running:null,stopConfirmed:false})});
    assert.equal(result.removed,false);assert.equal(result.reason,'stop_unconfirmed');
    assert.deepEqual(readFileSync(join(f.installation,'.providence-owned.json')),before);
    assert.deepEqual(JSON.parse(readFileSync(join(f.companion,'device.json'),'utf8')),f.device);
    assert.ok(existsSync(f.execPath));assert.ok(existsSync(f.release));
    assert.equal(existsSync(join(f.installation,'.uninstall-lock')),false);
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('a live or ambiguous foreground lock prevents local deletion', async () => {
  const f=fixture();
  try {
    write(join(f.companion,'device.json.lock'),JSON.stringify({pid:process.pid,childPid:process.pid}));
    const result=await uninstall({...options(f),probe:()=>{}});
    assert.equal(result.reason,'stop_unconfirmed');assert.ok(existsSync(f.release));
    assert.ok(existsSync(join(f.companion,'device.json.lock')));
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('unlisted or modified files are preserved and not silently adopted on installer rerun', async () => {
  const f=fixture();
  try {
    write(join(f.release,'notes.md'),'new personal notes');
    write(join(f.release,'coordinator/install/uninstall.mjs'),'user-modified-source');
    write(join(f.installation,'unrelated.txt'),'unrelated');
    write(join(f.companion,'notes.md'),'companion notes');
    registerUninstaller({home:f.home,releaseDirectory:f.release,execPath:f.execPath});
    const result=await uninstall(options(f));
    assert.equal(result.removed,true);assert.equal(result.reason,'removed_with_preserved_files');
    assert.equal(readFileSync(join(f.release,'notes.md'),'utf8'),'new personal notes');
    assert.equal(readFileSync(join(f.release,'coordinator/install/uninstall.mjs'),'utf8'),'user-modified-source');
    assert.equal(readFileSync(join(f.companion,'notes.md'),'utf8'),'companion notes');
    assert.equal(readFileSync(join(f.installation,'unrelated.txt'),'utf8'),'unrelated');
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('a registered release cache removes changed and new npm files while preserving unknown siblings and user work', async () => {
  const f=fixture({registered:false});
  try{
    const cache=join(f.release,'coordinator/.npm-cache');
    write(join(cache,'_logs/old.log'),'original npm log');
    registerUninstaller({home:f.home,releaseDirectory:f.release,execPath:f.execPath});
    write(join(cache,'_logs/old.log'),'later npm log');
    write(join(cache,'_logs/new.log'),'new npm log');
    write(join(cache,'_cacache/content/entry'),'later cached content');
    write(join(f.release,'coordinator/user-notes/keep.txt'),'user notes');
    let plan;
    await uninstall({...options(f),platform:'win32',prepareWindows:async value=>{plan=value;}});
    const cacheFiles=plan.files.filter(item=>item.path.includes('/coordinator/.npm-cache/'));
    assert.equal(cacheFiles.length,3);
    assert.equal(new Set(cacheFiles.map(item=>item.path)).size,3);
    assert.ok(!plan.preserved.some(path=>path.includes('.npm-cache')));
    const preserved=removeOwnedPlan(plan);
    assert.equal(existsSync(cache),false);
    assert.equal(readFileSync(join(f.release,'coordinator/user-notes/keep.txt'),'utf8'),'user notes');
    assert.ok(preserved.some(path=>path===f.release));
    assert.equal(readFileSync(join(f.workspace,'important.md'),'utf8'),'user document');
    assert.equal(readFileSync(join(f.home,'.codex/auth.json'),'utf8'),'fixture-existing-user-auth');
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('an npm-named directory absent from the original ownership inventory is not adopted', async () => {
  const f=fixture();
  try{
    const unowned=join(f.release,'coordinator/.npm-cache/keep.txt');
    write(unowned,'not registered cache');
    await uninstall(options(f));
    assert.equal(readFileSync(unowned,'utf8'),'not registered cache');
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('registered cache links are refused without following their workspace target', {skip:process.platform==='win32'}, async () => {
  const f=fixture({registered:false});
  try{
    const cache=join(f.release,'coordinator/.npm-cache');write(join(cache,'_logs/old.log'),'npm log');
    registerUninstaller({home:f.home,releaseDirectory:f.release,execPath:f.execPath});
    symlinkSync(f.workspace,join(cache,'external'));
    await assert.rejects(uninstall(options(f)),/cache.*link|unsafe/);
    assert.equal(readFileSync(join(f.workspace,'important.md'),'utf8'),'user document');
    assert.ok(existsSync(f.execPath));
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('protected workspace or credential directories inside companion state block cleanup', async () => {
  for(const key of ['workspace','transcriptionEnvFile']){
    const f=fixture();
    try{
      const changed={...f.device,[key]:f.companion};write(join(f.companion,'device.json'),JSON.stringify(changed));
      await assert.rejects(uninstall({...options(f),fetcher:()=>assert.fail('unsafe layout must stop before revoke')}),/overlaps companion state/);
      assert.ok(existsSync(f.execPath));
    }finally{rmSync(f.home,{recursive:true,force:true});}
  }
});

test('symlinks inside an owned package are unlinked without touching their destination', {skip:process.platform==='win32'}, async () => {
  const f=fixture({registered:false});
  try{
    const outside=join(f.workspace,'important.md');symlinkSync(outside,join(f.release,'external-link'));
    registerUninstaller({home:f.home,releaseDirectory:f.release,execPath:f.execPath});
    const result=await uninstall(options(f));assert.equal(result.removed,true);
    assert.equal(readFileSync(outside,'utf8'),'user document');
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('replacing an owned package directory with a symlink cannot escape the root', {skip:process.platform==='win32'}, async () => {
  const f=fixture();
  try{
    rmSync(f.release,{recursive:true});symlinkSync(f.workspace,f.release);
    await assert.rejects(uninstall(options(f)),/unsafe|outside/);
    assert.equal(readFileSync(join(f.workspace,'important.md'),'utf8'),'user document');
    assert.ok(existsSync(join(f.companion,'device.json')));
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('provider revocation is canonical, no-redirect, exact-device and never inferred from rejection', async () => {
  const f=fixture();
  try{
    let calls=0;
    assert.equal(await revokeOwnDevice(f.device,async(url,request)=>{
      calls++;assert.equal(url,'https://providence.hani.so/device/revoke');assert.equal(request.redirect,'error');
      assert.equal(request.headers.Authorization,`Bearer ${f.device.token}`);assert.equal(request.headers.Origin,undefined);assert.equal(request.headers.Cookie,undefined);
      assert.deepEqual(JSON.parse(request.body),{deviceId:f.device.deviceId});return{status:401,json:async()=>({revoked:false})};
    }),'unconfirmed');
    assert.equal(await revokeOwnDevice({...f.device,url:'wss://attacker.invalid/worker'},()=>assert.fail('must not send credential')),'unconfirmed');
    assert.equal(calls,1);
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('Windows preparation leaves ownership locked for its foreground controller and contains no device token', async () => {
  const f=fixture();let plan;
  try{
    const result=await uninstall({...options(f),platform:'win32',prepareWindows:async value=>{plan=value; await writeWindowsCleanupPlan(value);}});
    assert.equal(result.removed,false);assert.equal(result.reason,'cleanup_prepared');
    assert.ok(existsSync(f.execPath));assert.ok(existsSync(join(f.companion,'device.json')));
    assert.ok(existsSync(join(f.installation,'.uninstall-lock')));
    assert.ok(!JSON.stringify(plan).includes(f.device.token));
    assert.deepEqual(JSON.parse(readFileSync(join(f.installation,'.uninstall-plan.json'),'utf8')), plan);
    assert.ok(plan.files.some(entry=>entry.path.endsWith('/bin/node')||entry.path.endsWith('/node.exe')));
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('Windows foreground controller checks parent and child exit, hashes, locks and reparse points before deletion',()=>{
  const script=readFileSync(new URL('./uninstall-windows.ps1',import.meta.url),'utf8');
  assert.ok(script.includes('& $NodePath $ModulePath @arguments'));
  assert.ok(script.indexOf('if ($LASTEXITCODE -ne 0)')<script.indexOf('Remove-Item -Force -LiteralPath $file'));
  assert.ok(script.includes('Assert-RetiredProcess $Plan.parentPid'));
  assert.ok(script.includes("'ParentProcessId=' + $OwnerPid"));
  assert.ok(script.includes('Assert-CompanionsStopped'));
  assert.ok(script.includes('Assert-NoInstall'));
  assert.ok(script.includes('ReparsePoint'));assert.ok(script.includes('Get-FileHash'));
  assert.ok(script.includes('[IO.Directory]::Delete($directory, $false)'));
  assert.ok(!script.includes('-Recurse'));assert.ok(!script.includes('Stop-Process'));
  assert.ok(script.includes('exit $cleanupExitCode'));
});

test('Windows saved PowerShell entry loads the controller into memory and propagates status without batch or policy changes',()=>{
  const text=windowsUninstallEntry('C:\\User%TEMP%!\\node.exe',"C:\\User's\\uninstall.mjs","C:\\User's\\uninstall-windows.ps1");
  assert.ok(text.startsWith('param([switch]$Yes, [switch]$AllowOffline)'));
  assert.ok(text.includes('User%TEMP%!')); assert.ok(text.includes("User''s"));
  assert.ok(text.includes('[scriptblock]::Create([IO.File]::ReadAllText('));
  assert.ok(text.includes("$ErrorActionPreference='Stop'"));
  assert.ok(text.endsWith('exit $LASTEXITCODE\r\n'));
  assert.ok(!text.includes('.cmd')); assert.ok(!text.includes('exit /b'));
  assert.ok(!text.includes('ExecutionPolicy')); assert.ok(!text.includes('Start-Process'));
  assert.throws(()=>windowsUninstallEntry('bad\npath','module','helper'),/Unsafe/);
});

test('Windows plan collision is preserved and cannot be mistaken for cleanup completion',async()=>{
  const f=fixture();
  try{
    write(join(f.installation,'.uninstall-plan.json'),'existing-plan');
    await assert.rejects(uninstall({...options(f),platform:'win32'}),/exist/i);
    assert.equal(readFileSync(join(f.installation,'.uninstall-plan.json'),'utf8'),'existing-plan');
    assert.ok(existsSync(f.execPath));assert.ok(existsSync(join(f.companion,'device.json')));
  }finally{rmSync(f.home,{recursive:true,force:true});}
});

test('Windows protected paths compare case-insensitively with directory boundaries',()=>{
  assert.equal(within('C:\\Users\\EXAMPLE\\.PROVIDENCE\\companion\\device.json','c:\\users\\example\\.providence\\companion','win32'),true);
  assert.equal(within('C:\\Users\\example\\.providence\\companion-not-owned','c:\\users\\example\\.providence\\companion','win32'),false);
});
