"""Launcher: run the TUI from anywhere inside the repository.

    tools/releasectl/.venv/Scripts/python.exe -I tools/releasectl/run.py [--dry-run] [--root <repo>]

`-I` (isolated mode) leaves the script's folder off sys.path, so it is added
here before the package is imported.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from releasectl.__main__ import main  # noqa: E402

if __name__ == "__main__":
    main()
