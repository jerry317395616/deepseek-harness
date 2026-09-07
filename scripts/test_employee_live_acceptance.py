"""Credential-free checks of the live operator's admission and serialization."""
import contextlib
import copy
import io
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace as Obj
import unittest

spec = importlib.util.spec_from_file_location('live', Path(__file__).with_name('employee-live-acceptance.py'))
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


class Fixture:
    def __init__(self):
        self.users = {user: Obj(first_name=name, enabled=0, user_type='System User',
                               send_welcome_email=0) for user, (name, _) in live.TARGETS.items()}
        self.roles = {user: [role] for user, (_, role) in live.TARGETS.items()}
        self.permissions = Obj(get_roles=lambda user, **_: self.roles[user])
        self.rows = [Obj(name='p1', user=live.TEACHER, allow='Student Group',
                         for_value=live.GROUP, apply_to_all_doctypes=1, modified='fixed'),
                     Obj(name='p2', user=live.TEACHER, allow='Student',
                         for_value='member', apply_to_all_doctypes=1, modified='fixed')]

    def get_doc(self, dt, name):
        if dt == 'User':
            return self.users[name]
        return Obj(disabled=0, students=[Obj(student='member')])

    def get_list(self, dt, **kwargs):
        if dt == 'User Permission':
            return self.rows
        if 'pluck' in kwargs:
            return ['outside']
        return [{'name': 'record', 'modified': 'fixed'}]


class AdmissionTests(unittest.TestCase):
    def preview(self, fixture):
        with contextlib.redirect_stdout(io.StringIO()):
            return live.preview(fixture)

    def test_existing_disabled_accounts_and_exact_roster_are_admitted(self):
        self.assertEqual(self.preview(Fixture())[0], ['member'])

    def test_enabled_or_renamed_or_non_system_account_is_rejected(self):
        for field, value in [('enabled', 1), ('first_name', 'other'), ('user_type', 'Website User'),
                             ('send_welcome_email', 1)]:
            with self.subTest(field=field):
                fixture = Fixture()
                setattr(fixture.users[live.TEACHER], field, value)
                with self.assertRaisesRegex(live.CheckFailure, 'test_account_state_changed'):
                    self.preview(fixture)

    def test_additional_role_is_rejected(self):
        fixture = Fixture()
        fixture.roles[live.FINANCE].append('System Manager')
        with self.assertRaisesRegex(live.CheckFailure, 'test_account_roles_changed'):
            self.preview(fixture)

    def test_permission_drift_or_duplicate_is_rejected(self):
        for mode in ('missing', 'extra', 'value', 'finance'):
            with self.subTest(mode=mode):
                fixture = Fixture()
                if mode == 'missing':
                    fixture.rows.pop()
                elif mode == 'extra':
                    fixture.rows.append(copy.copy(fixture.rows[-1]))
                elif mode == 'value':
                    fixture.rows[-1].for_value = 'other'
                else:
                    fixture.rows[-1].user = live.FINANCE
                with self.assertRaisesRegex(live.CheckFailure, 'permissions_roster_drift'):
                    self.preview(fixture)


@unittest.skipUnless(os.name == 'posix', 'Native Bench operator requires POSIX')
class SerializationTests(unittest.TestCase):
    def test_competing_run_is_refused_and_lock_releases(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'operator.lock'
            with live.operational_lock(path):
                with self.assertRaises(BlockingIOError):
                    with live.operational_lock(path):
                        self.fail('concurrent operator admitted')
            with live.operational_lock(path):
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_symlink_or_public_lock_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'target'
            target.touch(mode=0o600)
            link = Path(root) / 'link'
            link.symlink_to(target)
            with self.assertRaises(OSError):
                with live.operational_lock(link):
                    self.fail('link lock admitted')
            target.chmod(0o644)
            with self.assertRaisesRegex(live.CheckFailure, 'unsafe_operator_lock'):
                with live.operational_lock(target):
                    self.fail('public lock admitted')


if __name__ == '__main__':
    unittest.main()
