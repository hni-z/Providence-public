#!/usr/bin/env python3
"""Mac-only supervisor for one existing Providence SSH reverse forward.

The operator must verify the PID/start and local `ssh -G` hash immediately before
launch, then detach THIS program. Adoption never signals/replaces the existing SSH.
Only confirmed process exit causes recovery. No HTTP health checks, process kills,
credential copies, service changes, login/reboot registration, or remote commands.
State/logs: ~/.local/share/providence-tunnel (owned 0700, files owned 0600).
"""
import argparse
import ctypes
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
import time

SSH_COMMAND = (
    '/usr/bin/ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    # Tailscale alias. providence-server-public is the operator's fallback entry when the
    # tailnet is down; swapping it changes the pinned effective-config hash.
    '-R', '127.0.0.1:18787:127.0.0.1:8787', 'providence-server',
)
CONFIG_COMMAND = (SSH_COMMAND[0], '-G', *SSH_COMMAND[1:])
POLL_SECONDS = 5
MAX_BACKOFF_SECONDS = 30
# Only a credential or host-identity problem stays broken until an operator looks at
# it. Everything else clears on its own, so exiting would leave nothing to reconnect.
TERMINAL_REASONS = frozenset({'ssh_auth_or_host_identity_failed'})
DUPLICATE_REASON = 'another_matching_local_forward_exists'


class Blocked(RuntimeError):
    pass


@dataclass(frozen=True)
class Process:
    pid: int
    started: str
    executable: str
    argv: tuple


class SSHExited(Exception):
    def __init__(self, code, diagnostic=''):
        self.code, self.diagnostic = code, diagnostic


def matching_forward(argv):
    if 'providence-server' not in argv or '-G' in argv:
        return False
    forwards = []
    for index, value in enumerate(argv):
        if value == '-R' and index + 1 < len(argv):
            forwards.append(argv[index + 1])
        elif value.startswith('-R') and len(value) > 2:
            forwards.append(value[2:])
    # Include alternate bind addresses/targets on this same remote port: fail closed.
    return any(re.search(r'(^|:)18787:', value) for value in forwards)


def exit_reason(diagnostic):
    text = diagnostic.lower()
    if ('remote port forwarding failed' in text or 'cannot listen to port' in text
            or 'address already in use' in text):
        return 'forward_bind_failed'
    if any(value in text for value in ('could not resolve hostname', 'name or service not known',
                                       'nodename nor servname', 'network is unreachable')):
        return 'ssh_host_unreachable'
    if any(value in text for value in ('permission denied', 'host key verification failed',
                                       'remote host identification has changed')):
        return 'ssh_auth_or_host_identity_failed'
    return None


