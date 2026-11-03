packshot bundle (sc-quartermaster), Windows

Contents: packshot.exe, starbreaker\ (StarBreaker CLI, our fork), blender\ (portable, with the StarBreaker add-on),
cli\render.py (Blender script), targets.json (target list from the development DB), run.cmd,
packshot.example.json (cluster settings).

1. Put the game's Data.p4k and its build_manifest.id (both from ...\StarCitizen\LIVE\) next to run.cmd, or pass
   --p4k "<game folder>\Data.p4k"; without build_manifest.id next to Data.p4k packshot does not start.
2. run.cmd             starts the TUI (views: 1 Run, 2 Sets, 3 Nodes; Tab switches)
   run.cmd --plain     runs without the TUI
   run.cmd --report    evaluates the latest run
   run.cmd --node      renders blocks for the coordinators in packshot.json (needs no Data.p4k)
   run.cmd --help      all options
3. Result: every run is a folder runs\<date>_<time>_<name>\ (its images, run.json, events.jsonl); all icons are in
   sets\live\ (hard links to the runs' images). work\ is only a cache and can go afterwards.
   run.cmd --set <name> renders into a set of its own (branches off live the first time).

Cluster: copy packshot.example.json to packshot.json and set the same token on every box. A coordinator (the TUI)
listens on "listen" and connects to the coordinators in its list; nodes (run.cmd --node) connect to those in theirs.
The list holds host names or IPs (port optional, default 47800); every box is known by its host name.
On the first start Windows asks whether packshot.exe may accept connections: allow it for private networks.

Nothing needs to be installed: Blender and StarBreaker are in the bundle. No internet needed.
