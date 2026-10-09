import ast
import contextlib
import io
import json
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('providence_tunnel_supervisor', Path(__file__).with_name('providence-tunnel-supervisor.py'))
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
PIN = 'a' * 64


class FakeBackend:
    def __init__(self):
        self.processes = {85: module.Process(85, 'Sat Sep 19 19:05:48 2026', '/usr/bin/ssh', module.SSH_COMMAND)}
        self.pin = PIN
        self.spawns = []
        self.spawn_errors = []

    def config_hash(self):
        return self.pin

    def snapshot(self, pid):
        return self.processes.get(pid)

    def matching(self):
        return [p for p in self.processes.values() if module.matching_forward(p.argv)]

    def spawn(self, command):
        self.spawns.append(command)
        if self.spawn_errors:
            raise self.spawn_errors.pop(0)
        pid = 100 + len(self.spawns)
        process = module.Process(pid, 'Sat Sep 19 19:06:00 2026', '/usr/bin/ssh', command)
        self.processes[pid] = process
        return process

    def exit_info(self, pid):
        return module.SSHExited(None)


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.now = 0.0
        self.events = []
        self.supervisor = module.Supervisor(self.backend, PIN, self.events.append, lambda: self.now)

    def adopt(self):
        self.supervisor.adopt(85, 'Sat Sep 19 19:05:48 2026')

    def test_adoption_and_healthy_poll_never_spawn(self):
        self.adopt()
        for _ in range(5):
            self.now += 5
            self.assertEqual(self.supervisor.step(), 5)
        self.assertEqual(self.backend.spawns, [])
        self.assertEqual(self.events[0]['status'], 'adopted')

    def test_exit_reconnects_only_after_backoff_with_exact_command(self):
        self.adopt()
        del self.backend.processes[85]
        self.assertEqual(self.supervisor.step(), 1)
        self.assertEqual(self.backend.spawns, [])
        self.now = .5
        self.assertEqual(self.supervisor.step(), .5)
        self.now = 1
        self.supervisor.step()
        self.assertEqual(self.backend.spawns, [module.SSH_COMMAND])
        self.assertEqual(self.supervisor.current.pid, 101)

    def test_transient_exit_backoff_is_bounded_and_not_busy_looped(self):
        self.adopt()
        del self.backend.processes[85]
        delays = [self.supervisor.step()]
        self.backend.spawn_errors = [module.SSHExited(255, 'Connection timed out')] * 7
        for _ in range(7):
            self.now = self.supervisor.next_attempt
            delays.append(self.supervisor.step())
        self.assertEqual(delays, [1, 2, 4, 8, 16, 30, 30, 30])
        self.assertTrue(all(command == module.SSH_COMMAND for command in self.backend.spawns))

    def test_reused_pid_and_wrong_adoption_identity_fail_closed(self):
        with self.assertRaises(module.Blocked):
            self.supervisor.adopt(85, 'different start')
        self.adopt()
        self.backend.processes[85] = module.Process(85, 'new start', '/usr/bin/ssh', module.SSH_COMMAND)
        with self.assertRaisesRegex(module.Blocked, 'identity_changed'):
            self.supervisor.step()
        self.assertEqual(self.backend.spawns, [])

    def test_duplicate_forward_prevents_adoption_or_recovery(self):
        self.backend.processes[86] = module.Process(86, 'other start', '/usr/bin/ssh', module.SSH_COMMAND)
        with self.assertRaisesRegex(module.Blocked, 'another_matching'):
            self.adopt()
        self.assertEqual(self.backend.spawns, [])
        del self.backend.processes[86]
        self.adopt()
        del self.backend.processes[85]
        self.supervisor.step()
        self.backend.processes[86] = module.Process(86, 'other start', '/usr/bin/ssh', module.SSH_COMMAND)
        self.now = 1
        self.assertEqual(self.supervisor.step(), module.POLL_SECONDS)
        self.assertEqual(self.events[-1]['status'], 'waiting_for_sole_forward')
        self.assertEqual(self.backend.spawns, [])
        del self.backend.processes[86]
        self.supervisor.step()
        self.assertEqual(self.backend.spawns, [module.SSH_COMMAND])

    def test_config_drift_prevents_adoption_and_exit_retry(self):
        self.backend.pin = 'b' * 64
        with self.assertRaisesRegex(module.Blocked, 'config_changed'):
            self.adopt()
        self.backend.pin = PIN
        self.adopt()
        del self.backend.processes[85]
        self.supervisor.step()
        self.backend.pin = 'b' * 64
        self.now = 1
        with self.assertRaisesRegex(module.Blocked, 'config_changed'):
            self.supervisor.step()
        self.assertEqual(self.backend.spawns, [])

    def test_auth_or_host_identity_failure_halts_retry(self):
        for diagnostic in ('Permission denied (publickey).', 'Host key verification failed.',
                           'REMOTE HOST IDENTIFICATION HAS CHANGED!'):
            backend = FakeBackend()
            supervisor = module.Supervisor(backend, PIN, lambda _: None, lambda: 1)
            backend.processes.clear()
            backend.spawn_errors.append(module.SSHExited(255, diagnostic))
            with self.assertRaises(module.Blocked):
                supervisor.step()
            self.assertEqual(len(backend.spawns), 1)

    def test_bind_and_unreachable_failures_retry_through_backoff(self):
        for diagnostic, reason in (
                ('Warning: remote port forwarding failed for listen port 18787', 'forward_bind_failed'),
                ('bind: Address already in use', 'forward_bind_failed'),
                ('ssh: Could not resolve hostname providence-server: nodename nor servname provided', 'ssh_host_unreachable'),
                ('ssh: connect to host providence-server port 22: Network is unreachable', 'ssh_host_unreachable')):
            events, clock = [], [1.0]
            backend = FakeBackend()
            backend.processes.clear()
            supervisor = module.Supervisor(backend, PIN, events.append, lambda: clock[0])
            backend.spawn_errors.append(module.SSHExited(255, diagnostic))
            self.assertEqual(supervisor.step(), 1)
            self.assertEqual(events[-1]['status'], 'waiting_after_exit')
            self.assertEqual(events[-1]['reason'], reason)
            clock[0] = supervisor.next_attempt
            supervisor.step()
            self.assertEqual(len(backend.spawns), 2)

    def test_local_config_parse_is_not_misidentified_as_competing_forward(self):
        self.assertFalse(module.matching_forward(module.CONFIG_COMMAND))
        alternate = (*module.SSH_COMMAND[:-3], '-R', '18787:localhost:8787', 'providence-server')
        self.assertTrue(module.matching_forward(alternate))

    def test_single_owner_lock_and_release(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'supervisor.lock'
            first = module.lock_owner(path)
            try:
                with self.assertRaisesRegex(module.Blocked, 'owns_lock'):
                    module.lock_owner(path)
            finally:
                os.close(first)
            second = module.lock_owner(path)
            os.close(second)
            self.assertTrue(path.exists())

    def test_state_write_survives_a_stale_temporary_file(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            stale = directory / f'state-{os.getpid()}.tmp'
            stale.write_bytes(b'leftover from a crashed run with this pid')
            log = os.open(directory / 'supervisor.log', os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                emit = module.state_writer(directory, log, PIN)
                emit({'status': 'adopted'})
                emit({'status': 'monitoring_process'})
            finally:
                os.close(log)
            record = json.loads((directory / 'state.json').read_text())
            self.assertEqual(record['status'], 'monitoring_process')
            self.assertEqual(record['configSha256'], PIN)
            self.assertFalse(stale.exists())

    def test_blocked_reporter_falls_back_to_stderr_json(self):
        def refuse(_):
            raise OSError('state directory is gone')
        supervisor = module.Supervisor(self.backend, PIN, refuse, lambda: self.now)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            module.report_blocked(supervisor, 'effective_ssh_config_changed')
        self.assertEqual(json.loads(stderr.getvalue()),
                         {'status': 'blocked_connection_untouched', 'reason': 'effective_ssh_config_changed'})

    def test_source_contains_no_process_signal_or_http_calls(self):
        tree = ast.parse(Path(module.__file__).read_text())
        forbidden = {'kill', 'killpg', 'terminate', 'send_signal', 'urlopen'}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                self.assertNotIn(node.func.attr, forbidden)


if __name__ == '__main__':
    unittest.main()
