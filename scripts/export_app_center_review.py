"""Export a source-only App Center review tied to the offline build evidence."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

from app_center_baseline import digest_header
from export_agent_menu_review import archive_bundle
from prepare_agent import APP_CENTER_HOME_VERSION, verify
from prepare_agent_bundle import EXPECTED_PARTITIONS, SECTOR
from prepare_firmware import ROOT, run, sha
from prepare_installation import image_info


LOCK = ROOT/'firmware/upstream.lock.json'
CONTRIBUTIONS = ROOT/'contributions'
SHORTCUT = CONTRIBUTIONS/'m5stack-app-center-shortcut'
LAYERS = ('home', 'reopen', 'shortcut')
FEATURES = ('STACKCHAN_APP_CENTER_HOME', 'STACKCHAN_APP_CENTER_REOPEN', 'STACKCHAN_DSH_APP_CENTER_SHORTCUT')


def review_sources(stock, upstream):
    if run('git', 'rev-parse', 'HEAD', cwd=stock) != upstream:
        raise ValueError('The tested receiver does not use the published baseline')
    with TemporaryDirectory(prefix='sion-app-center-replay-') as temp:
        clone = Path(temp)/'receiver'
        run('git', '-c', 'advice.detachedHead=false', 'clone', '-q', '--shared', str(stock), str(clone))
        for layer in LAYERS:
            patch = CONTRIBUTIONS/f'm5stack-app-center-{layer}'/f'{layer}.patch'
            run('git', 'apply', '--check', str(patch), cwd=clone)
            run('git', 'apply', str(patch), cwd=clone)
        run('git', 'add', '-A', cwd=clone)
        covered = set(run('git', 'diff', '--cached', '--name-only', upstream, cwd=clone).splitlines())
        tracked = run('git', 'diff', '--name-only', upstream, cwd=stock).splitlines()
        untracked = run('git', 'ls-files', '--others', '--exclude-standard', '--', 'firmware', cwd=stock).splitlines()
        if not covered or covered != set(tracked + untracked) or any(
                sha(clone/path) != sha(stock/path) for path in covered):
            raise ValueError('The public patch stack differs from the tested receiver')
        run('git', 'diff', '--cached', '--check', cwd=clone)
        subprocess.run([sys.executable, str(SHORTCUT/'tests/run.py'), '--stock', str(clone)], check=True)
        return {name: sha(clone/name) for name in sorted(covered)}


def load_report(path):
    report = json.loads(path.read_text())
    if report.get('deviceAccess') is not False or report.get('installable') is not False:
        raise ValueError('Expected a development-only offline report')
    return report


def writer_evidence(report, commit, candidate_digest, candidate_bytes):
    if (report.get('candidateSha256') != candidate_digest or report.get('candidateVersion') != APP_CENTER_HOME_VERSION or
            report.get('writerIdfCommit') != commit):
        raise ValueError('The SDK writer report belongs to a different candidate or SDK')
    orientations = report['orientations']
    if len(orientations) != 2 or {item['factorySlot'] for item in orientations} != {'ota_0', 'ota_1'}:
        raise ValueError('Expected both factory slot orientations in the SDK writer report')

    results = []
    for item in sorted(orientations, key=lambda row: row['factorySlot']):
        factory = item['factorySlot']
        target = 'ota_1' if factory == 'ota_0' else 'ota_0'
        _, _, offset, capacity = EXPECTED_PARTITIONS[target]
        padded_bytes = (candidate_bytes+SECTOR-1)//SECTOR*SECTOR
        envelope = [hex(offset), hex(offset+padded_bytes)]
        writes, handoffs = item['writes'], item['bootHandoffs']
        if (item['candidateSlot'] != target or padded_bytes > capacity or
                len(writes) != 6 or any(write.get('wholeFlashMatched') is not True for write in writes.values()) or
                writes['complete']['candidateEraseSpan'] != envelope or
                writes['complete']['bytesStreamed'] != candidate_bytes or len(handoffs) != 9 or
                any(boot.get('wholeFlashMatched') is not True for boot in handoffs.values()) or
                handoffs['first-boot']['slot'] != hex(offset) or
                handoffs['stock-after-restoring-saved-spans']['slot'] != hex(EXPECTED_PARTITIONS[factory][2])):
            raise ValueError('The SDK writer report does not cover staging and restoration of both slots')
        results.append({'factorySlot': factory, 'companionSlot': target, 'completeEraseSpan': envelope,
                        'writeCases': len(writes), 'bootHandoffs': len(handoffs)})
    return {'sdkCommit': commit, 'matrix': results}


def evidence(args):
    receiver = args.stock/'firmware/build'
    agent = args.agent/'firmware/build'
    receipt = verify(args.agent)
    built = json.loads((args.agent/'.agent-build.json').read_text())
    receiver_hash, agent_hash = (sha(build/'stack-chan.bin') for build in (receiver, agent))
    receiver_image, agent_image = ((build/'stack-chan.bin').read_bytes() for build in (receiver, agent))
    for image, version in ((receiver_image, '1.6.2'), (agent_image, APP_CENTER_HOME_VERSION)):
        info = image_info(image)
        if (info['imageBytes'], info.get('project'), info.get('version'), info.get('idf')) != (
                len(image), 'stack-chan', version, 'v6.1'):
            raise ValueError('Unexpected ESP32-S3 image identity')
    identity = args.agent/'firmware/main/agent/app_center/reviewed_stock_digest.h'
    if identity.read_text() != digest_header(receiver_image):
        raise ValueError('The DSH return guard is pinned to a different receiver')
    if not receipt.get('appCenterHome') or receipt['appVersion'] != APP_CENTER_HOME_VERSION or (
            built['preparedReceiptSha256'] != sha(args.agent/'.agent-prepared.json') or
            built['artifacts']['stack-chan.bin']['sha256'] != agent_hash):
        raise ValueError('The companion build receipt does not match')
    config = set((receiver/'shortcut-sdkconfig').read_text().splitlines())
    if not {f'CONFIG_{option}=y' for option in FEATURES} <= config or 'CONFIG_STACKCHAN_DSH_CATALOG_ID=31337' not in config:
        raise ValueError('Expected the tested receiver with the local review features enabled')

    shortcut, cycles, home = (load_report(path) for path in (args.shortcut, args.cycles, args.home))
    if not (agent_hash == shortcut['candidateSha256'] == cycles['agentSha256'] == home['pairedAgentStart']['sha256'] and
            receiver_hash == cycles['receiverSha256'] == home['publicFactoryReceiver']['sha256']):
        raise ValueError('The offline reports refer to different binaries')

    saved = shortcut['orientations']
    rounds = cycles['orientations']
    if ({item['factorySlot'] for item in saved} != {'0x20000', '0x510000'} or len(saved) != 2 or
            {item['factorySlot'] for item in rounds} != {'ota_0', 'ota_1'} or len(rounds) != 2 or
            not all(shortcut[key] for key in ('offlineSelectionPersistedAcrossReboot', 'invalidImageRefused',
                                              'configuredNvsUnchangedAtShortcutOpen')) or
            not home['pairedAgentStart']['restoredGenuineFactoryEntry'] or
            not all(item['unrelatedSettingsReadable'] and item['wholeFlashMatched'] and
                    item['factoryNvsComparison']['status'] == 'only-shortcut-settings-changed' and
                    item['factoryNvsComparison']['managedKeysChanged'] == ['app_dsh_menu/launch_v1']
                    for item in saved) or
            not all(len(item['cycles']) == 2 and item['restoredCurrentFactoryBaseline'] and
                    item['pairingAndPreferencesDecodedAfterReentry'] and item['queuedUpdateSelectionKept'] and
                    all(cycle['publicReceiverAcceptedHome'] and cycle['wholeFlashMatched'] for cycle in item['cycles'])
                    for item in rounds)):
        raise ValueError('Expected complete dual-slot shortcut, configuration and Home evidence')
    report = {
        'receiverBuildSha256': receiver_hash,
        'companionBuildSha256': agent_hash,
        'receiverImageValidationSha256': receiver_image[-32:].hex(),
        'companionImageValidationSha256': agent_image[-32:].hex(),
        'companionVersion': APP_CENTER_HOME_VERSION,
        'hostShortcutPolicy': 'Passed on a clean patch replay',
        'shortcutProbe': 'Both OTA orientations. SDK enrollment, retained synthetic settings, offline entry and invalid-image refusal',
        'pairedHome': 'Two cycles per orientation. Actual paired builds observed through application or HAL entry',
        'recovery': 'Restored factory image accepted by the original bootloader in the offline fixture',
    }
    if args.writer:
        lock = json.loads(LOCK.read_text())
        report['sdkWriter'] = writer_evidence(load_report(args.writer), lock['idf']['commit'], agent_hash, len(agent_image))
    return report


def export(args):
    lock = json.loads(LOCK.read_text())
    tested = evidence(args)
    patched = review_sources(args.stock, lock['official']['commit'])
    files = {
        'README.md': SHORTCUT/'PRODUCTION-REVIEW.md',
        'LICENSE': ROOT/'LICENSE',
        'firmware/upstream.lock.json': LOCK,
        'scripts/prepare_firmware.py': ROOT/'scripts/prepare_firmware.py',
        'tests/run.py': SHORTCUT/'tests/run.py',
        'tests/shortcut_test.cc': SHORTCUT/'tests/shortcut_test.cc',
    }
    for layer in LAYERS:
        source = CONTRIBUTIONS/f'm5stack-app-center-{layer}'
        files[f'patches/{layer}.patch'] = source/f'{layer}.patch'
        config = f'sdkconfig.{layer}.defaults'
        files[f'defaults/{config}'] = source/config
    for name in ('CMakeLists.txt', 'sdkconfig.defaults', 'main/CMakeLists.txt', 'main/shortcut_probe.cc'):
        files[f'tests/esp/{name}'] = SHORTCUT/'tests/esp'/name

    args.destination.mkdir()
    for name, source in files.items():
        target = args.destination/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    hashes = {name: sha(args.destination/name) for name in sorted(files)}
    (args.destination/'source-review.json').write_text(json.dumps({
        'upstream': lock['official'], 'idf': lock['idf'], 'patchedFiles': patched, 'offlineEvidence': tested,
        'files': hashes, 'containsFirmwareImages': False, 'deviceAccess': False, 'installable': False,
    }, indent=2)+'\n')
    if args.archive:
        archive_bundle(args.destination, args.archive)
    print(f'Exported {len(files)} reviewed source files and the offline evidence manifest.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('stock', 'agent', 'shortcut', 'cycles', 'home', 'destination'):
        parser.add_argument('--'+name, type=lambda path: Path(path).resolve(), required=True)
    parser.add_argument('--writer', type=lambda path: Path(path).resolve(),
                        help='Include the exact companion SDK writer and restore matrix')
    parser.add_argument('--archive', type=lambda path: Path(path).resolve())
    args = parser.parse_args()
    if args.destination.exists() or (args.archive and (args.archive.exists() or args.archive.is_relative_to(args.destination))):
        parser.error('Choose new output paths and keep the archive outside the exported directory')
    export(args)
