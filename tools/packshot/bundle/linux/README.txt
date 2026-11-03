packshot bundle (sc-quartermaster), Linux

Contents: packshot (static binary), the official Blender tarball, portable/ (Blender config and StarBreaker add-on),
cli/render.py, setup.sh, check.sh, run-node.sh, packshot.example.json (cluster settings).

1. Copy the whole folder to the Linux box, e.g. scp -r linux/ user@host:packshot
2. There: bash setup.sh    (unpacks Blender into ./blender and puts portable/ into it)
3. Then:  bash check.sh    (add-on loaded? EEVEE render on Vulkan possible?)
4. cp packshot.example.json packshot.json, set the shared token and the coordinators (host names or IPs, port
   optional, default 47800); every box is known by its host name
5. ./run-node.sh          renders the blocks the coordinators send (Blender processes: ¾ of the physical cores,
                           ./run-node.sh --workers n to change, + / - while it runs); the same TUI as on the
                           coordinators, reduced to the blocks it renders and the boxes; q quits, --plain prints
                           lines instead (e.g. as a service); reconnects on its own

A node needs neither Data.p4k nor StarBreaker and writes only into its work/ folder. All boxes need the same state
(packshot build, Blender, add-on), else no run starts: copy a new bundle to every box after an update.
