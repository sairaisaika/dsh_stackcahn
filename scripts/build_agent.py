"""Build the independent entry only; no serial, flash, OTA or install operation."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from prepare_agent import ROOT, verify, sha, run

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Prepared checkout root')
    args = parser.parse_args()
    target = args.source.resolve()
    receipt = verify(target)
    lock = json.loads((ROOT/'firmware/upstream.lock.json').read_text())
    idf = os.environ.get('IDF_PATH')
    if not idf or run('git', 'rev-parse', 'HEAD', cwd=idf) != lock['idf']['commit']:
        raise SystemExit('Export the pinned ESP-IDF environment first')
    source = target/'firmware'
    subprocess.run(['idf.py', '-C', str(source),
                    '-DSDKCONFIG='+str(source/'build/agent-sdkconfig'),
                    '-DSDKCONFIG_DEFAULTS='+str(source/'sdkconfig.defaults')+';'+str(source/'main/agent/sdkconfig.defaults'),
                    'build'], check=True)
    # Component Manager can rewrite dependencies.lock during a successful build.
    # Do not issue a reproducibility receipt if any prepared input has drifted.
    verify(target)
    # This receipt is evidence of compilation, never a flash allow-list.
    output = source/'build'
    description = json.loads((output/'project_description.json').read_text())
    if description['project_version'] != receipt['appVersion']:
        raise SystemExit('Built application version does not match the prepared identity')
    artifacts = [output/'stack-chan.bin', output/'stack-chan.elf', output/'agent-sdkconfig']
    result = {'profile': receipt['profile'], 'appVersion': receipt['appVersion'],
              'inputs': receipt['inputs'],
              'idf': lock['idf']['commit'], 'preparedReceiptSha256': sha(target/'.agent-prepared.json'),
              'artifacts': {p.name: {'sha256': sha(p), 'bytes': p.stat().st_size} for p in artifacts},
              'installable': False, 'hardwareValidated': False}
    (target/'.agent-build.json').write_text(json.dumps(result, indent=2)+'\n')
    print('Build recorded. No device access. This image is not approved for installation.')
