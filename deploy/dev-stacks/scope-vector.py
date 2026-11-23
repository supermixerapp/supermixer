"""Keep Vector routing this stack's logs, and only this stack's.

Supabase's vector.yml reads the logs of every container on the Docker host
and tells services apart by container name (supabase-auth, supabase-db, ...).
scope-containers.py drops those fixed names so several stacks can run side
by side, so this:

  1. limits Vector's Docker source to this Compose project's containers
     (include_labels), so other stacks' and apps' logs never come in, and
  2. maps each of this project's Compose services back to its original
     name, the network alias scope-containers.py kept, so the routes match.

It redoes its patch on every run (safe to rerun) and checks the result, so a
change in Supabase's vector.yml fails loudly instead of leaking logs.

    python3 scope-vector.py --project NAME volumes/logs/vector.yml docker-compose.yml [more.yml ...]
"""
import argparse
import re
import sys

BEGIN = "# supermixer: begin"
END = "# supermixer: end"
LEGACY_MARKER = "# supermixer: container names come from Compose services"
PROJECT_LABEL = "com.docker.compose.project"
SERVICE_LABEL = "com.docker.compose.service"

SERVICE = re.compile(r"^  ([A-Za-z0-9_.-]+):\s*$")
ALIAS = re.compile(r"^\s+- ((?:[A-Za-z0-9-]+\.)?supabase-[A-Za-z0-9-]+)\s*$")
APPNAME = re.compile(r"^(\s*)\.appname = del\(\.container_name\)\s*$")
DOCKER_SOURCE = re.compile(r"^(\s*)type: docker_logs\s*$")
PROJECT_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def aliases(compose_files):
    names = {}
    for path in compose_files:
        service = None
        with open(path) as f:
            for line in f:
                m = SERVICE.match(line)
                if m:
                    service = m.group(1)
                    continue
                m = ALIAS.match(line)
                if m and service and service not in names:
                    names[service] = m.group(1)
    return names


def strip(lines):
    """Remove an earlier run's patch, including the first version's."""
    out, skipping = [], False
    for line in lines:
        s = line.strip()
        if s == BEGIN:
            skipping = True
            continue
        if s == END:
            skipping = False
            continue
        if skipping:
            continue
        # The first version left an unbracketed block after .appname.
        if s == LEGACY_MARKER or s.startswith("svc = string(.label.") or s.startswith('if svc == "'):
            continue
        out.append(line)
    return out


def patch(lines, project, names):
    out = []
    sources = 0
    for line in strip(lines):
        out.append(line)
        m = DOCKER_SOURCE.match(line)
        if m:
            sources += 1
            pad = m.group(1)
            out += [
                f"{pad}{BEGIN}\n",
                f"{pad}# Only this stack's containers: the Docker host may run others.\n",
                f"{pad}include_labels:\n",
                f"{pad}  - {PROJECT_LABEL}={project}\n",
                f"{pad}{END}\n",
            ]
            continue
        m = APPNAME.match(line)
        if m:
            pad = m.group(1)
            out.append(f"{pad}{BEGIN}\n")
            out.append(f'{pad}project = string(.label."{PROJECT_LABEL}") ?? ""\n')
            out.append(f'{pad}svc = string(.label."{SERVICE_LABEL}") ?? ""\n')
            out.append(f'{pad}if project == "{project}" {{\n')
            for service, name in sorted(names.items()):
                out.append(f'{pad}  if svc == "{service}" {{ .appname = "{name}" }}\n')
            out.append(f"{pad}}}\n")
            out.append(f"{pad}{END}\n")
    return out, sources


def check(lines, project):
    """The patched config must filter by project; fail rather than leak."""
    text = "".join(lines)
    problems = []
    sources = [i for i, l in enumerate(lines) if DOCKER_SOURCE.match(l)]
    if not sources:
        problems.append("no docker_logs source found")
    for i in sources:
        window = "".join(lines[i : i + 6])
        if f"- {PROJECT_LABEL}={project}" not in window:
            problems.append(f"docker_logs source at line {i + 1} has no include_labels for {project}")
    if ".appname = del(.container_name)" not in text:
        problems.append("the .appname = del(.container_name) line moved; the service mapping wasn't added")
    elif f'if project == "{project}"' not in text:
        problems.append("the service mapping isn't limited to the project")
    return problems


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("vector")
    ap.add_argument("compose", nargs="+")
    a = ap.parse_args(argv)
    if not PROJECT_NAME.match(a.project):
        sys.exit(f"scope-vector: invalid Compose project name {a.project!r}")
    with open(a.vector) as f:
        lines = f.readlines()
    out, _ = patch(lines, a.project, aliases(a.compose))
    problems = check(out, a.project)
    if problems:
        sys.exit("scope-vector: refusing to write %s, it could collect other containers' logs:\n  - %s"
                 % (a.vector, "\n  - ".join(problems)))
    with open(a.vector, "w") as f:
        f.writelines(out)


if __name__ == "__main__":
    main(sys.argv[1:])
