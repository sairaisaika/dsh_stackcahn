"""Review saved publisher artifacts and a pre-App-Center double read without opening Sion."""
import argparse
import json
import os
from pathlib import Path
import re
import struct
from urllib.parse import urlsplit

from app_center_baseline import OTA, OWNER, require_app_center_storage, review_app_center
from check_agent_preflight import read_snapshot
from prepare_agent_bundle import CONFIG_OFFSET, EXPECTED_PARTITIONS, FLASH_SIZE, SECTOR, TABLE_OFFSET, pad_sectors
from prepare_installation import image_info, ota_records, sha
from review_app_center_recovery import reviewed_candidate


def read_bounded(path, limit):
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    if not data or len(data) > limit:
        raise ValueError('Expected a nonempty artifact within its supported size')
    return data


def distinct_keys(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError('Ambiguous duplicate JSON fields in the catalogue')
    return result


def https_url(value):
    if not isinstance(value, str) or not value.startswith('https://') or any(ord(ch) <= 32 for ch in value):
        raise ValueError('Expected HTTPS for the catalogue and companion download')
    parsed = urlsplit(value)
    if not parsed.hostname or parsed.username is not None or parsed.fragment or '\\' in parsed.netloc:
        raise ValueError('Invalid HTTPS catalogue or companion URL')
    # Accessing the property validates an explicitly provided port.
    if parsed.port == 0:
        raise ValueError('Invalid HTTPS catalogue or companion port')


def catalogue_entry(data, url, catalog_id):
    https_url(url)
    if not 0 < catalog_id <= 2147483647:
        raise ValueError('The publisher-assigned catalogue ID must be a positive C++ int')
    response = json.loads(data, object_pairs_hook=distinct_keys)
    if isinstance(response, dict):
        if response.get('code', 0) != 0:
            raise ValueError('The saved catalogue contains an error response')
        response = response.get('data')
    if not isinstance(response, list):
        raise ValueError('Expected an App Center catalogue array')
    matches = [item for item in response if isinstance(item, dict) and
               type(item.get('id')) in (int, float) and item['id'] == catalog_id]
    if len(matches) != 1:
        raise ValueError('The specified catalogue ID must identify exactly one entry')
    entry = matches[0]
    download = next((entry[key] for key in ('firmwareUrl', 'downloadUrl', 'otaUrl', 'url')
                     if isinstance(entry.get(key), str)), None)
    https_url(download)
    digest = entry.get('reopenImageSha256')
    if not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest):
        raise ValueError('The catalogue entry must publish a lowercase ESP validation digest')
    return digest


def inactive_image(data):
    if data.count(0xff) == len(data):
        return {'status': 'erased'}
    from esptool.util import FatalError
    try:
        info = image_info(data)
    except (FatalError, ValueError, RuntimeError, IndexError, OSError, struct.error):
        return {'status': 'unverified-existing-bytes'}
    return {'status': 'valid-image', 'sha256': sha(data[:info['imageBytes']]),
            'bytes': info['imageBytes'], 'project': info.get('project'), 'version': info.get('version')}