class Supervisor:
    def __init__(self, backend, config_hash, emit, clock=time.monotonic):
        self.backend, self.config_hash, self.emit, self.clock = backend, config_hash, emit, clock
        self.current = None
        self.failures = 0
        self.next_attempt = 0.0
        self.started_monitoring = 0.0

    def config_guard(self):
        if self.backend.config_hash() != self.config_hash:
            raise Blocked('effective_ssh_config_changed')

    def duplicate_guard(self, allowed=None):
        processes = self.backend.matching()
        if any(process.pid != allowed for process in processes):
            raise Blocked(DUPLICATE_REASON)

    def adopt(self, pid, started):
        self.config_guard()
        process = self.backend.snapshot(pid)
        if process is None or process.started != ' '.join(started.split()):
            raise Blocked('adoption_pid_or_start_mismatch')
        if process.argv != SSH_COMMAND or process.executable != '/usr/bin/ssh':
            raise Blocked('adoption_command_mismatch')
        self.duplicate_guard(pid)
        self.current = process
        self.started_monitoring = self.clock()
        self.report('adopted')

    def report(self, status, **extra):
        self.emit({'status': status, 'sshPid': self.current.pid if self.current else None,
                   'sshStarted': self.current.started if self.current else None,
                   'consecutiveExits': self.failures, **extra})

    def exited(self, exit_info):
        reason = exit_reason(exit_info.diagnostic)
        if reason in TERMINAL_REASONS:
            raise Blocked(reason)
        self.failures += 1
        delay = min(MAX_BACKOFF_SECONDS, 2 ** min(self.failures - 1, 5))
        self.next_attempt = self.clock() + delay
        self.report('waiting_after_exit', exitCode=exit_info.code, retryAfterSeconds=delay,
                    **({'reason': reason} if reason else {}))
        return delay

    def step(self):
        try:
            return self.attempt()
        except Blocked as error:
            if str(error) != DUPLICATE_REASON:
                raise
            # The documented manual recovery is itself a second forward. Keep refusing
            # to spawn, but stay alive so this supervisor is here when that one ends.
            self.report('waiting_for_sole_forward', reason=DUPLICATE_REASON)
            return POLL_SECONDS

    def attempt(self):
        if self.current:
            process = self.backend.snapshot(self.current.pid)
            if process is not None:
                if process != self.current:
                    raise Blocked('owned_pid_identity_changed')
                self.duplicate_guard(self.current.pid)
                if self.clock() - self.started_monitoring >= 60:
                    self.failures = 0
                return POLL_SECONDS
            previous = self.current
            self.current = None
            self.duplicate_guard()
            return self.exited(self.backend.exit_info(previous.pid))
        remaining = self.next_attempt - self.clock()
        if remaining > 0:
            return min(POLL_SECONDS, remaining)
        self.config_guard()
        self.duplicate_guard()
        self.report('starting_same_forward')
        try:
            self.current = self.backend.spawn(SSH_COMMAND)
        except SSHExited as error:
            return self.exited(error)
        if self.current.argv != SSH_COMMAND or self.current.executable != '/usr/bin/ssh':
            raise Blocked('spawned_process_identity_unverified')
        self.duplicate_guard(self.current.pid)
        self.started_monitoring = self.clock()
        self.report('monitoring_process')
        return POLL_SECONDS


def capture(arguments):
    # No timeout helper that terminates children: a stuck local inspection blocks
    # this supervisor without signalling the diagnostic or the existing tunnel.
    # SSH config parsing inherits the same environment as the eventual fixed
    # SSH command. Only ps needs a stable locale for its start-time format.
    environment = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C'} if arguments[0] == '/bin/ps' else None
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=environment)
    try:
        output, _ = process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        raise Blocked('local_inspection_timed_out')
    if process.returncode not in (0, 1):
        raise Blocked('local_inspection_failed')
    return process.returncode, output


class MacProcesses:
    def __init__(self, ssh_log):
        self.ssh_log = ssh_log
        self.children = {}

    def config_hash(self):
        code, output = capture(CONFIG_COMMAND)
        if code:
            raise Blocked('effective_ssh_config_unavailable')
        return hashlib.sha256(output).hexdigest()  # Never log raw effective config.

    def snapshot(self, pid):
        child = self.children.get(pid)
        if child and child[0].poll() is not None:
            return None
        code, output = capture(['/bin/ps', '-p', str(pid), '-o', 'lstart=,stat=,comm='])
        if code == 1 or not output.strip():
            return None
        fields = output.decode().strip().split(None, 6)
        if len(fields) != 7:
            raise Blocked('process_start_identity_unreadable')
        if 'Z' in fields[5]:
            return None
        started = ' '.join(fields[:5])
        # KERN_PROCARGS2 is used only for the executable and argc argv entries.
        # The environment region is never decoded, inspected or retained.
        libc = ctypes.CDLL(None, use_errno=True)
        mib = (ctypes.c_int * 3)(1, 49, pid)
        size = ctypes.c_size_t(1024 * 1024)
        buffer = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
            code, _ = capture(['/bin/ps', '-p', str(pid), '-o', 'pid='])
            if code == 1:
                return None
            raise Blocked('process_argv_unreadable')
        payload = buffer.raw[:size.value]
        argc = struct.unpack('i', payload[:4])[0]
        if not 1 <= argc <= 4096:
            raise Blocked('process_argv_unreadable')
        end = payload.index(b'\0', 4)
        executable = payload[4:end].decode()
        pos = end + 1
        while payload[pos] == 0:
            pos += 1
        argv = []
        for _ in range(argc):
            end = payload.index(b'\0', pos)
            argv.append(payload[pos:end].decode())
            pos = end + 1
        return Process(pid, started, executable, tuple(argv))

    def matching(self):
        code, output = capture(['/bin/ps', '-axo', 'pid=,uid=,comm='])
        if code:
            raise Blocked('matching_process_inventory_failed')
        processes = []
        for line in output.decode().splitlines():
            fields = line.strip().split(None, 2)
            if len(fields) == 3 and int(fields[1]) == os.getuid() and Path(fields[2]).name == 'ssh':
                process = self.snapshot(int(fields[0]))
                if process and matching_forward(process.argv):
                    processes.append(process)
        return processes

    def spawn(self, arguments):
        if tuple(arguments) != SSH_COMMAND:
            raise Blocked('non_fixed_command_refused')
        offset = os.lseek(self.ssh_log, 0, os.SEEK_END)
        child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=self.ssh_log,
                                 stderr=self.ssh_log, start_new_session=True, close_fds=True)
        self.children[child.pid] = (child, offset)
        process = self.snapshot(child.pid)
        if process is None:
            raise self.exit_info(child.pid)
        return process

    def exit_info(self, pid):
        child = self.children.pop(pid, None)
        if child is None:
            return SSHExited(None)  # Adopted non-child: no invented exit cause/status.
        process, offset = child
        code = process.poll()
        end = os.lseek(self.ssh_log, 0, os.SEEK_END)
        diagnostic = os.pread(self.ssh_log, min(16 * 1024, end - offset), max(offset, end - 16 * 1024)).decode(errors='replace')
        return SSHExited(code, diagnostic)


