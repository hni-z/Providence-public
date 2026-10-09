#!/usr/bin/env python3
"""Offline archive/installer tests. Shell platform branches use fixtures, not devices.

Run: python3 coordinator/install/test_installers.py
Windows script invariants are checked statically; this is not Windows execution.
"""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import signal
import tarfile
import tempfile
import time
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
INSTALLER = ROOT / 'install/install.sh'
SPEC = importlib.util.spec_from_file_location('build_companion', REPO / 'scripts/build-companion.py')
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)
NODE = shutil.which('node')


def write(path, content, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    if executable:
        path.chmod(0o700)


def fixture_source(path):
    for name in ('package.json', 'package-lock.json', 'tsconfig.json'):
        write(path / 'coordinator' / name, '{}')
    write(path / 'coordinator/scripts/connect.mjs', "import {writeFileSync} from 'node:fs';writeFileSync(process.env.TEST_RESULT,JSON.stringify({args:process.argv.slice(2),codex:process.env.CODEX_BIN,cwd:process.cwd()}));")
    write(path / 'coordinator/scripts/connect-helpers.mjs', 'export const fixture = true;')
    for name in ('keep-awake.mjs', 'keep-awake.d.mts', 'keep-awake.ps1'):
        write(path / 'coordinator/install' / name, '// synthetic fixture')
    write(path / 'coordinator/src/device.ts', 'export const device = true;')
    write(path / 'iphone-mirroring/host-route.mjs', 'export const fixture = true;')
    write(path / 'coordinator/install/prepare-codex.mjs', "import {appendFileSync} from 'node:fs';appendFileSync(process.env.TEST_CODEX_LOG,'prepared\\n');console.log('/fixture/codex');")
    write(path / 'coordinator/install/background.mjs', 'export const fixture = true;')
    write(path / 'coordinator/install/background-runner.mjs', 'export const fixture = true;')
    write(path / 'coordinator/install/uninstall.mjs', "import {appendFileSync} from 'node:fs';if(process.env.TEST_UNINSTALL_FAILURE){console.error('fixture registration failed');process.exit(17);}appendFileSync(process.env.TEST_UNINSTALL_LOG,'registered\\n');console.log('fixture uninstall success path');")
    write(path / 'coordinator/install/uninstall-windows.ps1', '# fixture')
    for name in ('package.json', 'package-lock.json'):
        write(path / 'coordinator/install/codex' / name, '{}')


def run_tty(installer, args, env):
    child, fd = pty.fork()
    if child == 0:
        os.execve('/bin/sh', ['/bin/sh', str(installer), *args], env)
    output = bytearray()
    deadline = time.monotonic() + 20
    status = None
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                    if chunk:
                        output.extend(chunk)
                except OSError:
                    pass
            waited, candidate = os.waitpid(child, os.WNOHANG)
            if waited:
                status = candidate
                break
        if status is None:
            os.kill(child, signal.SIGKILL)
            _, status = os.waitpid(child, 0)
            raise AssertionError('Installer timed out: ' + output.decode(errors='replace'))
    finally:
        os.close(fd)
    return os.waitstatus_to_exitcode(status), output.decode(errors='replace')


class PackagingTests(unittest.TestCase):
    def test_reproducible_archives_and_manifest_only_include_allowlisted_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            fixture_source(source)
            write(source / '.env', 'synthetic-secret')
            write(source / 'coordinator/src/device.test.ts', 'excluded fixture')
            write(source / 'coordinator/.providence/device.json', 'excluded local state')
            first = root / 'a/providence-companion.zip'
            second = root / 'b/providence-companion.zip'
            manifest = BUILDER.build(first, source)
            self.assertEqual(manifest, BUILDER.build(second, source))
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(first.with_suffix('.tar.gz').read_bytes(), second.with_suffix('.tar.gz').read_bytes())
            with zipfile.ZipFile(first) as archive, tarfile.open(first.with_suffix('.tar.gz')) as tar:
                self.assertEqual(sorted(archive.namelist()), sorted(tar.getnames()))
                self.assertTrue(all('.env' not in name and '.test.' not in name and '.providence' not in name for name in archive.namelist()))
                self.assertIn('providence-companion/coordinator/scripts/connect-helpers.mjs', archive.namelist())
                self.assertIn('providence-companion/coordinator/install/codex/package-lock.json', archive.namelist())
            self.assertEqual(manifest['archiveZipSha256'], hashlib.sha256(first.read_bytes()).hexdigest())
            self.assertIn('/' + manifest['version'] + '/', manifest['archiveTarGzUrl'])
            with self.assertRaises(FileExistsError):
                BUILDER.build(first, source)

    def test_source_symlinks_fail_before_an_archive_is_created(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture_source(root)
            target = root / 'coordinator/src/device.ts'
            target.unlink()
            target.symlink_to(root / 'coordinator/package.json')
            output = root / 'result/providence-companion.zip'
            with self.assertRaises(ValueError):
                BUILDER.build(output, root)
            self.assertFalse(output.exists())

    def test_official_node_and_codex_pins_match_both_installers(self):
        shell = INSTALLER.read_text()
        windows = (ROOT / 'install/install.ps1').read_text()
        for platform, digest in BUILDER.NODE_SHA256.items():
            self.assertIn(digest, windows if platform.startswith('win') else shell)
        for installer in (shell, windows):
            self.assertIn(BUILDER.NODE_VERSION, installer)
            self.assertIn(BUILDER.CODEX_VERSION, installer)
            self.assertIn('--ignore-scripts', installer)
            self.assertIn('--update-notifier=false', installer)
            self.assertIn('--cache', installer)
            self.assertIn('coordinator/.npm-cache', installer)
            self.assertIn('--configure-key', installer)
            self.assertNotIn('ExecutionPolicy Bypass', installer)
        self.assertNotIn('Set-Acl -LiteralPath', windows)
        self.assertIn('AccessControlSections]::Access)', windows)
        self.assertIn('[IO.Directory]::SetAccessControl', windows)
        self.assertIn('[IO.FileSystemAclExtensions]::SetAccessControl', windows)
        self.assertIn("SecurityIdentifier]::new('S-1-5-18')", windows)
        self.assertIn('$verified.AreAccessRulesProtected', windows)
        lock = json.loads((ROOT / 'install/codex/package-lock.json').read_text())
        self.assertEqual(lock['packages']['node_modules/@openai/codex']['version'], BUILDER.CODEX_VERSION)
        for name, package in lock['packages'].items():
            if name:
                self.assertTrue(package['integrity'].startswith('sha512-'))
                self.assertTrue(package['resolved'].startswith('https://registry.npmjs.org/@openai/codex/'))
        self.assertIn('-MaximumRedirection 0', windows)
        self.assertIn('SetAccessRuleProtection($true, $false)', windows)
        self.assertLess(windows.index('Assert-Hash $companionArchive'), windows.index('Expand-VerifiedZip $companionArchive'))


@unittest.skipUnless(NODE, 'Node is needed for offline bootstrap fixtures')
class ShellInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.home = self.base / 'home with spaces'
        self.home.mkdir()
        source = self.base / 'source'
        fixture_source(source)
        self.zip = self.base / 'downloads/providence-companion.zip'
        self.manifest = BUILDER.build(self.zip, source)
        self.manifest_file = self.zip.parent / 'companion-manifest.json'
        self.config = self.home / '.providence/companion/device.json'
        write(self.config, '{"existing":"fixture-do-not-replace"}')
        self.mock_bin = self.base / 'bin'
        # Mock the installer's home-directory reference, without changing HOME
        # or touching any files in the real user's profile.
        self.test_installer = self.base / 'install-fixture.sh'
        self.test_installer.write_text(INSTALLER.read_text().replace('$HOME', '$TEST_PROFILE_DIRECTORY').replace('${HOME-', '${TEST_PROFILE_DIRECTORY-'))
        write(self.mock_bin / 'uname', '#!/bin/sh\ncase "$1" in -s) echo "$TEST_OS";; -m) echo "$TEST_ARCH";; esac\n', True)
        write(self.mock_bin / 'curl', '''#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in --output) output=$2; shift 2;; https://*) url=$1; shift;; *) shift;; esac
done
printf '%s\\n' "$url" >> "$TEST_DOWNLOADS"
[ "${TEST_DOWNLOAD_FAILURE-}" != 1 ] || exit 22
case "$url" in
 https://providence.hani.so/downloads/companion-manifest.json) cp "$TEST_MANIFEST" "$output";;
 https://providence.hani.so/downloads/*/providence-companion.tar.gz) cp "$TEST_ARCHIVE" "$output";;
 *) exit 23;;
esac
printf '%s' "${TEST_HTTP_STATUS-200}"
''', True)
        # Explicit glibc fixture avoids host ldd changing simulated Linux coverage.
        write(self.mock_bin / 'ldd', '#!/bin/sh\necho "ldd glibc fixture"\n', True)
        self.result = self.base / 'result.json'
        self.env = {
            **os.environ, 'TEST_PROFILE_DIRECTORY': str(self.home), 'PATH': str(self.mock_bin) + ':' + os.environ['PATH'],
            'TEST_OS': 'Darwin', 'TEST_ARCH': 'arm64', 'TEST_MANIFEST': str(self.manifest_file),
            'TEST_ARCHIVE': str(self.zip.with_suffix('.tar.gz')), 'TEST_RESULT': str(self.result),
            'TEST_DOWNLOADS': str(self.base / 'downloads.log'), 'TEST_NPM_LOG': str(self.base / 'npm.log'),
            'TEST_CODEX_LOG': str(self.base / 'codex.log'),
            'TEST_UNINSTALL_LOG': str(self.base / 'uninstall.log'),
        }
        self.env.pop('CODEX_BIN', None)
        self.cache_runtime('darwin', 'arm64')

    def cache_runtime(self, platform, arch):
        runtime = self.home / f'.providence/installation/runtimes/node-v{BUILDER.NODE_VERSION}-{platform}-{arch}'
        write(runtime / '.providence-archive-sha256', BUILDER.NODE_SHA256[f'{platform}_{arch}'])
        write(runtime / 'bin/node', '#!/bin/sh\nif [ "${1-}" = -p ]; then echo 22.23.3; else exec ' + shlex.quote(NODE) + ' "$@"; fi\n', True)
        write(runtime / 'lib/node_modules/npm/bin/npm-cli.js', "const fs=require('node:fs');if(!process.argv.includes('ci')||!process.argv.includes('--ignore-scripts')||!process.argv.includes('--update-notifier=false'))process.exit(9);fs.appendFileSync(process.env.TEST_NPM_LOG,'ci\\n');")

    def save_manifest(self):
        self.manifest_file.write_text(json.dumps(self.manifest, indent=2) + '\n')

    def run_install(self, *args):
        return run_tty(self.test_installer, args, self.env)

    def assert_nothing_activated(self):
        self.assertFalse(self.result.exists())
        self.assertFalse((self.base / 'npm.log').exists())
        self.assertEqual(self.config.read_text(), '{"existing":"fixture-do-not-replace"}')
        releases = self.home / '.providence/installation/releases'
        self.assertEqual(list(releases.iterdir()) if releases.exists() else [], [])

    def test_install_resume_preserves_configuration_and_key_mode_does_not_prepare_codex(self):
        status, output = self.run_install()
        self.assertEqual(status, 0, output)
        self.assertNotIn('fixture uninstall success path', output)
        result = json.loads(self.result.read_text())
        self.assertEqual(result['args'], ['--full-access'])
        self.assertEqual(result['codex'], '/fixture/codex')
        self.assertIn('/releases/' + self.manifest['version'] + '/coordinator', result['cwd'])
        self.assertEqual((self.base / 'npm.log').read_text(), 'ci\n')
        self.assertEqual((self.base / 'codex.log').read_text(), 'prepared\n')
        self.assertEqual((self.base / 'uninstall.log').read_text(), 'registered\nregistered\n')
        status, output = self.run_install('--configure-key')
        self.assertEqual(status, 0, output)
        self.assertEqual(json.loads(self.result.read_text())['args'], ['--configure-key'])
        self.assertEqual((self.base / 'npm.log').read_text(), 'ci\n')
        self.assertEqual((self.base / 'codex.log').read_text(), 'prepared\n')
        self.assertEqual(self.config.read_text(), '{"existing":"fixture-do-not-replace"}')

    def test_registration_error_and_exit_status_are_not_silenced(self):
        self.env['TEST_UNINSTALL_FAILURE'] = '1'
        status, output = self.run_install()
        self.assertEqual(status, 17, output)
        self.assertIn('fixture registration failed', output)
        self.assertFalse(self.result.exists())

    def test_concurrent_uninstall_is_rechecked_after_install_lock_acquisition(self):
        real_mkdir = shutil.which('mkdir')
        write(self.mock_bin / 'mkdir', '''#!/bin/sh
''' + shlex.quote(real_mkdir) + ''' "$@" || exit $?
case "$*" in */.install-lock) printf '%s' 'owned-uninstall-fixture' > "$TEST_PROFILE_DIRECTORY/.providence/installation/.uninstall-lock";; esac
''', True)
        status, output = self.run_install()
        self.assertNotEqual(status, 0)
        self.assertIn('uninstall started concurrently', output)
        self.assertFalse((self.base / 'downloads.log').exists())
        root = self.home / '.providence/installation'
        self.assertEqual((root / '.uninstall-lock').read_text(), 'owned-uninstall-fixture')
        self.assertFalse((root / '.install-lock').exists())
        self.assert_nothing_activated()

    def test_linux_x64_and_pi_arm64_platform_branches(self):
        for arch, uname in [('x64', 'x86_64'), ('arm64', 'aarch64')]:
            with self.subTest(arch=arch):
                self.cache_runtime('linux', arch)
                self.env.update(TEST_OS='Linux', TEST_ARCH=uname)
                status, output = self.run_install('--configure-key')
                self.assertEqual(status, 0, output)

    def test_advanced_workspace_folder_is_forwarded_as_one_argument(self):
        selected = str(self.home / 'My work')
        status, output = self.run_install('--workspace-folder', selected)
        self.assertEqual(status, 0, output)
        self.assertEqual(json.loads(self.result.read_text())['args'], ['--full-access', '--workspace-folder', selected])
        self.assertEqual(self.config.read_text(), '{"existing":"fixture-do-not-replace"}')

    def test_key_update_refuses_unused_folder_option_before_download(self):
        status, output = self.run_install('--configure-key', '--workspace-folder', str(self.home / 'work'))
        self.assertNotEqual(status, 0)
        self.assertIn('omit it', output)
        self.assertFalse((self.base / 'downloads.log').exists())

    def test_unsupported_32_bit_pi_fails_without_download(self):
        self.env.update(TEST_OS='Linux', TEST_ARCH='armv7l')
        status, output = self.run_install()
        self.assertNotEqual(status, 0)
        self.assertIn('64-bit OS', output)
        self.assertFalse((self.base / 'downloads.log').exists())
        self.assert_nothing_activated()

    def test_corrupt_archive_is_rejected_before_extraction_or_npm(self):
        with self.zip.with_suffix('.tar.gz').open('ab') as file:
            file.write(b'corruption')
        status, output = self.run_install()
        self.assertNotEqual(status, 0)
        self.assertIn('checksum mismatch', output)
        self.assert_nothing_activated()

    def test_manifest_cannot_redirect_source_to_another_origin_or_path(self):
        self.manifest['archiveTarGzUrl'] = 'https://example.invalid/install.tar.gz'
        self.save_manifest()
        status, output = self.run_install()
        self.assertNotEqual(status, 0)
        self.assertIn('Untrusted archive location', output)
        self.assert_nothing_activated()

    def test_node_bootstrap_rejects_a_changed_official_hash(self):
        self.manifest['node_darwin_arm64_sha256'] = 'a' * 64
        self.save_manifest()
        status, output = self.run_install()
        self.assertNotEqual(status, 0)
        self.assertIn('pinned Node', output)
        self.assert_nothing_activated()

    def test_https_failures_and_redirects_fail_closed(self):
        for field, value in [('TEST_DOWNLOAD_FAILURE', '1'), ('TEST_HTTP_STATUS', '302')]:
            with self.subTest(field=field):
                self.env[field] = value
                status, output = self.run_install()
                self.assertNotEqual(status, 0, output)
                self.assert_nothing_activated()
                del self.env[field]

    def test_unknown_existing_release_is_left_untouched(self):
        release = self.home / '.providence/installation/releases' / self.manifest['version']
        write(release / 'keep.txt', 'keep')
        status, output = self.run_install()
        self.assertNotEqual(status, 0)
        self.assertIn('left untouched', output)
        self.assertEqual((release / 'keep.txt').read_text(), 'keep')

    def test_archive_path_traversal_and_links_are_rejected(self):
        for unsafe in ('traversal', 'link'):
            with self.subTest(unsafe=unsafe):
                archive = self.zip.with_suffix('.tar.gz')
                with tarfile.open(archive, 'w:gz') as tar:
                    member = tarfile.TarInfo('providence-companion/../../outside' if unsafe == 'traversal' else 'providence-companion/coordinator/link')
                    if unsafe == 'link':
                        member.type = tarfile.SYMTYPE
                        member.linkname = '/tmp'
                    else:
                        member.size = 3
                    tar.addfile(member, io.BytesIO(b'bad') if unsafe == 'traversal' else None)
                self.manifest['archiveTarGzSha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
                self.save_manifest()
                status, output = self.run_install()
                self.assertNotEqual(status, 0, output)
                self.assert_nothing_activated()
                self.assertFalse((self.home / '.providence/installation/outside').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
