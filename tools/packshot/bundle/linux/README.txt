packshot bundle (sc-quartermaster), Linux

Contents: packshot (static binary), the official Blender tarball, portable/ (Blender config and StarBreaker add-on),
cli/render.py, setup.sh, check.sh, run-node.sh, packshot.example.json (cluster settings).

1. Copy the whole folder to the Linux box, e.g. scp -r linux/ user@host:packshot
2. There: bash setup.sh    (unpacks Blender into ./blender and puts portable/ into it)
3. Then:  bash check.sh    (add-on loaded? EEVEE render on Vulkan possible?)
4. cp packshot.example.json packshot.json, set the shared token and the coordinators (host names or IPs, port
   optional, default 47800); every box is known by its host name
5. ./run-node.sh          renders the blocks the coordinators send (Blender processes: ¾ of the physical cores,
                           ./run-node.sh --workers n to change); runs until Ctrl+C and reconnects on its own

A node needs neither Data.p4k nor StarBreaker. It only writes into its work/ folder and, when a coordinator sends
them, into blender/portable/scripts/addons/starbreaker_addon and blender/portable/config.
