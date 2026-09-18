import json
import os
import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest.mock import patch

from scenarios.dependencies import format_markdown_table
from scenarios.synapse_runtime import (
    SynapseRuntime,
    prepare_synapse_runtime,
    run_node_script,
)
from scenarios.test_multi_copy_upload import setup_filecoin_pin
from scenarios import test_fwss_lifecycle


class ScenarioDependencyTests(unittest.TestCase):
    def test_fwss_lifecycle_overrides_hostile_inherited_connection_env(self):
        local_rpc = "http://127.0.0.1:2345/rpc/v1"
        local_key = "0x" + "11" * 32
        with tempfile.TemporaryDirectory() as base_directory:
            base = Path(base_directory)
            info_path = base / "state" / "latest" / "devnet-info.json"
            info_path.parent.mkdir(parents=True)
            info_path.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "info": {
                            "lotus": {"host_rpc_url": local_rpc},
                            "users": [
                                {
                                    "evm_addr": "0x" + "22" * 20,
                                    "private_key_hex": local_key,
                                }
                            ],
                        },
                    }
                )
            )

            def prepare(directory):
                return SynapseRuntime(
                    Path(directory).resolve(),
                    "npm",
                    "npm:@filoz/synapse-sdk@1.1.1",
                )

            def write_file(path, _size, _seed):
                path.write_bytes(b"x")

            hostile = {
                "FOC_DEVNET_BASEDIR": str(base),
                "DEVNET_INFO_PATH": "/attacker/devnet-info.json",
                "RPC_URL": "https://attacker.invalid/rpc",
                "PRIVATE_KEY": "0x" + "ff" * 32,
                "DEVNET_USER_INDEX": "0",
            }
            with (
                patch.dict(os.environ, hostile, clear=False),
                patch.object(test_fwss_lifecycle, "RAND_FILE_SIZE", 1),
                patch.object(test_fwss_lifecycle, "assert_ok"),
                patch.object(
                    test_fwss_lifecycle,
                    "prepare_synapse_runtime",
                    side_effect=prepare,
                ),
                patch.object(
                    test_fwss_lifecycle,
                    "write_random_file",
                    side_effect=write_file,
                ),
                patch.object(test_fwss_lifecycle, "run_node_script") as run_node,
            ):
                test_fwss_lifecycle.run()

        runtime_env = run_node.call_args.kwargs["env"]
        self.assertEqual(runtime_env["RPC_URL"], local_rpc)
        self.assertEqual(runtime_env["PRIVATE_KEY"], local_key)
        self.assertEqual(runtime_env["DEVNET_INFO_PATH"], str(info_path.resolve()))

    def test_dependency_table_contains_all_resolved_components(self):
        metadata = {
            "components": {
                "lotus": {
                    "source": "git",
                    "ref": "v1.2.3",
                    "commit": "aaa",
                },
                "synapse-sdk": {
                    "source": "git",
                    "version": "0.41.0",
                    "commit": "bbb",
                    "overrides": {"nanoid": {"version": "3.3.13", "reason": "test"}},
                },
                "filecoin-pin": {
                    "source": "npm",
                    "version": "1.0.1",
                    "commit": "ccc",
                },
            }
        }
        table = format_markdown_table(metadata)
        for expected in (
            "lotus",
            "synapse-sdk",
            "filecoin-pin",
            "nanoid",
            "aaa",
            "1.0.1",
            "3.3.13",
        ):
            self.assertIn(expected, table)

    @patch("scenarios.synapse_runtime._copy_scenarios")
    @patch("scenarios.synapse_runtime.run_cmd", return_value=True)
    @patch(
        "scenarios.synapse_runtime.component",
        return_value={
            "source": "npm",
            "package": "@filoz/synapse-sdk",
            "version": "1.1.1",
            "runtime_dependencies": {
                "@filoz/synapse-core": "1.1.1",
                "viem": "2.52.0",
            },
            "overrides": {"nanoid": {"version": "3.3.13", "reason": "test"}},
        },
    )
    def test_npm_runtime_installs_exact_consumer_manifest(
        self, _component, run_cmd, _copy_scenarios
    ):
        with tempfile.TemporaryDirectory() as directory:
            runtime = prepare_synapse_runtime(Path(directory))
            manifest = json.loads((Path(directory) / "package.json").read_text())

        self.assertEqual(runtime.source, "npm")
        self.assertEqual(
            manifest["dependencies"],
            {
                "@filoz/synapse-sdk": "1.1.1",
                "@filoz/synapse-core": "1.1.1",
                "viem": "2.52.0",
            },
        )
        self.assertEqual(manifest["overrides"], {"nanoid": "3.3.13"})
        self.assertEqual(
            run_cmd.call_args.args[0],
            [
                "npm",
                "install",
                "--omit=dev",
                "--ignore-scripts",
                "--package-lock=false",
            ],
        )

    @patch("scenarios.synapse_runtime._copy_scenarios")
    @patch("scenarios.synapse_runtime.run_cmd", return_value=True)
    @patch(
        "scenarios.synapse_runtime._npm_view",
        side_effect=[
            {
                "dependencies": {"@filoz/synapse-core": "^1.1.1"},
                "peerDependencies": {"viem": "2.x"},
            },
            "1.1.1",
            ["2.0.0", "2.52.0"],
        ],
    )
    @patch(
        "scenarios.synapse_runtime.component",
        return_value={
            "source": "npm",
            "package": "@filoz/synapse-sdk",
            "version": "1.1.1",
        },
    )
    def test_npm_runtime_resolves_fallback_consumer_dependencies(
        self, _component, npm_view, run_cmd, _copy_scenarios
    ):
        with tempfile.TemporaryDirectory() as directory:
            prepare_synapse_runtime(Path(directory))
            manifest = json.loads((Path(directory) / "package.json").read_text())

        self.assertEqual(
            manifest["dependencies"],
            {
                "@filoz/synapse-sdk": "1.1.1",
                "@filoz/synapse-core": "1.1.1",
                "viem": "2.52.0",
            },
        )
        self.assertEqual(
            npm_view.call_args_list[0].args,
            (
                "@filoz/synapse-sdk",
                "1.1.1",
                "dependencies",
                "peerDependencies",
            ),
        )

    @patch("scenarios.synapse_runtime._copy_scenarios")
    @patch("scenarios.synapse_runtime.run_cmd", return_value=True)
    @patch(
        "scenarios.synapse_runtime.component",
        return_value={
            "source": "pkg_pr_new",
            "package": "@filoz/synapse-sdk",
            "version": "https://pkg.pr.new/@filoz/synapse-sdk@deadbeef",
            "commit": "deadbeef",
            "runtime_dependencies": {
                "@filoz/synapse-core": (
                    "https://pkg.pr.new/@filoz/synapse-core@deadbeef"
                ),
                "viem": "2.52.0",
            },
        },
    )
    def test_preview_runtime_installs_immutable_consumer_manifest(
        self, _component, run_cmd, _copy_scenarios
    ):
        with tempfile.TemporaryDirectory() as directory:
            runtime = prepare_synapse_runtime(Path(directory))
            manifest = json.loads((Path(directory) / "package.json").read_text())

        self.assertEqual(runtime.source, "pkg_pr_new")
        self.assertEqual(
            runtime.provenance,
            "pkg_pr_new:@filoz/synapse-sdk@deadbeef",
        )
        self.assertEqual(
            manifest["dependencies"],
            {
                "@filoz/synapse-sdk": (
                    "https://pkg.pr.new/@filoz/synapse-sdk@deadbeef"
                ),
                "@filoz/synapse-core": (
                    "https://pkg.pr.new/@filoz/synapse-core@deadbeef"
                ),
                "viem": "2.52.0",
            },
        )
        self.assertEqual(
            run_cmd.call_args.args[0],
            [
                "npm",
                "install",
                "--omit=dev",
                "--ignore-scripts",
                "--package-lock=false",
            ],
        )

    @patch("scenarios.synapse_runtime.ok")
    @patch("scenarios.synapse_runtime.info")
    @patch("scenarios.synapse_runtime.subprocess.run")
    def test_run_node_script_uses_consumer_cwd_and_env(self, run, _info, ok):
        run.return_value = subprocess.CompletedProcess(
            ["node", "smoke.ts"], 0, stdout="done\n", stderr=""
        )
        with tempfile.TemporaryDirectory() as directory:
            work_dir = Path(directory)
            (work_dir / "smoke.ts").touch()
            run_node_script(
                SynapseRuntime(work_dir, "npm", "npm:@filoz/synapse-sdk@1.1.1"),
                "smoke.ts",
                "run smoke",
                args=["random_file"],
                env={"DEVNET_USER_INDEX": "1"},
                timeout=30,
            )

        kwargs = run.call_args.kwargs
        self.assertEqual(
            run.call_args.args[0], ["node", str(work_dir / "smoke.ts"), "random_file"]
        )
        self.assertEqual(kwargs["cwd"], str(work_dir))
        self.assertEqual(kwargs["env"]["DEVNET_USER_INDEX"], "1")
        self.assertEqual(kwargs["timeout"], 30)
        ok.assert_called_once_with("run smoke")

    @patch("scenarios.synapse_runtime.time.sleep")
    @patch("scenarios.synapse_runtime.ok")
    @patch("scenarios.synapse_runtime.info")
    @patch("scenarios.synapse_runtime.subprocess.run")
    def test_run_node_script_retries_state_fork_error(self, run, _info, ok, sleep):
        run.side_effect = [
            subprocess.CompletedProcess(
                ["node", "smoke.ts"],
                1,
                stdout="",
                stderr="refusing explicit call due to state fork at epoch 42",
            ),
            subprocess.CompletedProcess(
                ["node", "smoke.ts"], 0, stdout="done\n", stderr=""
            ),
        ]

        with tempfile.TemporaryDirectory() as directory:
            work_dir = Path(directory)
            (work_dir / "smoke.ts").touch()
            run_node_script(
                SynapseRuntime(work_dir, "npm", "npm:@filoz/synapse-sdk@1.1.1"),
                "smoke.ts",
                "run smoke",
            )

        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(5)
        ok.assert_called_once_with("run smoke")

    @patch("scenarios.synapse_runtime.fail")
    @patch("scenarios.synapse_runtime.time.sleep")
    @patch("scenarios.synapse_runtime.subprocess.run")
    def test_run_node_script_can_disable_state_fork_retry(self, run, sleep, fail):
        run.return_value = subprocess.CompletedProcess(
            ["node", "lifecycle.ts"],
            1,
            stdout="",
            stderr="refusing explicit call due to state fork at epoch 42",
        )

        with tempfile.TemporaryDirectory() as directory:
            work_dir = Path(directory)
            (work_dir / "lifecycle.ts").touch()
            run_node_script(
                SynapseRuntime(work_dir, "npm", "npm:@filoz/synapse-sdk@1.1.1"),
                "lifecycle.ts",
                "run lifecycle",
                retry_state_forks=False,
            )

        run.assert_called_once()
        sleep.assert_not_called()
        fail.assert_called_once()

    @patch("scenarios.test_multi_copy_upload.run_cmd", return_value=True)
    @patch(
        "scenarios.test_multi_copy_upload.component",
        return_value={
            "source": "npm",
            "version": "1.0.1",
            "overrides": {"nanoid": {"version": "3.3.13", "reason": "test"}},
        },
    )
    def test_filecoin_pin_npm_install_path(self, _component, run_cmd):
        with tempfile.TemporaryDirectory() as directory:
            command, dependency_dir = setup_filecoin_pin(Path(directory))
        self.assertTrue(command[0].endswith("node_modules/.bin/filecoin-pin"))
        self.assertEqual(dependency_dir, Path(directory))
        self.assertIn(
            "dependencies.filecoin-pin=1.0.1",
            run_cmd.call_args_list[1].args[0],
        )
        self.assertIn(
            "dependencies.nanoid=3.3.13",
            run_cmd.call_args_list[1].args[0],
        )
        self.assertIn(
            "overrides.nanoid=3.3.13",
            run_cmd.call_args_list[1].args[0],
        )

    @patch("scenarios.test_multi_copy_upload.run_cmd", return_value=True)
    @patch(
        "scenarios.test_multi_copy_upload.component",
        return_value={
            "source": "git",
            "repository": "https://example.test/filecoin-pin.git",
            "commit": "deadbeef",
        },
    )
    def test_filecoin_pin_frontier_build_path(self, _component, run_cmd):
        with tempfile.TemporaryDirectory() as directory:
            command, dependency_dir = setup_filecoin_pin(Path(directory))
        self.assertEqual(command[0], "node")
        self.assertTrue(command[1].endswith("filecoin-pin/dist/cli.js"))
        self.assertTrue(str(dependency_dir).endswith("filecoin-pin"))
        commands = [call.args[0] for call in run_cmd.call_args_list]
        self.assertIn(["git", "checkout", "--detach", "deadbeef"], commands)
        self.assertNotIn(["pnpm", "pkg", "set"], [command[:3] for command in commands])
        self.assertIn(
            ["pnpm", "install", "--frozen-lockfile", "--filter", "filecoin-pin..."],
            commands,
        )
        self.assertIn(["pnpm", "build"], commands)


if __name__ == "__main__":
    unittest.main()
