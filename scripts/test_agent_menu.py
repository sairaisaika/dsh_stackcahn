"""Run the launcher sources in the project's verified prepared checkout."""
import argparse
from pathlib import Path

from prepare_agent_menu import ROOT, verify_menu
from test_agent_menu_source import test_menu_sources


def test_menu(prepared):
    receipt = verify_menu(prepared)
    test_menu_sources(
        prepared/'stock', prepared/'selector', ROOT/'firmware/menu-entry',
        include_visibility='stock/firmware/main/hal/hal_toggles.cpp' in receipt['files'],
    )


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared', type=Path, required=True)
    args = parser.parse_args()
    test_menu(args.prepared.resolve())
