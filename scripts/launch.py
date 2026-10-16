#!/usr/bin/env python3
"""Deliver the state path as an open-document event, including to a running app."""
import subprocess
from indicator import ROOT, locked_state, state_path, write_state

path = state_path()
if not path.exists():
    with locked_state(path) as state:
        if not path.exists():
            write_state(path, state)
subprocess.run(["/usr/bin/open", "-a", str(ROOT / ".build" / "Luma.app"), str(path)], check=True)
