"""Let the dev stack run next to other self-hosted Supabase stacks.

Supabase's compose files pin container names (supabase-db, ...), and Docker
container names are global, so a second stack can't start. This drops each
container_name and adds the old name as a network alias instead: aliases are
per compose network, and the gateway still reaches services by those names
(e.g. realtime-dev.supabase-realtime). Safe to run repeatedly.

    python3 scope-containers.py docker-compose.yml [more.yml ...]
"""
import re
import sys

NAME = re.compile(r"^    container_name:\s*(\S+)\s*$")
SERVICE = re.compile(r"^  [A-Za-z0-9_.-]+:\s*$")


def rewrite(lines):
    # Split into blocks that each start at a service key (2-space indent).
    blocks, current = [], []
    for line in lines:
        if SERVICE.match(line) and current:
            blocks.append(current)
            current = []
        current.append(line)
    blocks.append(current)

    out = []
    for block in blocks:
        names = [m.group(1) for m in map(NAME.match, block) if m]
        if not names:
            out.extend(block)
            continue
        name = names[0]
        block = [l for l in block if not NAME.match(l)]
        alias = f"          - {name}\n"
        if "        aliases:\n" in block:
            i = block.index("        aliases:\n") + 1
            while i < len(block) and block[i].startswith("          - "):
                i += 1
            block.insert(i, alias)
        elif any(l.startswith("    networks:") for l in block):
            sys.exit(f"don't know how to add an alias to a service with its own networks: {name}")
        else:
            block[1:1] = ["    networks:\n", "      default:\n", "        aliases:\n", alias]
        out.extend(block)
    return out


for path in sys.argv[1:]:
    with open(path) as f:
        lines = f.readlines()
    with open(path, "w") as f:
        f.writelines(rewrite(lines))