def private_file(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        os.close(fd)
        raise Blocked('state_file_ownership_or_permissions')
    return fd


def lock_owner(path):
    fd = private_file(path)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise Blocked('another_supervisor_owns_lock')
    return fd  # Never unlink: all supervisors must contend on the same inode.


def state_writer(directory, log, config_sha256):
    def emit(value):
        record = {**value, 'supervisorPid': os.getpid(), 'at': time.time(), 'configSha256': config_sha256}
        payload = (json.dumps(record, sort_keys=True) + '\n').encode()
        # The lock, not exclusive creation, is what keeps two supervisors apart: a tmp
        # left by a crashed run with a reused pid must not break every later state write.
        temporary = directory / f'state-{os.getpid()}.tmp'
        with temporary.open('wb') as target:
            target.write(payload)
        os.replace(temporary, directory / 'state.json')
        os.write(log, payload)
    return emit


def report_blocked(supervisor, reason):
    try:
        supervisor.report('blocked_connection_untouched', reason=reason)
    except Exception:
        # A state file that cannot be written must not hide why the supervisor stopped.
        print(json.dumps({'status': 'blocked_connection_untouched', 'reason': reason}), file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adopt-pid', type=int, required=True)
    parser.add_argument('--adopt-start', required=True)
    parser.add_argument('--config-sha256', required=True)
    options = parser.parse_args()
    if sys.platform != 'darwin' or options.adopt_pid <= 1 or not re.fullmatch(r'[a-f0-9]{64}', options.config_sha256):
        parser.error('Use macOS, a verified positive SSH PID and a lowercase SHA-256 config pin.')
    os.umask(0o077)
    directory = Path.home() / '.local/share/providence-tunnel'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise Blocked('state_directory_ownership_or_permissions')
    lock = lock_owner(directory / 'supervisor.lock')
    log = private_file(directory / 'supervisor.log')
    ssh_log = private_file(directory / 'ssh.log')
    supervisor = Supervisor(MacProcesses(ssh_log), options.config_sha256,
                            state_writer(directory, log, options.config_sha256))
    try:
        supervisor.adopt(options.adopt_pid, options.adopt_start)
        while True:
            time.sleep(supervisor.step())
    except KeyboardInterrupt:
        supervisor.report('supervisor_stopped_connection_untouched')
    except Exception as error:
        report_blocked(supervisor, str(error) if isinstance(error, Blocked) else 'unexpected_supervisor_error')
        return 2
    finally:
        os.close(ssh_log)
        os.close(log)
        os.close(lock)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        reason = str(error) if isinstance(error, Blocked) else 'unexpected_supervisor_error'
        print(json.dumps({'status': 'blocked_connection_untouched', 'reason': reason}), file=sys.stderr)
        sys.exit(2)