def installation_scope(data, baseline, candidate):
    storage = require_app_center_storage(data, baseline)
    opposite = 'ota_1' if baseline.stock_slot == 'ota_0' else 'ota_0'
    _, _, target, slot_size = EXPECTED_PARTITIONS[opposite]
    app_end = target + len(pad_sectors(candidate))
    if not candidate or app_end > target + slot_size:
        raise ValueError('Companion image cannot fit in the reviewed inactive slot')
    record_sector = 1 - baseline.active_record_sector
    sector = OTA + record_sector * SECTOR
    record = ota_records(data[OTA:OTA+2*SECTOR], include_crc=True)[record_sector]
    inactive = data[target:target+slot_size]
    installed = inactive.startswith(candidate)
    reopen = (installed and record['crcValid'] and
              record['sequence'] not in (0, 0xffffffff) and
              (record['sequence']-1) % 2 == int(opposite[-1]) and record['state'] == 4)
    previous_image = inactive_image(inactive)
    _, _, nvs, nvs_size = EXPECTED_PARTITIONS['nvs']
    spans = []
    if not reopen:
        if data[sector:sector+SECTOR] != b'\xff'*SECTOR:
            spans.append({'phase': 'ota-begin', 'region': 'inactive-ota-record',
                          'start': sector, 'endExclusive': sector+SECTOR})
        spans.append({'phase': 'ota-download', 'region': opposite,
                      'start': target, 'endExclusive': app_end})
    spans.extend([
        {'phase': 'select-boot', 'region': 'inactive-ota-record', 'start': sector, 'endExclusive': sector+SECTOR},
        {'phase': 'remember-shortcut', 'region': 'nvs', 'start': nvs, 'endExclusive': nvs+nvs_size,
         'logicalKey': 'app_dsh_menu/launch_v1', 'rangeKind': 'partition-envelope'},
    ])
    if storage == 'erased':
        spans.append({'phase': 'first-dsh-boot', 'region': 'independent-owner-marker',
                      'start': OWNER, 'endExclusive': CONFIG_OFFSET})
    return {'factorySlot': baseline.stock_slot, 'inactiveSlot': opposite, 'independentStorage': storage,
            'entryPathFromSnapshot': 'open' if reopen else 'download', 'inactiveImage': previous_image,
            'replacesInactiveImage': not reopen and not installed and previous_image['status'] == 'valid-image',
            'expectedWriteEnvelope': spans}


def review(backup, receiver, candidate_source, catalogue, catalog_url, catalog_id, offered, host_archive):
    baseline = review_app_center(backup.data)
    if receiver != baseline.stock:
        raise ValueError('The confirmed receiver does not match the supplied factory image bytes')
    if not all(marker in receiver for marker in
               (b'SION_APP_CENTER_HOME_V1\0', b'app_dsh_menu\0', b'launch_v1\0')):
        raise ValueError('The confirmed receiver does not provide the reviewed Home and shortcut protocol')
    offered_digest = catalogue_entry(catalogue, catalog_url, catalog_id)
    candidate = reviewed_candidate(backup.data, candidate_source)
    if offered != candidate:
        raise ValueError('The saved catalogue download differs from the locally reviewed companion build')
    if offered_digest != candidate[-32:].hex():
        raise ValueError('The catalogue ESP validation digest does not match the downloaded companion')
    report = installation_scope(backup.data, baseline, candidate)
    return dict(report, status='matching-offline-inputs', deviceAccess=False, flashAuthorized=False,
                publisherProvenanceVerified=False, catalogId=catalog_id, catalogueSha256=sha(catalogue),
                beforeSha256=sha(backup.data), bootloaderRegionSha256=sha(backup.data[:TABLE_OFFSET]),
                partitionTableRegionSha256=sha(baseline.table), receiverSha256=sha(receiver),
                receiverImageValidationSha256=receiver[-32:].hex(), candidateSha256=sha(candidate),
                candidateImageValidationSha256=offered_digest, macPluginArchiveSha256=sha(host_archive))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('before', 'receiver', 'agent-source', 'catalogue', 'offered-image', 'host-archive', 'output'):
        parser.add_argument('--'+option, type=Path, required=True)
    parser.add_argument('--catalog-url', required=True, help='HTTPS source of the saved catalogue')
    parser.add_argument('--catalog-id', type=int, required=True, help='ID assigned by the publisher for this receiver')
    args = parser.parse_args()
    try:
        from esptool.util import FatalError
    except ImportError:
        parser.exit(1, 'Use the reviewed ESP-IDF Python environment with esptool.\n')
    try:
        result = review(read_snapshot(args.before), read_bounded(args.receiver, FLASH_SIZE),
                        args.agent_source.resolve(), read_bounded(args.catalogue, 1024*1024),
                        args.catalog_url, args.catalog_id, read_bounded(args.offered_image, FLASH_SIZE),
                        read_bounded(args.host_archive, 64*1024*1024))
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(json.dumps(result, indent=2)+'\n')
    except (OSError, ValueError, RuntimeError, FatalError, KeyError, struct.error) as error:
        parser.exit(1, f'Install review rejected: {error}\n')
    print('Offline install review saved. No device access or Flash authorization.')


if __name__ == '__main__':
    main()
