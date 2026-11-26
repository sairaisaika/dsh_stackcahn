"""Prepare a pinned build checkout. Never opens serial ports or invokes flashing."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import shutil

ROOT = Path(__file__).resolve().parents[1]

def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

def checkout(url, revision, target):
    if target.exists():
        if run('git', 'rev-parse', 'HEAD', cwd=target) != revision:
            raise RuntimeError(f'Refusing to change existing checkout: {target}')
        return
    target.mkdir(parents=True)
    run('git', 'init', '-q', str(target))
    run('git', 'remote', 'add', 'origin', url, cwd=target)
    run('git', 'fetch', '--depth', '1', 'origin', revision, cwd=target)
    run('git', 'checkout', '--detach', 'FETCH_HEAD', cwd=target)

def apply(patch, target):
    # git apply inside a repository subdirectory may silently skip paths from a
    # git-style diff. Resolve the prefix explicitly, from the repository root.
    repository=Path(run('git','rev-parse','--show-toplevel',cwd=target))
    prefix=target.resolve().relative_to(repository.resolve())
    args=['git', '-C', str(repository), 'apply']
    if str(prefix)!='.':args += ['--directory='+str(prefix)]
    if subprocess.run(args+['--reverse','--check',str(patch)],capture_output=True).returncode==0:
        return
    subprocess.run(args+['--check',str(patch)],check=True)
    subprocess.run(args+[str(patch)],check=True)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def inputs(sion):
    paths=[ROOT/'firmware/upstream.lock.json']
    if sion:
        paths += sorted((ROOT/'firmware/patches').glob('*.patch'))
        paths += sorted(p for p in (ROOT/'firmware/overlay').rglob('*') if p.is_file())
    return {str(p.relative_to(ROOT)):sha(p) for p in paths}

def prepare(target, sion=False):
    lock=json.loads((ROOT/'firmware/upstream.lock.json').read_text())
    receipt=target/'.sion-prepared.json'
    identity={'sion':sion,'inputs':inputs(sion)}
    if receipt.exists():
        previous=json.loads(receipt.read_text())
        if previous['identity'] != identity:
            raise RuntimeError('Preparation inputs changed; use a new --destination to preserve existing edits')
        for relative,digest in previous['files'].items():
            path=target/relative
            if not path.is_file() or sha(path)!=digest:
                raise RuntimeError(f'Prepared source changed; refusing to overwrite: {relative}')
        for relative,revision in previous['heads'].items():
            if run('git','rev-parse','HEAD',cwd=target/relative)!=revision:
                raise RuntimeError(f'Prepared checkout changed: {relative}')
        print(f'Prepared source receipt verified: {target}. No device access performed.')
        return
    checkout(lock['official']['url'],lock['official']['commit'],target)
    fw=target/'firmware'
    for dep in lock['dependencies']:
        checkout(dep['url'],dep['commit'],fw/dep['path'])
    official_patch=fw/'patches/xiaozhi-esp32.patch'
    digest=hashlib.sha256(official_patch.read_bytes()).hexdigest()
    if digest!=lock['officialPatchSha256']:
        raise RuntimeError('Official patch hash mismatch')
    local_patch=ROOT/'firmware/patches/xiaozhi-dual-backend.patch'
    already_sion=sion and subprocess.run(
        ['git','-C',str(fw/'xiaozhi-esp32'),'apply','--reverse','--check',str(local_patch)],
        capture_output=True).returncode==0
    # The second patch overlaps the official patch; checking the first patch in
    # reverse after both are applied incorrectly reports a conflict.
    if not already_sion:
        apply(official_patch,fw/'xiaozhi-esp32')
    if sion:
        apply(ROOT/'firmware/patches/xiaozhi-dual-backend.patch',fw/'xiaozhi-esp32')
        apply(ROOT/'firmware/patches/stackchan-dual-backend.patch',fw)
        apply(ROOT/'firmware/patches/xiaozhi-preservation.patch',fw/'xiaozhi-esp32')
        apply(ROOT/'firmware/patches/stackchan-preservation.patch',fw)
        for source in (ROOT/'firmware/overlay/sion').rglob('*'):
            if not source.is_file():
                continue
            destination=fw/'xiaozhi-esp32/main/sion'/source.relative_to(ROOT/'firmware/overlay/sion')
            if destination.exists() and sha(destination)!=sha(source):
                raise RuntimeError(f'Refusing to overwrite edited overlay: {destination}')
        shutil.copytree(ROOT/'firmware/overlay/sion',fw/'xiaozhi-esp32/main/sion',dirs_exist_ok=True)
    repositories=[(target,lock['official']['commit'])]
    repositories += [(fw/d['path'],d['commit']) for d in lock['dependencies']]
    files={}
    heads={}
    for repository,revision in repositories:
        heads[str(repository.relative_to(target))]=revision
        for name in run('git','ls-files',cwd=repository).splitlines():
            path=repository/name
            if path.is_file():
                files[str(path.relative_to(target))]=sha(path)
    if sion:
        for path in (fw/'xiaozhi-esp32/main/sion').rglob('*'):
            if path.is_file():
                files[str(path.relative_to(target))]=sha(path)
    receipt.write_text(json.dumps({'identity':identity,'heads':heads,'files':files},indent=2)+'\n')
    print(f'Build sources prepared: {fw}. Sion={sion}. No device access performed.')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination',type=Path,default=ROOT/'work/firmware-build')
    parser.add_argument('--sion',action='store_true',help='Apply the optional dual-backend extension')
    args=parser.parse_args()
    prepare(args.destination.resolve(),args.sion)
