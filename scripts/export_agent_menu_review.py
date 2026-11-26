"""Export the reviewed public-source launcher and selector sources. Never accesses a device."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from prepare_agent_menu import MENU_OPTION, ROOT, VISIBILITY_FILES, sha, verify_menu

STOCK_MAIN = Path('firmware/main')
MENU_FILES = ('app_dsh_entry.cpp', 'app_dsh_entry.h', 'menu_device.h', 'menu_ota_status.h',
              'menu_request.h', 'rtc_menu_request.h')
APP_FILES = tuple(STOCK_MAIN/name for name in ('main.cpp', 'CMakeLists.txt', 'Kconfig.projbuild', *VISIBILITY_FILES)) + tuple(
    STOCK_MAIN/'apps/app_dsh_entry'/name for name in MENU_FILES)
SELECTOR_FILES = (
    'CMakeLists.txt', 'sdkconfig.stock.defaults', 'stock-sdk.lock.json', 'partitions.csv',
    'main/CMakeLists.txt',
    'bootloader_components/main/CMakeLists.txt', 'bootloader_components/main/bootloader_start.c',
    'bootloader_components/main/menu_request.h', 'bootloader_components/main/rtc_menu_request.h',
    'bootloader_components/main/boot_ota_guard.h',
)


def application_patch(stock, pin):
    with tempfile.TemporaryDirectory(prefix='sion-menu-index-') as folder:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(folder)/'index')}
        subprocess.run(['git', 'read-tree', pin], cwd=stock, env=env, check=True)
        subprocess.run(['git', 'add', '--', *APP_FILES], cwd=stock, env=env, check=True)
        return subprocess.check_output(
            ['git', 'diff', '--cached', '--full-index', '--no-ext-diff', '--no-textconv',
             '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--color=never', pin, '--', *APP_FILES],
            cwd=stock, env=env)


def export(prepared, destination):
    review = verify_menu(prepared)
    if any(f'stock/{path}' not in review['files'] for path in APP_FILES):
        raise ValueError('Expected the opt-in launcher sources')
    selector = prepared/'selector'
    for name in SELECTOR_FILES:
        generated = f'selector/{name}'
        original = ROOT/'firmware/boot-selector'/name
        if generated not in review['files'] and (
                not original.is_file() or sha(original) != sha(selector/name)):
            raise ValueError('Extra selector source differs: '+name)

    stock = prepared/'stock'
    patch = application_patch(stock, review['upstream'])
    if not patch:
        raise ValueError('No launcher patch to export')
    baseline_defaults = subprocess.check_output(
        ['git', 'show', f"{review['upstream']}:firmware/sdkconfig.defaults"], cwd=stock)
    review_defaults = (stock/'firmware/sdkconfig.defaults').read_bytes()
    if not review_defaults.startswith(baseline_defaults):
        raise ValueError('Prepared defaults do not extend the upstream defaults')
    added_defaults = review_defaults[len(baseline_defaults):]
    if (MENU_OPTION+'=y').encode() not in added_defaults.splitlines():
        raise ValueError('Prepared defaults do not enable the reviewed launcher')
    destination.mkdir()
    (destination/'launcher.patch').write_bytes(patch)
    (destination/'sdkconfig.menu.defaults').write_bytes(added_defaults)
    shutil.copyfile(ROOT/'contributions/m5stack-stackchan-launcher/README.md', destination/'README.md')
    fixtures = destination/'tests'
    fixtures.mkdir()
    shutil.copyfile(ROOT/'scripts/test_agent_menu_source.py', fixtures/'run.py')
    for name in ('app_visibility_test.cc', 'menu_selector_test.c'):
        shutil.copyfile(ROOT/'firmware/menu-entry'/name, fixtures/name)
    for name in SELECTOR_FILES:
        target = destination/'selector'/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(selector/name, target)
    files = {path.relative_to(destination).as_posix(): sha(path) for path in sorted(destination.rglob('*'))
             if path.is_file()}
    (destination/'source-review.json').write_text(json.dumps({
        'upstream': review['upstream'],
        'launcherPatchedFiles': {path.as_posix(): review['files'][f'stock/{path.as_posix()}'] for path in APP_FILES},
        'files': files, 'containsFirmwareImages': False,
        'deviceAccess': False, 'installable': False,
    }, indent=2)+'\n')
    print(f'Exported {len(files)} source review files.')


def archive_bundle(source, path):
    with ZipFile(path, 'x') as archive:
        for member in sorted(source.rglob('*')):
            if member.is_file():
                # ZipInfo's fixed default timestamp keeps equivalent exports identical.
                entry = ZipInfo(member.relative_to(source).as_posix())
                archive.writestr(entry, member.read_bytes(), compress_type=ZIP_DEFLATED)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--archive', type=Path, help='Write a reproducible ZIP to a new path')
    args = parser.parse_args()
    destination = args.destination.resolve()
    archive = args.archive.resolve() if args.archive else None
    if archive and (archive.exists() or archive.is_relative_to(destination)):
        parser.error('Choose a new archive path outside the exported directory')
    export(args.prepared.resolve(), destination)
    if archive:
        archive_bundle(destination, archive)
