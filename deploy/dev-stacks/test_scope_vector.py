"""Tests for scope-vector.py: python3 -m unittest discover -s deploy/dev-stacks"""
import importlib.util
import os
import tempfile
import unittest

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("scope_vector", os.path.join(here, "scope-vector.py"))
sv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sv)

# The parts of Supabase's volumes/logs/vector.yml the script touches.
VECTOR = """sources:
  docker_host:
    type: docker_logs
    exclude_containers:
      - supabase-vector

transforms:
  project_logs:
    type: remap
    inputs:
      - docker_host
    source: |-
      .project = "default"
      .appname = del(.container_name)
      del(.container_id)
"""

COMPOSE = """services:
  db:
    networks:
      default:
        aliases:
          - supabase-db
  rest:
    networks:
      default:
        aliases:
          - supabase-rest
"""


class ScopeVectorTest(unittest.TestCase):
    def run_script(self, vector=VECTOR, project="stack-a"):
        d = tempfile.mkdtemp()
        v, c = os.path.join(d, "vector.yml"), os.path.join(d, "docker-compose.yml")
        with open(v, "w") as f:
            f.write(vector)
        with open(c, "w") as f:
            f.write(COMPOSE)
        sv.main(["--project", project, v, c])
        with open(v) as f:
            return f.read()

    def test_only_this_projects_containers(self):
        out = self.run_script()
        self.assertIn("    include_labels:\n      - com.docker.compose.project=stack-a\n", out)
        self.assertIn('if project == "stack-a" {', out)
        self.assertIn('  if svc == "db" { .appname = "supabase-db" }', out)
        # The mapping sits inside the project check, not after it.
        self.assertLess(out.index('if project == "stack-a"'), out.index('if svc == "db"'))

    def test_rerun_replaces_the_patch(self):
        once = self.run_script()
        d = tempfile.mkdtemp()
        v, c = os.path.join(d, "vector.yml"), os.path.join(d, "c.yml")
        with open(v, "w") as f:
            f.write(once)
        with open(c, "w") as f:
            f.write(COMPOSE)
        sv.main(["--project", "stack-b", v, c])
        with open(v) as f:
            twice = f.read()
        self.assertEqual(twice.count("include_labels:"), 1)
        self.assertNotIn("stack-a", twice)
        self.assertEqual(twice, self.run_script(project="stack-b"))

    def test_removes_the_unscoped_first_version(self):
        legacy = VECTOR.replace(
            '      .appname = del(.container_name)\n',
            '      .appname = del(.container_name)\n'
            '      # supermixer: container names come from Compose services\n'
            '      svc = string(.label."com.docker.compose.service") ?? ""\n'
            '      if svc == "db" { .appname = "supabase-db" }\n',
        )
        out = self.run_script(vector=legacy)
        self.assertNotIn("container names come from Compose services", out)
        self.assertEqual(out.count('if svc == "db"'), 1)

    def test_refuses_a_config_it_cannot_scope(self):
        with self.assertRaises(SystemExit):
            self.run_script(vector=VECTOR.replace("type: docker_logs", "type: file"))
        with self.assertRaises(SystemExit):
            self.run_script(project="Bad Name")


if __name__ == "__main__":
    unittest.main()
