"""Run the real shell steps of the GitHub workflows against local Git remotes and a fake `gh`."""

import json
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
BOT = "41898282+github-actions[bot]@users.noreply.github.com"

# Minimal `gh`: serves canned API data from a JSON state file and records issues.
# `--jq` is applied with real jq, so the workflow's filters are exercised too.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
path = os.environ["FAKE_GH_STATE"]
state = json.load(open(path))
args = sys.argv[1:]
def opt(name):
    return args[args.index(name) + 1] if name in args else None
def out(data):
    jq = opt("--jq")
    if jq is None:
        print(json.dumps(data))
    else:
        sys.stdout.write(subprocess.run(["jq", "-r", jq], input=json.dumps(data), text=True,
                                        capture_output=True, check=True).stdout)
if " ".join(args[:2]) in state["fail"]:
    sys.exit("simulated gh failure")
issues = state["issues"]
if args[:2] == ["auth", "setup-git"]:
    pass
elif args[:2] == ["repo", "clone"] and args[2] == os.environ["GITHUB_REPOSITORY"]:
    subprocess.run(["git", "clone", "-q", *args[args.index("--") + 1:], state["remote"], args[3]], check=True)
elif args[0] == "api" and args[1] in state["api"]:
    out(state["api"][args[1]])
elif args[:2] == ["issue", "list"]:
    out([i for i in issues if opt("--state") in ("all", i["state"])])
elif args[:2] == ["issue", "create"]:
    issues.append({"number": len(issues) + 1, "title": opt("--title"), "body": opt("--body"),
                   "state": "open", "assignee": opt("--assignee")})
elif args[:2] == ["issue", "close"]:
    next(i for i in issues if i["number"] == int(args[2]))["state"] = "closed"
elif args[:2] == ["run", "list"]:
    out([r for r in state["runs"] if opt("--status") in (None, r["conclusion"])])
else:
    sys.exit(f"unexpected gh call: {args}")
