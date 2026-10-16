"""Execute extracted release bootstraps against a Docker/download contract.

This tests actual macOS/Windows shells; it is not a claim of Docker Desktop UI testing.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
launcher = 'powershell' if os.name == 'nt' else 'bash'
payload = b'verified image archive fixture\n'

fake = r'''import sys,os,json,pathlib,hashlib
args=sys.argv[1:]
with open(os.environ['WA_TEST_LOG'],'a') as f:f.write(json.dumps(args)+'\n')
if args[0]=='info':
 print(os.environ.get('WA_TEST_ENGINE','linux/aarch64'));sys.exit(0)
if args[0]=='load':sys.exit(0)
if 'version' in args:sys.exit(0)
if 'ps' in args:
 print('runner' if os.environ.get('WA_TEST_EXISTING_RUNNER') else '');sys.exit(0)
if 'pull' in args:sys.exit(int(os.environ.get('WA_TEST_PULL_FAIL','0')))
if 'config' in args:
 for line in pathlib.Path('.compose.env').read_text().splitlines():
  if line.startswith(('WA_CONSOLE_IMAGE=','WA_RUNNER_IMAGE=')):print(line.split('=',1)[1])
 sys.exit(0)
if 'up' in args:sys.exit(int(os.environ.get('WA_TEST_UP_FAIL','0')))
sys.exit(0)
'''
fakecurl = r'''import sys,os,pathlib,hashlib
args=sys.argv[1:];url=next(x for x in args if x.startswith('https://'));dest=pathlib.Path(args[args.index('-o')+1]);data=b'verified image archive fixture\n'
assert ('linux-arm64' if os.environ.get('WA_TEST_ENGINE','linux/aarch64').endswith(('aarch64','arm64')) else 'linux-amd64') in url
if url.endswith('.sha256'):
 h='0'*64 if os.environ.get('WA_TEST_BAD_HASH') else hashlib.sha256(data).hexdigest()
 dest.write_text(h+'  '+url.split('/')[-1][:-7]+'\n')
else:dest.write_bytes(data)
'''
with tempfile.TemporaryDirectory(prefix='wa-launcher-contract-') as tmp:
    base = pathlib.Path(tmp)
    # A space in the extracted directory catches the desktop path quoting regression.
    bundles = base / 'bundles'
    subprocess.run([sys.executable, str(root/'scripts/package-release.py'), str(root), str(bundles)], check=True)
    archive = next(bundles.glob('*windows.zip' if os.name == 'nt' else '*macos.zip'))
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            assert not item.filename.startswith('/') and '..' not in pathlib.PurePosixPath(item.filename).parts
        z.extractall(base/'desktop install')
    work = next((base/'desktop install').iterdir())
    tools = base/'bin';tools.mkdir()
    (tools/'docker.py').write_text(fake)
    if os.name == 'nt':
        (tools/'docker.cmd').write_text('@echo off\r\n"'+sys.executable+'" "'+str(tools/'docker.py')+'" %*\r\n')
    else:
        for name, code in [('docker', fake), ('curl', fakecurl)]:
            target=tools/name;target.write_text('#!'+sys.executable+'\n'+code);target.chmod(0o755)
    env=os.environ.copy();env['PATH']=str(tools)+os.pathsep+env['PATH'];env['WA_TEST_LOG']=str(base/'docker.log')
    def run(options, success=True, **changes):
        testenv=env.copy();testenv.update(changes)
        pathlib.Path(env['WA_TEST_LOG']).write_text('')
        if os.name=='nt':
            # Override only downloads, keeping real PowerShell parsing, RNG, hashing and Docker invocation.
            harness=base/'run.ps1'
            harness.write_text("""function Invoke-WebRequest {
param([switch]$UseBasicParsing,[string]$Uri,[string]$OutFile)
$arch = if ($env:WA_TEST_ENGINE -in 'linux/amd64','linux/x86_64') {'amd64'} else {'arm64'}
if ($Uri -notmatch "linux-$arch") { throw 'Wrong archive architecture' }
$data=[Text.Encoding]::ASCII.GetBytes("verified image archive fixture`n")
if ($Uri.EndsWith('.sha256')) {
 $sha=[Security.Cryptography.SHA256]::Create()
 try {$hash=([BitConverter]::ToString($sha.ComputeHash($data))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
 if ($env:WA_TEST_BAD_HASH) {$hash='0'*64}
 [IO.File]::WriteAllText($OutFile,$hash+'  '+($Uri.Split('/')[-1] -replace '\\.sha256$','')+"`n")
} else {[IO.File]::WriteAllBytes($OutFile,$data)}
}
& '"""+str(work/'scripts/quickstart.ps1').replace("'","''")+"' "+' '.join(options)+"\nexit $LASTEXITCODE\n")
            cmd=['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(harness)]
        else:cmd=['bash',str(work/'scripts/quickstart.sh')]+options
        proc=subprocess.run(cmd,cwd=base,env=testenv,capture_output=True,text=True)
        if (proc.returncode==0)!=success:raise AssertionError(proc.stdout+'\n'+proc.stderr)
        return [json.loads(x) for x in pathlib.Path(env['WA_TEST_LOG']).read_text().splitlines()]
    flags=['-Runner','-Pull'] if os.name=='nt' else ['--runner','--pull']
    run(flags,False,WA_TEST_ENGINE='windows/x86_64')
    assert not (work/'.compose.env').exists(), 'Invalid engine must fail before creating secrets'
    logs=run(flags)
    initial=(work/'.compose.env').read_bytes();config=initial.decode()
    values=dict(line.split('=',1) for line in config.splitlines())
    assert len(values['WA_DB_PASSWORD'])==64 and values['WA_DB_PASSWORD']!=values['WA_DB_ROOT_PASSWORD']
    assert any('up' in x and '--no-build' in x for x in logs)
    logs=run(flags,WA_TEST_PULL_FAIL='1')
    assert any(x[0]=='load' for x in logs)
    assert (work/'.compose.env').read_bytes()==initial, 'Existing config was modified'
    logs=run(flags,False,WA_TEST_PULL_FAIL='1',WA_TEST_BAD_HASH='1')
    assert not any(x[0]=='load' or 'up' in x for x in logs), 'Unverified archive was loaded'
    run(flags,False,WA_TEST_UP_FAIL='9')
    logs=run([],WA_TEST_ENGINE='linux/x86_64')
    assert any('up' in x and '--build' in x and 'compose.runner.yaml' not in x for x in logs)
    (work/'.compose.env').write_text(config.replace('ghcr.io/jeanron100/web-agents-oss-console:', 'private.example/console:'))
    logs=run(flags,False,WA_TEST_PULL_FAIL='1')
    assert not any(x[0]=='load' or 'up' in x for x in logs)
    # Fresh desktop installs are remote-first; legacy installs keep their actual services.
    desktop_flags=['-Desktop','-Pull'] if os.name=='nt' else ['--desktop','--pull']
    (work/'.compose.env').unlink()
    logs=run(desktop_flags)
    remote_config=(work/'.compose.env').read_bytes()
    assert b'WA_INSTALL_MODE=remote' in remote_config
    assert not any('up' in x and 'compose.runner.yaml' in x for x in logs)
    logs=run(desktop_flags)
    assert (work/'.compose.env').read_bytes()==remote_config
    assert not any('up' in x and 'compose.runner.yaml' in x for x in logs)
    logs=run(flags)
    assert b'WA_INSTALL_MODE=local' in (work/'.compose.env').read_bytes()
    logs=run(desktop_flags)
    assert any('up' in x and 'compose.runner.yaml' in x for x in logs)
    legacy_config=config.replace('WA_INSTALL_MODE=local\n','')
    (work/'.compose.env').write_text(legacy_config)
    logs=run(desktop_flags,WA_TEST_EXISTING_RUNNER='1')
    assert (work/'.compose.env').read_text()==legacy_config
    assert any('up' in x and 'compose.runner.yaml' in x for x in logs)
    logs=run(desktop_flags)
    assert not any('up' in x and 'compose.runner.yaml' in x for x in logs)
    print(json.dumps({'shell':launcher,'extractedBundle':True,'checks':['prerequisites','engine-architecture','first-install','persistent-secrets','verified-fallback','checksum-rejection','custom-reference-preservation','docker-failure','source-console-only','desktop-remote-first','explicit-local-opt-in','legacy-mode-preservation']}))
