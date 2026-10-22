"""Run the real shell steps of the GitHub workflows against local Git remotes and a fake `gh`."""

import base64
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
from typing import Any

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
    body = opt("--body") if "--body" in args else open(opt("--body-file")).read()
    issues.append({"number": len(issues) + 1, "title": opt("--title"), "body": body,
                   "state": "open", "assignee": opt("--assignee")})
elif args[:2] == ["issue", "close"]:
    next(i for i in issues if i["number"] == int(args[2]))["state"] = "closed"
elif args[:2] == ["run", "list"]:
    out([r for r in state["runs"] if opt("--status") in (None, r["conclusion"])])
else:
    sys.exit(f"unexpected gh call: {args}")
json.dump(state, open(path, "w"))
'''

# `uv run [--options] python ARGS` without uv or a Python download: the tests already run on Python.
FAKE_UV = r'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
python = args.index("python")
if args[0] != "run" or not all(a.startswith("--") for a in args[1:python]):
    sys.exit(f"unexpected uv call: {args}")
os.execv(sys.executable, [sys.executable, *args[python + 1:]])
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


BASELINE = "b" * 40  # stands in for the DeckThemes commit in .github/upstream-baseline


def write_baseline(workspace, sha=BASELINE):
    (workspace / ".github").mkdir(exist_ok=True)
    (workspace / ".github" / "upstream-baseline").write_text(sha + "\n")


@unittest.skipUnless(shutil.which("jq") and shutil.which("git"), "needs jq and git")
class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / "bin").mkdir()
        for name, script in (("gh", FAKE_GH), ("uv", FAKE_UV)):
            (self.tmp / "bin" / name).write_text(script)
            (self.tmp / "bin" / name).chmod(0o755)
        self.state: dict[str, Any] = {"fail": [], "issues": [], "api": {}, "runs": [], "remote": ""}
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


@unittest.skipUnless(shutil.which("bun"), "needs Bun for extras manifest validation")
class ExtrasPublicationTest(WorkflowTest):
    def test_failed_extras_check_keeps_published_extras_and_fresh_css(self):
        previous = {"schema": 1, "revision": 2, "components": {
            "RadioButton": {"title": "Radio", "description": "", "find": [[{"text": "previous"}]]}}}
        old = self.tmp / "published.json"
        old.write_text(json.dumps(previous))
        curl = self.tmp / "bin" / "curl"
        curl.write_text("#!/usr/bin/env python3\nimport os, shutil, sys\n"
                        'shutil.copyfile(os.environ["PUBLISHED_EXTRAS"], sys.argv[sys.argv.index("--output") + 1])\n')
        curl.chmod(0o755)

        def prepare(runner):
            site = runner / "steamui-watch" / "site"
            site.mkdir(parents=True)
            (site / "stable.json").write_text('{"stable":"new"}')
            (site / "beta.json").write_text('{"beta":"new"}')
            # An unvalidated candidate must not be served after the probe fails.
            (site / "decky-extras.json").write_text('{"revision":999,"unvalidated":true}')

        result, runner = self.run_step("publish-mappings.yml", "Retain published extras after validation failure",
                                      cwd=WORKFLOWS.parent.parent, prepare=prepare, PUBLISHED_EXTRAS=str(old))
        self.assertEqual(result.returncode, 0, result.stderr)
        site = runner / "steamui-watch" / "site"
        self.assertEqual(json.loads((site / "decky-extras.json").read_text()), previous)
        self.assertEqual(json.loads((site / "stable.json").read_text()), {"stable": "new"})
        self.assertEqual(json.loads((site / "beta.json").read_text()), {"beta": "new"})


class NewMappingIssueTest(WorkflowTest):
    STEP = "Open an issue for new mappings"

    def setUp(self):
        super().setUp()
        self.baseline_call = f"api repos/o/r/contents/webpack?ref={BASELINE}"
        self.state["api"][self.baseline_call.split()[1]] = [{"name": "100.stable.json"}, {"name": "101.beta.json"}]
        self.versions = ["100.stable", "101.beta", "200.stable", "201.beta"]

    def announce(self):
        def prepare(runner_temp):
            write_baseline(runner_temp)
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
        self.deploy()

    def deploy(self, *statuses):
        """Pages deployments, oldest first, as (state, hours ago of their latest status)."""
        self.state["api"]["graphql"] = {"data": {"repository": {"deployments": {"nodes": [
            {"latestStatus": {"state": state, "createdAt": iso(hours)}} for state, hours in statuses]}}}}

    def check(self):
        result, _ = self.run_step("watchdog.yml", "Report overdue publishing")
        self.assertEqual(result.returncode, 0, result.stderr)
        return [(issue["title"], issue["state"]) for issue in self.state["issues"]]

    def test_deployed_run_that_failed_later_is_not_overdue(self):
        # The run failed (e.g. in the issue step) after Pages deployed: publication is healthy.
        self.state["runs"] = [{"createdAt": iso(1), "conclusion": "failure"},
                              {"createdAt": iso(40), "conclusion": "success"}]
        self.deploy(("SUCCESS", 40), ("SUCCESS", 1))
        self.assertEqual(self.check(), [])

    def test_rerun_deployment_counts_from_its_own_time(self):
        # A re-run of a 40-hour-old run deploys now; its run createdAt stays old.
        self.state["runs"] = [{"createdAt": iso(40), "conclusion": "success"}]
        self.deploy(("SUCCESS", 40), ("SUCCESS", 0))
        self.assertEqual(self.check(), [])

    def test_stale_deployment_opens_one_issue_and_recovery_closes_it(self):
        # A recent failed deployment must not count as a publication.
        self.deploy(("SUCCESS", 30), ("FAILURE", 1))
        self.assertEqual(self.check(), [(self.TITLE, "open")])
        self.assertIn("`active`", self.state["issues"][0]["body"])
        self.assertEqual(self.check(), [(self.TITLE, "open")])
        self.deploy(("SUCCESS", 30), ("FAILURE", 1), ("SUCCESS", 0))
        self.assertEqual(self.check(), [(self.TITLE, "closed")])
        self.assertEqual(self.check(), [(self.TITLE, "closed")])

    def test_never_published_is_overdue(self):
        self.assertEqual(self.check(), [(self.TITLE, "open")])
        self.assertIn("`never`", self.state["issues"][0]["body"])


class UpstreamWatchTest(WorkflowTest):
    UPSTREAM = "repos/DeckThemes/CSSLoader-Mappings"

    def setUp(self):
        super().setUp()
        self.state["api"]["repos/o/r/contents/webpack?ref=mapping-data"] = [{"name": "300.beta.json"}]
        self.upstream_head(BASELINE)

    def upstream_head(self, sha):
        self.state["api"][f"{self.UPSTREAM}/commits/main"] = {"sha": sha}
        self.state["api"][f"{self.UPSTREAM}/compare/{BASELINE}...{sha}"] = {
            "commits": [{"sha": sha, "commit": {"message": "New versions\n\ndetails",
                                                "committer": {"date": "2026-11-01T00:00:00Z"}}}],
            "files": [{"filename": "webpack/300.beta.json", "status": "modified"},
                      {"filename": "webpack/400.beta.json", "status": "added"},
                      {"filename": "README.md", "status": "modified"}]}

    def watch(self):
        result, _ = self.run_step("upstream-watch.yml", "Adopt or report new upstream commits", prepare=write_baseline)
        self.assertEqual(result.returncode, 0, result.stderr)
        return [(issue["title"], issue["state"]) for issue in self.state["issues"]]

    def test_unchanged_upstream_opens_nothing(self):
        self.assertEqual(self.watch(), [])

    def test_new_upstream_commits_open_one_issue_per_head(self):
        self.upstream_head("c" * 40)
        self.assertEqual(self.watch(), [("DeckThemes mappings changed: ccccccc", "open")])
        body = self.state["issues"][0]["body"]
        self.assertIn(f"compare/{BASELINE}...{'c' * 40}", body)
        self.assertIn("- `ccccccc` New versions (2026-11-01)", body)
        self.assertIn("not merged automatically because it changes files other than dumps and matches: "
                      "`README.md` (modified).", body)
        self.assertIn("- `webpack/300.beta.json` (also in mapping-data)", body)
        self.assertIn("- `webpack/400.beta.json`\n", body)
        self.assertEqual(self.watch(), [("DeckThemes mappings changed: ccccccc", "open")], "no duplicate")
        # Closing means "reviewed, not merged": the same head must not reopen an issue.
        self.state["issues"][0]["state"] = "closed"
        self.assertEqual(self.watch(), [("DeckThemes mappings changed: ccccccc", "closed")])
        self.upstream_head("d" * 40)
        self.assertEqual(self.watch()[-1], ("DeckThemes mappings changed: ddddddd", "open"))

    def test_truncated_file_list_is_reported(self):
        # GitHub stops at 300 files; the hidden rest may change scripts, so even data-only pages need review.
        self.upstream_head("c" * 40)
        self.state["api"][f"{self.UPSTREAM}/compare/{BASELINE}...{'c' * 40}"]["files"] = [
            {"filename": f"webpack/{n}.beta.json", "status": "added"} for n in range(1000, 1300)]
        self.assertEqual(self.watch(), [("DeckThemes mappings changed: ccccccc", "open")])
        self.assertIn("because it changes 300 or more files", self.state["issues"][0]["body"])


class DeckyWatchTest(WorkflowTest):
    STEP = "Open and close issues for Decky finders"

    @staticmethod
    def reports(failed, passed):
        """Write <check>/<name>.md reports and <check>/<name>.ok passes where the checks leave them."""
        def prepare(runner_temp):
            for marks, suffix in ((failed, "md"), (passed, "ok")):
                for check, names in marks.items():
                    folder = runner_temp / "steamui-watch" / "reports" / check
                    folder.mkdir(parents=True, exist_ok=True)
                    for name in names.split():
                        (folder / f"{name}.{suffix}").write_text(f"{check} {name}\n" if suffix == "md" else "")
        return prepare

    def watch(self, failed=None, passed=None):
        result, _ = self.run_step("decky-watch.yml", self.STEP, prepare=self.reports(failed or {}, passed or {}))
        self.assertEqual(result.returncode, 0, result.stderr)
        return [(issue["title"], issue["state"]) for issue in self.state["issues"]]

    def test_one_issue_per_check_and_client_version(self):
        self.assertEqual(self.watch(), [])
        self.assertEqual(self.watch({"static": "beta-200 stable-100", "runtime": "beta-200", "upgrade/4.16.0": "beta-200"}), [
            ("Decky finders missing in beta 200", "open"), ("Decky finders missing in stable 100", "open"),
            ("Decky runtime finders failing in beta 200", "open"),
            ("Decky finders failing with @decky/ui 4.16.0 in beta 200", "open")])
        self.assertEqual(self.state["issues"][2]["body"], "runtime beta-200\n")
        self.state["issues"][0]["state"] = "closed"
        self.assertEqual(self.watch({"static": "beta-200 stable-100 beta-2001", "runtime": "beta-200"})[4:], [
            ("Decky finders missing in beta 2001", "open")],
            "a closed issue is not reopened, and a version that extends another's number is not a duplicate")

    def test_a_pass_closes_reports_of_the_same_check_and_branch_up_to_its_version(self):
        self.watch({"static": "beta-200 stable-100", "runtime": "beta-200 stable-100", "upgrade/4.16.0": "beta-200"})
        self.assertEqual(self.watch(passed={"runtime": "beta-201 stable-99", "upgrade/4.17.0": "beta-200"}), [
            ("Decky finders missing in beta 200", "open"), ("Decky finders missing in stable 100", "open"),
            ("Decky runtime finders failing in beta 200", "closed"), ("Decky runtime finders failing in stable 100", "open"),
            ("Decky finders failing with @decky/ui 4.16.0 in beta 200", "closed")],
            "only the passing check closes; an older version's pass does not; a newer latest closes an older one's report")


class DeckyCopiesTest(WorkflowTest):
    """Report when the decky-loader fork moves past the loader finder copies in this repo."""

    FORK = "repos/beallio/decky-loader"

    def setUp(self):
        super().setUp()
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        (self.workspace / "decky_watch.py").write_text('LOADER = "decky-loader aaaaaaa"\n')
        self.fork(files=[])

    def fork(self, files):
        self.state["api"][f"{self.FORK}/compare/aaaaaaa...main"] = {"files": files}

    def watch(self):
        result, runner = self.run_step("decky-watch.yml", "Compare the finder copies with the decky-loader fork", cwd=self.workspace)
        self.assertEqual(result.returncode, 0, result.stderr)
        copy = lambda temp: shutil.copytree(runner / "steamui-watch", temp / "steamui-watch")
        result, _ = self.run_step("decky-watch.yml", DeckyWatchTest.STEP, prepare=copy)
        self.assertEqual(result.returncode, 0, result.stderr)
        return [issue["title"] for issue in self.state["issues"]]

    def test_unrelated_changes_open_nothing(self):
        self.fork(files=[
            {"filename": "frontend/src/components/Store.tsx", "patch": "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;"},
            {"filename": "backend-rust/src/main.rs", "patch": "@@ -1 +1 @@\n-findModule(\n+findModule(x"}])
        self.assertEqual(self.watch(), [])

    def test_finder_change_opens_one_issue_that_closes_when_the_copies_match(self):
        toaster = {"filename": "frontend/src/toaster.tsx",
                   "patch": "@@ -1,2 +1,2 @@\n context\n-    window.NotificationStore.Remove(group);\n+    window.NotificationStore.RemoveWhere(id);"}
        self.fork(files=[toaster])
        [title] = self.watch()
        self.assertRegex(title, r"^Decky finder copies out of date \([0-9a-f]{8}\)$")
        body = self.state["issues"][0]["body"]
        self.assertIn("frontend/src/toaster.tsx: +    window.NotificationStore.RemoveWhere(id);", body)
        self.assertIn("frontend/src/toaster.tsx: -    window.NotificationStore.Remove(group);", body)
        self.assertNotIn("context", body)
        self.assertEqual(self.watch(), [title], "the same difference opens no second issue")
        self.fork(files=[])
        self.watch()
        self.assertEqual(self.state["issues"][0]["state"], "closed", "copies that match the fork again close the open report")

    def test_missing_lock_version_fails(self):
        self.state["api"][f"{self.FORK}/contents/frontend/pnpm-lock.yaml"] = {"content": base64.b64encode(b"importers: {}\n").decode()}
        result, _ = self.run_step("decky-watch.yml", "Get @decky/ui")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no @decky/ui version", result.stderr)


class FinderSnapshotTest(WorkflowTest):
    """Save each client's first finder snapshot to finder-data, creating the branch on the first run."""

    def setUp(self):
        super().setUp()
        seed = self.tmp / "seed"
        seed.mkdir()
        (seed / "README.md").write_text("main")
        git("init", "-q", "-b", "main", cwd=seed)
        git("add", ".", cwd=seed)
        git("-c", "user.name=seed", "-c", "user.email=seed@test", "commit", "-qm", "seed", cwd=seed)
        git("clone", "-q", "--bare", str(seed), str(self.tmp / "remote.git"), cwd=self.tmp)
        self.state["remote"] = f"file://{self.tmp / 'remote.git'}"

    def save(self, **snapshots):
        def prepare(runner_temp):
            folder = runner_temp / "steamui-watch" / "snapshots"
            folder.mkdir(parents=True)
            for name, content in snapshots.items():
                (folder / f"{name}.json").write_text(content)
        result, _ = self.run_step("decky-watch.yml", "Save finder snapshots", prepare=prepare)
        self.assertEqual(result.returncode, 0, result.stderr)

    def branch(self, *args):
        return subprocess.run(["git", *args], cwd=self.tmp / "remote.git", check=True, capture_output=True, text=True).stdout

    def test_first_snapshot_per_version_is_kept_and_reruns_commit_nothing(self):
        self.save(stable_100="first")
        self.assertEqual(self.branch("ls-tree", "-r", "--name-only", "finder-data").split(), ["snapshots/stable_100.json"],
                         "the new branch holds only snapshots, not main's files")
        self.save(stable_100="second", beta_200="beta")
        self.assertEqual(self.branch("show", "finder-data:snapshots/stable_100.json"), "first")
        self.assertEqual(self.branch("show", "finder-data:snapshots/beta_200.json"), "beta")
        before = self.branch("rev-list", "--count", "finder-data")
        self.save(stable_100="third", beta_200="beta")
        self.assertEqual(self.branch("rev-list", "--count", "finder-data"), before)
        self.assertEqual(self.branch("log", "-1", "--format=%ae", "finder-data").strip(), BOT)

    def test_failed_run_saves_nothing_and_the_retry_sets_the_baseline(self):
        # runtime_probe.ts writes no snapshot when a finder fails.
        self.save()
        self.assertNotIn("finder-data", self.branch("branch"))
        self.save(stable_100="clean")
        self.assertEqual(self.branch("show", "finder-data:snapshots/stable_100.json"), "clean")



class UpstreamAdoptTest(WorkflowTest):
    """New upstream dumps and matches merge into mapping-data; riskier changes still open an issue."""

    def commit(self, repo, files, message):
        for name, text in files.items():
            (repo / name).parent.mkdir(parents=True, exist_ok=True)
            (repo / name).write_text(text)
        git("add", ".", cwd=repo)
        git("-c", "user.name=t", "-c", "user.email=t@test", "commit", "-qm", message, cwd=repo)
        return self.rev("HEAD", repo)

    def rev(self, ref, repo):
        return subprocess.run(["git", "rev-parse", ref], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()

    def setUp(self):
        super().setUp()
        self.upstream = self.tmp / "upstream"
        self.upstream.mkdir()
        git("init", "-q", "-b", "main", cwd=self.upstream)
        self.baseline = self.commit(self.upstream, {"webpack/100.stable.json": "{}", "webpack-mappings/shared.json": "a"}, "seed")
        self.upstream_git = self.tmp / "gh" / "DeckThemes" / "CSSLoader-Mappings.git"
        git("clone", "-q", "--bare", str(self.upstream), str(self.upstream_git), cwd=self.tmp)
        # mapping-data: the upstream snapshot plus a retained release with our reviewed matches.
        data = self.tmp / "data"
        git("clone", "-q", "-b", "main", str(self.upstream), str(data), cwd=self.tmp)
        git("checkout", "-qb", "mapping-data", cwd=data)
        self.commit(data, {"webpack/200.stable.json": "{}", "webpack-mappings/100to200.json": "reviewed"}, "ours")
        self.data_git = self.tmp / "data.git"
        git("clone", "-q", "--bare", str(data), str(self.data_git), cwd=self.tmp)
        self.data_tip = self.rev("mapping-data", self.data_git)
        self.state["remote"] = f"file://{self.data_git}"
        self.state["api"]["repos/o/r/contents/webpack?ref=mapping-data"] = [{"name": "100.stable.json"},
                                                                            {"name": "200.stable.json"}]
        self.state["api"]["repos/DeckThemes/CSSLoader-Mappings/commits/main"] = {"sha": self.baseline}
        main = self.tmp / "main"
        main.mkdir()
        git("init", "-q", "-b", "main", cwd=main)
        # Stand-in for css_mappings.py: checks the merged checkout, fails on request.
        self.commit(main, {".github/upstream-baseline": self.baseline + "\n", "css_mappings.py": textwrap.dedent('''
            import os, sys
            from pathlib import Path
            assert (Path(sys.argv[1]) / "webpack" / "200.stable.json").exists()
            sys.exit(int(os.environ.get("PIPELINE_EXIT", "0")))
        ''')}, "seed")
        self.main_git = self.tmp / "main.git"
        git("clone", "-q", "--bare", str(main), str(self.main_git), cwd=self.tmp)

    def upstream_change(self, files, message="New versions"):
        head = self.commit(self.upstream, files, message)
        git("push", "-q", str(self.upstream_git), "main", cwd=self.upstream)
        status = {"A": "added", "M": "modified", "D": "removed"}
        diff = subprocess.run(["git", "diff", "--name-status", self.baseline, head], cwd=self.upstream,
                              check=True, capture_output=True, text=True).stdout.splitlines()
        self.state["api"]["repos/DeckThemes/CSSLoader-Mappings/commits/main"] = {"sha": head}
        self.state["api"][f"repos/DeckThemes/CSSLoader-Mappings/compare/{self.baseline}...{head}"] = {
            "commits": [{"sha": head, "commit": {"message": message, "committer": {"date": "2026-11-01T00:00:00Z"}}}],
            "files": [{"filename": name, "status": status[code]} for code, name in (line.split("\t") for line in diff)]}
        return head

    def watch(self, **env):
        workspace = self.tmp / f"workspace{self.runners}"
        git("clone", "-q", "--depth", "1", f"file://{self.main_git}", str(workspace), cwd=self.tmp)
        result, _ = self.run_step("upstream-watch.yml", "Adopt or report new upstream commits", cwd=workspace,
                                  GITHUB_SERVER_URL=f"file://{self.tmp / 'gh'}", **env)
        self.assertEqual(result.returncode, 0, result.stderr)

    def remote_baseline(self):
        return subprocess.run(["git", "show", "main:.github/upstream-baseline"], cwd=self.main_git,
                              check=True, capture_output=True, text=True).stdout.strip()

    def show(self, path):
        return subprocess.run(["git", "show", f"mapping-data:{path}"], cwd=self.data_git,
                              check=True, capture_output=True, text=True).stdout

    def assert_reported(self, head, reason):
        self.assertEqual([i["title"] for i in self.state["issues"]], [f"DeckThemes mappings changed: {head[:7]}"])
        self.assertIn(f"not merged automatically because {reason}", self.state["issues"][0]["body"])
        self.assertEqual(self.remote_baseline(), self.baseline)
        self.assertEqual(self.show("webpack-mappings/100to200.json"), "reviewed")
        self.assertEqual(self.rev("mapping-data", self.data_git), self.data_tip)

    def test_newer_dumps_and_match_fixes_merge_without_an_issue(self):
        head = self.upstream_change({"webpack/300.stable.json": "{}", "webpack-mappings/100to300.json": "{}",
                                     "webpack-mappings/shared.json": "fixed"})
        self.watch()
        self.assertEqual(self.state["issues"], [])
        self.assertEqual(self.remote_baseline(), head)
        self.assertEqual(self.show("webpack-mappings/shared.json"), "fixed")
        self.assertEqual(self.show("webpack-mappings/100to200.json"), "reviewed")
        self.assertEqual(self.show("webpack/300.stable.json"), "{}")
        self.watch()
        self.assertEqual(self.state["issues"], [], "an adopted head needs no issue")

    def test_older_upstream_dump_is_reported(self):
        head = self.upstream_change({"webpack/150.stable.json": "{}"})
        self.watch()
        self.assert_reported(head, "`webpack/150.stable.json` is not newer than our `webpack/200.stable.json`.")

    def test_older_dump_is_reported_when_upstream_also_has_ours(self):
        head = self.upstream_change({"webpack/150.stable.json": "{}", "webpack/200.stable.json": "{}"})
        self.watch()
        self.assert_reported(head, "`webpack/150.stable.json` is not newer than our `webpack/200.stable.json`.")

    def test_conflict_is_reported(self):
        head = self.upstream_change({"webpack-mappings/100to200.json": "theirs", "webpack/200.stable.json": "{}"})
        self.watch()
        self.assert_reported(head, "it conflicts with mapping-data in `webpack-mappings/100to200.json`.")

    def test_pipeline_failure_is_reported(self):
        head = self.upstream_change({"webpack/300.stable.json": "{}"})
        self.watch(PIPELINE_EXIT="1")
        self.assert_reported(head, "the mapping pipeline fails on the merged data")


class KeepaliveTest(WorkflowTest):
    def commit_log(self):
        return subprocess.run(["git", "log", "--format=%s", "main"], cwd=self.tmp / "remote.git",
                              check=True, capture_output=True, text=True).stdout.splitlines()

    def last_commit_days_ago(self, days):
        seed = self.tmp / "seed"
        seed.mkdir()
        (seed / "README.md").write_text("x")
        git("init", "-q", "-b", "main", cwd=seed)
        git("add", ".", cwd=seed)
        when = f"{int(datetime.now(timezone.utc).timestamp()) - days * 86400} +0000"
        subprocess.run(["git", "-c", "user.name=seed", "-c", "user.email=seed@test", "commit", "-qm", "seed"],
                       cwd=seed, check=True, env={**os.environ, "GIT_AUTHOR_DATE": when, "GIT_COMMITTER_DATE": when})
        git("clone", "-q", "--bare", str(seed), str(self.tmp / "remote.git"), cwd=self.tmp)

    def keepalive(self):
        workspace = self.tmp / f"workspace{self.runners}"
        git("clone", "-q", "--depth", "1", f"file://{self.tmp / 'remote.git'}", str(workspace), cwd=self.tmp)
        result, _ = self.run_step("watchdog.yml", "Keep the schedules active", cwd=workspace)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_quiet_repository_gets_one_empty_commit(self):
        self.last_commit_days_ago(50)
        self.keepalive()
        log = self.commit_log()
        self.assertEqual(len(log), 2)
        self.assertTrue(log[0].startswith("chore: keep scheduled workflows active (50 days"), log[0])
        tree = lambda ref: subprocess.run(["git", "rev-parse", f"{ref}^{{tree}}"], cwd=self.tmp / "remote.git",
                                          check=True, capture_output=True, text=True).stdout
        self.assertEqual(tree("main"), tree("main~1"), "the keepalive commit must not change files")
        self.keepalive()
        self.assertEqual(len(self.commit_log()), 2, "a fresh commit needs no second keepalive")

    def test_recent_commit_needs_no_keepalive(self):
        self.last_commit_days_ago(44)
        self.keepalive()
        self.assertEqual(self.commit_log(), ["seed"])


if __name__ == "__main__":
    unittest.main()