json.dump(state, open(path, "w"))
'''


def step_script(workflow, name):
    """Return the dedented `run: |` block of the named step."""
    lines = (WORKFLOWS / workflow).read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"- name: {name}")
    run = next(i for i in range(start, len(lines)) if lines[i].strip() == "run: |")
    indent = len(lines[run]) - len(lines[run].lstrip())
    body = []
    for line in lines[run + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        body.append(line)
    return textwrap.dedent("\n".join(body)) + "\n"


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def iso(hours_ago):
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


@unittest.skipUnless(shutil.which("jq") and shutil.which("git"), "needs jq and git")
class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / "bin").mkdir()
        (self.tmp / "bin" / "gh").write_text(FAKE_GH)
        (self.tmp / "bin" / "gh").chmod(0o755)
        self.state = {"fail": [], "issues": [], "api": {}, "runs": [], "remote": ""}
        self.runners = 0

    def run_step(self, workflow, name, cwd=None, prepare=None, **env):
        """Run a step on a fresh runner, as GitHub does: bash -eo pipefail."""
        self.runners += 1
        runner_temp = self.tmp / f"runner{self.runners}"
        runner_temp.mkdir()
        if prepare:
            prepare(runner_temp)
        (self.tmp / "state.json").write_text(json.dumps(self.state))
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step_script(workflow, name)],
            cwd=cwd or runner_temp, capture_output=True, text=True,
            env={**os.environ, "PATH": f"{self.tmp / 'bin'}:{os.environ['PATH']}",
                 "FAKE_GH_STATE": str(self.tmp / "state.json"), "RUNNER_TEMP": str(runner_temp),
                 "GITHUB_REPOSITORY": "o/r", "GITHUB_REPOSITORY_OWNER": "o",
                 "GITHUB_SERVER_URL": "https://github.test", "GITHUB_RUN_ID": "1", "GH_TOKEN": "x", **env})
        self.state = json.loads((self.tmp / "state.json").read_text())
        return result, runner_temp


class HistoryPersistenceTest(WorkflowTest):
    """Each clean runner must extend the retained history, not restart from the seed."""

    def setUp(self):
        super().setUp()
        seed = self.tmp / "seed"
        (seed / "webpack").mkdir(parents=True)
        (seed / "webpack-mappings").mkdir()
        (seed / "webpack" / "100.stable.json").write_text("{}")
        (seed / "webpack-mappings" / "seed.json").write_text("{}")
        (seed / "LICENSE").write_text("MIT")
        git("init", "-q", "-b", "mapping-data", cwd=seed)
        git("add", ".", cwd=seed)
        git("-c", "user.name=seed", "-c", "user.email=seed@test", "commit", "-qm", "seed", cwd=seed)
        git("clone", "-q", "--bare", str(seed), str(self.tmp / "remote.git"), cwd=self.tmp)
        self.state["remote"] = f"file://{self.tmp / 'remote.git'}"
        # Stand-in for css_mappings.py: adds this release, then derives outputs from all retained dumps.
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        (self.workspace / "css_mappings.py").write_text(textwrap.dedent('''
            import json, os, sys
            from pathlib import Path
            repo, release = Path(sys.argv[1]), os.environ["RELEASE"]
            dump = repo / "webpack" / f"{release}.stable.json"
            if not dump.exists():
                previous = sorted(p.stem.split(".")[0] for p in (repo / "webpack").glob("*.json"))[-1]
                dump.write_text("{}")
                (repo / "webpack-mappings" / f"{previous}to{release}.json").write_text("{}")
            history = sorted(p.stem for p in (repo / "webpack").glob("*.json"))
            for branch in ("stable", "beta"):
                (repo / f"{branch}.json").write_text(json.dumps({"id": history}))
        '''))

    def publish(self, release):
        result, runner_temp = self.run_step("publish-mappings.yml", "Generate and retain stable and beta mappings",
                                            cwd=self.workspace, RELEASE=release)
        self.assertEqual(result.returncode, 0, result.stderr)
        return runner_temp / "steamui-watch" / "site"

    def remote_files(self):
        return subprocess.run(["git", "ls-tree", "-r", "--name-only", "mapping-data"], cwd=self.tmp / "remote.git",
                              check=True, capture_output=True, text=True).stdout.split()

    def commits(self):
        return subprocess.run(["git", "rev-list", "--count", "mapping-data"], cwd=self.tmp / "remote.git",
                              check=True, capture_output=True, text=True).stdout.strip()

    def test_consecutive_releases_on_clean_runners_keep_history(self):
        self.publish("200")
        site = self.publish("300")
        self.assertEqual(json.loads((site / "stable.json").read_text()), {"id": ["100.stable", "200.stable", "300.stable"]})
        self.assertEqual(json.loads((site / "beta.json").read_text()), {"id": ["100.stable", "200.stable", "300.stable"]})
        self.assertEqual((site / "LICENSE.txt").read_text(), "MIT")
        self.assertTrue({"webpack/200.stable.json", "webpack/300.stable.json", "webpack-mappings/100to200.json",
                         "webpack-mappings/200to300.json"} <= set(self.remote_files()))

    def test_rerun_without_a_new_release_makes_no_commit(self):
        self.publish("200")
        before = self.commits()
        self.publish("200")
        self.assertEqual(self.commits(), before)


class NewMappingIssueTest(WorkflowTest):
    STEP = "Open an issue for new mappings"

    def setUp(self):
        super().setUp()
        baseline = re.search(r"baseline=(\w+)", step_script("publish-mappings.yml", self.STEP))[1]
        self.baseline_call = f"api repos/o/r/contents/webpack?ref={baseline}"
        self.state["api"][self.baseline_call.split()[1]] = [{"name": "100.stable.json"}, {"name": "101.beta.json"}]
        self.versions = ["100.stable", "101.beta", "200.stable", "201.beta"]

    def announce(self):
        def prepare(runner_temp):
            webpack = runner_temp / "steamui-watch" / "mappings" / "webpack"
            webpack.mkdir(parents=True)
            (webpack.parent / ".git").mkdir()
            for version in self.versions:
                (webpack / f"{version}.json").write_text("{}")
        return self.run_step("publish-mappings.yml", self.STEP, prepare=prepare, DEPLOYMENT="success")[0]

    def titles(self):
        return [issue["title"] for issue in self.state["issues"]]

    def test_failed_creation_is_retried_even_after_upstream_adds_the_version(self):
        self.state["fail"] = ["issue create"]
        self.assertNotEqual(self.announce().returncode, 0)
        self.assertEqual(self.titles(), [])
        # Upstream later publishes the same versions; the pinned baseline must ignore that.
        self.state["api"]["repos/DeckThemes/CSSLoader-Mappings/contents/webpack"] = [
            {"name": f"{v}.json"} for v in self.versions]
        self.state["fail"] = []
        result = self.announce()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.titles(), ["New CSS mappings: 200.stable 201.beta"])
        self.assertEqual(self.state["issues"][0]["assignee"], "o")

    def test_closed_issue_still_counts_and_only_later_versions_are_announced(self):
        self.announce()
        self.state["issues"][0]["state"] = "closed"
        self.assertEqual(self.announce().returncode, 0)
        self.assertEqual(len(self.titles()), 1)
        self.versions.append("1200.stable")
        self.announce()
        self.assertEqual(self.titles()[-1], "New CSS mappings: 1200.stable")

    def test_baseline_lookup_failure_announces_nothing(self):
        self.state["fail"] = [self.baseline_call]
        self.assertNotEqual(self.announce().returncode, 0)
        self.assertEqual(self.titles(), [])


class WatchdogTest(WorkflowTest):
    TITLE = "CSS mappings are overdue"

    def setUp(self):
        super().setUp()
        self.state["api"]["repos/o/r/actions/workflows/publish-mappings.yml"] = {"state": "active"}

    def check(self):
        result, _ = self.run_step("watchdog.yml", "Report overdue publishing")
        self.assertEqual(result.returncode, 0, result.stderr)
        return [(issue["title"], issue["state"]) for issue in self.state["issues"]]

    def test_recent_success_opens_nothing(self):
        self.state["runs"] = [{"createdAt": iso(2), "conclusion": "success"}]
        self.assertEqual(self.check(), [])

    def test_stale_success_opens_one_issue_and_recovery_closes_it(self):
        # A recent failure must not count as a publication.
        self.state["runs"] = [{"createdAt": iso(1), "conclusion": "failure"},
                              {"createdAt": iso(30), "conclusion": "success"}]
        self.assertEqual(self.check(), [(self.TITLE, "open")])
        self.assertIn("`active`", self.state["issues"][0]["body"])
        self.assertEqual(self.check(), [(self.TITLE, "open")])
        self.state["runs"].insert(0, {"createdAt": iso(0), "conclusion": "success"})
        self.assertEqual(self.check(), [(self.TITLE, "closed")])
        self.assertEqual(self.check(), [(self.TITLE, "closed")])

    def test_never_published_is_overdue(self):
        self.assertEqual(self.check(), [(self.TITLE, "open")])
        self.assertIn("`never`", self.state["issues"][0]["body"])


if __name__ == "__main__":
    unittest.main()
