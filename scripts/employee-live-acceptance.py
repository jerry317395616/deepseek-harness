"""Operator-only live acceptance of two existing, disabled test employees.

Defaults to read-only preview. Run requires a pinned roster size and temporarily
enables only the two named example.test accounts. No schema or permission writes.
All model traffic stays on loopback; only aggregate checks are printed.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlsplit

BENCH = Path('/home/zyd/frappe/native-bench')
REPO = Path('/home/zyd/frappe/deepseek-harness')
PYTHON = str(BENCH / 'env/bin/python')
SITE = 'child.myyr.top'
ORIGIN = 'https://' + SITE
HELPERS = REPO / 'packages/extensions/tool-native-bench-frappe/python'
TEACHER = 'harness-test-teacher-20260907@example.test'
FINANCE = 'harness-test-finance-20260907@example.test'
TARGETS = {TEACHER: ('Harness 教师验收 20260907', 'Instructor'),
           FINANCE: ('Harness 财务验收 20260907', 'Accounts User')}
DOCTYPES = ['Student', 'Student Group', 'Sales Invoice']
GROUP = '小班'
PHASE = 'preview'


class CheckFailure(Exception):
    """Only authored identifiers may leave the process on failure."""


def require(condition, code):
    if not condition:
        raise CheckFailure(code)


def emit(kind, **values):
    print(json.dumps({'kind': kind, **values}, ensure_ascii=False), flush=True)


@contextlib.contextmanager
def quiet():
    # Frappe's logger requires a real fileno; StringIO is not a valid sink.
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        yield


def private_json(path, value):
    with path.open('x', encoding='utf-8') as handle:
        os.chmod(path, 0o600)
        json.dump(value, handle)


@contextlib.contextmanager
def operational_lock(path):
    """Serialize these fixed test accounts; refuse link-shaped or public locks."""
    import fcntl
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and info.st_nlink == 1 and not info.st_mode & 0o077, 'unsafe_operator_lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def digest(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()


def fingerprints(frappe):
    result = {}
    for dt in DOCTYPES:
        rows = frappe.get_list(dt, fields=['name', 'modified'], order_by='name', limit_page_length=10000)
        require(len(rows) < 10000, 'fingerprint_truncated')
        result[dt] = (len(rows), digest(rows))
    return result


def permissions(frappe):
    return frappe.get_list('User Permission', filters={'user': ['in', list(TARGETS)]},
        fields=['name', 'user', 'allow', 'for_value', 'apply_to_all_doctypes', 'modified'],
        order_by='name', limit_page_length=1000)


def preview(frappe):
    for user, (first_name, role) in TARGETS.items():
        doc = frappe.get_doc('User', user)
        require(doc.first_name == first_name and not doc.enabled
                and doc.user_type == 'System User' and not doc.send_welcome_email,
                'test_account_state_changed')
        require(set(frappe.permissions.get_roles(user, with_standard=False)) == {role},
                'test_account_roles_changed')
    group = frappe.get_doc('Student Group', GROUP)
    members = sorted({row.student for row in group.students if row.student})
    require(not group.disabled and 0 < len(members) < 100, 'roster_not_bounded')
    rows = permissions(frappe)
    expected = {(TEACHER, 'Student Group', GROUP, 1)} | {
        (TEACHER, 'Student', name, 1) for name in members}
    actual = {(r.user, r.allow, r.for_value, r.apply_to_all_doctypes) for r in rows}
    require(len(rows) == len(expected) and actual == expected, 'permissions_roster_drift')
    outside = frappe.get_list('Student', filters={'name': ['not in', members]},
                              pluck='name', limit_page_length=1)
    require(outside, 'outside_class_control_missing')
    before = fingerprints(frappe)
    emit('preview', site=SITE, target_users=list(TARGETS), user_count=2,
         changes=['User.enabled: 0 → 1 → 0', 'temporary test password via Frappe password service',
                  'test login sessions cleared after run'], teacher_student_count=len(members),
         user_permission_count=len(rows), business_counts={k: v[0] for k, v in before.items()},
         doctype_changes=0, permission_changes=0, production_entry_changes=0)
    return members, outside[0], before, digest(rows)


def enable(frappe, passwords):
    from frappe.utils.password import update_password
    for user in TARGETS:
        doc = frappe.get_doc('User', user)
        doc.enabled = 1
        doc.save()
        passwords[user] = secrets.token_urlsafe(48)
        # The framework's password service avoids a password-change email to test addresses.
        update_password(user, passwords[user], logout_all_sessions=True)
    frappe.db.commit()


def disable(frappe, user):
    from frappe.sessions import clear_sessions
    frappe.db.rollback()
    frappe.set_user('Administrator')
    doc = frappe.get_doc('User', user)
    doc.enabled = 0
    doc.save()
    clear_sessions(user=user, force=True)
    frappe.db.commit()


async def bounded_process(*args, **kwargs):
    proc = await asyncio.create_subprocess_exec(*args, **kwargs)
    try:
        async with asyncio.timeout(30):
            out, _ = await proc.communicate()
        require(proc.returncode == 0, 'helper_failed')
        return out
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


class LocalProvider:
    """Scripted OpenAI SSE provider; actual tool results never leave this server."""

    def __init__(self, steps):
        self.steps = steps
        self.index = 0
        self.results = []
        self.done = asyncio.Event()
        self.schemas = []

    async def handle(self, request):
        from aiohttp import web
        body = await request.json()
        self.schemas.append(sorted(t['function']['name'] for t in body.get('tools', [])))
        self.results = [m['content'] for m in body['messages'] if m.get('role') == 'tool']
        require(len(self.results) == self.index, 'provider_tool_sequence')
        if self.index < len(self.steps):
            name, args = self.steps[self.index]
            delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'live-' + str(self.index),
                'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}
            reason = 'tool_calls'
        else:
            delta = {'role': 'assistant', 'content': 'Local employee acceptance completed.'}
            reason = 'stop'
            self.done.set()
        self.index += 1
        chunks = [{'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                  {'choices': [{'index': 0, 'delta': {}, 'finish_reason': reason}],
                   'usage': {'prompt_tokens': 3, 'completion_tokens': 2}}]
        payload = ''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks) + 'data: [DONE]\n\n'
        return web.Response(text=payload, content_type='text/event-stream')


async def serve(app, stack):
    from aiohttp import web
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    stack.push_async_callback(runner.cleanup)
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = runner.addresses[0][1]
    return 'http://127.0.0.1:' + str(port), port


async def start_host(root, label, user, model_url, stack):
    work = root / label
    work.mkdir(mode=0o700)
    home = work / 'home'
    home.mkdir(mode=0o700)
    module = home / 'profiles/web/node_modules/@deepseek-ai'
    module.mkdir(parents=True)
    package = REPO / 'packages/extensions/tool-native-bench-frappe'
    private_json(home / 'profiles/web/package.json', {
        'name': 'employee-live-profile', 'private': True,
        'dsh': {'profile': {'bundles': ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
                            'patchReload': 'startup'}},
        'dependencies': {'@deepseek-ai/dsh-tool-native-bench-frappe': 'link:' + str(package)}})
    (module / 'dsh-tool-native-bench-frappe').symlink_to(package)
    patch = work / 'model.patch.yml'
    private_json(patch, [
        {'id': 'llm-deepseek', 'config': {'baseURL': model_url, 'apiKeyEnv': 'LOCAL_TEST_MODEL_KEY'}},
        {'id': 'session-persistence-jsonl', 'config': {'root': str(home / 'sessions'), 'compression': 'none'}}])
    assertion = home / 'identity.assertion'
    refresh = home / 'refresh.json'
    private_json(refresh, {'version': 1, 'bench_root': str(BENCH), 'site': SITE,
                           'user': user, 'assertion_file': str(assertion), 'ttl_seconds': 900})
    clean = {'PATH': '/home/zyd/.local/bin:/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    await bounded_process(PYTHON, '-B', str(HELPERS / 'native_actor_refresh.py'), '--config', str(refresh),
                          env=clean, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    launch = json.loads(await bounded_process('node', str(REPO / 'scripts/employee-live-launch.mjs'),
                          str(patch), env=clean, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL))
    env = {**clean, **launch['env'], 'DSH_HOME': str(home), 'DSH_AGENTS_HOME': str(work / 'agents'),
        'DSH_TELEMETRY_DISABLED': '1', 'LOCAL_TEST_MODEL_KEY': 'synthetic-local-only',
        'DSH_EMPLOYEE_PRESET_ROOT': str(REPO / 'apps/cli/config/examples/employee-readonly/presets'),
        'DSH_EMPLOYEE_BENCH_ROOT': str(BENCH), 'DSH_EMPLOYEE_SITE': SITE, 'DSH_EMPLOYEE_USER': user,
        'DSH_EMPLOYEE_ASSERTION_FILE': str(assertion), 'DSH_EMPLOYEE_DOCTYPES': json.dumps(DOCTYPES),
        'NODE_NO_WARNINGS': '1'}
    proc = await asyncio.create_subprocess_exec(launch['command'], *launch['args'], cwd=work, env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)

    async def stop():
        if proc.returncode is None:
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            async with asyncio.timeout(15):
                await proc.wait()
        except TimeoutError:
            os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()
            raise CheckFailure('host_forced_termination') from None

    stack.push_async_callback(stop)
    async with asyncio.timeout(45):
        while True:
            line = await proc.stdout.readline()
            require(line, 'host_exited_before_ready')
            match = re.search(rb'dsh web: (http://[^\s]+)', line)
            if match:
                target = urlsplit(match[1].decode())
                break
    # Drain privately so subprocess logging cannot stall a real tool turn.
    async def drain():
        while await proc.stdout.read(65536):
            pass
    task = asyncio.create_task(drain())
    async def join_drain():
        await stop()
        await task
    stack.push_async_callback(join_drain)
    launch_file = home / 'launch.credential'
    with launch_file.open('x', encoding='ascii') as handle:
        os.chmod(launch_file, 0o600)
        handle.write(parse_qs(target.query)['token'][0])
    return {'user': user, 'upstream': target.scheme + '://' + target.netloc,
            'home': str(home), 'launch_file': str(launch_file)}, str(refresh)


async def live(frappe, passwords, baseline, root):
    global PHASE
    from aiohttp import ClientSession, ClientTimeout, CookieJar, DummyCookieJar, WSMsgType, web
    from employee_gateway import Configuration, EmployeeGateway
    from employee_proxy import EmployeeProxy, NativeAccountChecks
    members, outside, before, _ = baseline
    listing = 'native_bench_frappe_list_documents'
    get = 'native_bench_frappe_get_document'
    query = lambda dt: (listing, {'doctype': dt, 'fields': ['name'], 'limit': 100, 'order_by': 'name'})
    providers = [LocalProvider([query('Student Group'), query('Student'),
        (get, {'doctype': 'Student', 'name': outside, 'fields': ['name']}), query('Sales Invoice')]),
        LocalProvider([query('Sales Invoice'), query('Student'), query('Student Group')])]
    async with contextlib.AsyncExitStack() as stack:
        bindings, checks = [], {}
        for label, user, provider in zip(('teacher', 'finance'), TARGETS, providers):
            PHASE = 'launch_' + label
            app = web.Application()
            app.router.add_post('/{path:.*}', provider.handle)
            model, _ = await serve(app, stack)
            binding, check = await start_host(root, label, user, model, stack)
            bindings.append(binding)
            checks[user] = check
            emit('stage', passed=PHASE)
        PHASE = 'gateway_configuration'
        # Own the listening socket before writing its port; never reserve-and-release.
        import socket
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        sock.listen(128)
        sock.setblocking(False)
        stack.callback(sock.close)
        port = sock.getsockname()[1]
        origin = 'http://127.0.0.1:' + str(port)
        public = origin.replace('http:', 'https:')
        config = root / 'gateway.json'
        private_json(config, {'version': 1, 'issuer': SITE, 'public_origin': public,
            'secret_file': '/home/zyd/deepseek-harness-config/harness_sso_shared_secret',
            'port': port, 'session_seconds': 600, 'max_sessions': 8, 'bindings': bindings})
        gateway = EmployeeGateway(Configuration.load(str(config)))
        proxy = EmployeeProxy(gateway, NativeAccountChecks(PYTHON, checks),
                              recheck_seconds=2, check_seconds=15)
        runner = web.AppRunner(proxy.app, access_log=None)
        await runner.setup()
        stack.push_async_callback(runner.cleanup)
        await web.SockSite(runner, sock).start()
        client = await stack.enter_async_context(ClientSession(cookie_jar=DummyCookieJar(),
                                     timeout=ClientTimeout(total=40), trust_env=False))
        cookies, frappe_sessions = [], []
        for label, user in zip(('teacher', 'finance'), TARGETS):
            PHASE = 'real_login_sso_' + label
            session = await stack.enter_async_context(ClientSession(cookie_jar=CookieJar(),
                                          timeout=ClientTimeout(total=30), trust_env=False))
            frappe_sessions.append(session)
            async with session.post(ORIGIN + '/api/method/login',
                    data={'usr': user, 'pwd': passwords[user]}, allow_redirects=False) as reply:
                require(reply.status == 200, 'https_login_rejected')
                await reply.read()
            async with session.get(ORIGIN + '/api/method/frappe.auth.get_logged_user') as reply:
                require((await reply.json()).get('message') == user, 'https_actor_mismatch')
            # Tickets use second precision and must be issued after gateway startup.
            await asyncio.sleep(max(0, int(gateway.started) + 1 - time.time()))
            async with session.get(ORIGIN + '/api/method/ione_core.harness_auth.launch',
                                   allow_redirects=False) as reply:
                target = urlsplit(reply.headers.get('Location', ''))
                require(reply.status in (302, 303) and target.scheme == 'https'
                        and target.netloc == 'harness.myyr.top' and target.path == '/sso', 'handoff_invalid')
            # The actual signed ticket is unchanged; only its transport goes to the isolated proxy.
            path = '/sso?' + target.query
            async with client.get(origin + path, allow_redirects=False) as reply:
                require(reply.status == 303, 'actual_ticket_verification_failed')
                cookie = reply.headers['Set-Cookie'].split(';', 1)[0]
                landing = reply.headers['Location']
            async with client.get(origin + path, allow_redirects=False) as reply:
                require(reply.status == 401, 'actual_ticket_replay_allowed')
            async with client.get(origin + landing, headers={'Cookie': cookie}, allow_redirects=False) as reply:
                require(reply.status in (302, 303), 'native_launch_exchange_failed')
                cookie += '; ' + reply.headers['Set-Cookie'].split(';', 1)[0]
            async with client.get(origin, headers={'Cookie': cookie}) as reply:
                require(reply.status == 200 and '__DSH_BOOT__' in await reply.text(), 'web_page_unavailable')
            cookies.append(cookie)
            emit('stage', passed=PHASE, ticket_replay_denied=True)

        async def raw(index, method, args):
            response = await client.post(origin + '/api/' + method,
                headers={'Cookie': cookies[index], 'Origin': public},
                json={'type': 'client-request', 'rpcId': 'live', 'method': method, 'payload': {'args': args}})
            async with response:
                return response.status, await response.read()

        async def rpc(index, method, args):
            status, body = await raw(index, method, args)
            require(status == 200, 'rpc_http_rejected')
            return json.loads(body)['result']

        PHASE = 'real_readonly_tool_turns'
        sessions = []
        for index in range(2):
            created = await rpc(index, 'session/create', {'request': {}})
            require(created.get('ok') and created['value']['agentPreset'] == 'employee-readonly', 'preset_not_pinned')
            sid = created['value']['sessionId']
            sessions.append(sid)
            reply = await rpc(index, 'session/prompt', {'request': {'sessionId': sid,
                'requestId': 'live-acceptance', 'mode': 'queue',
                'content': [{'type': 'text', 'text': 'Run the local read-only employee acceptance checks.'}]}})
            require(reply.get('ok'), 'prompt_rejected')
        async with asyncio.timeout(120):
            await asyncio.gather(*(p.done.wait() for p in providers))
        schemas = sorted(['native_bench_frappe_describe_doctype', listing, get])
        require(all(s == schemas for p in providers for s in p.schemas), 'non_readonly_tools_exposed')
        teacher, finance = (p.results for p in providers)
        require(json.loads(teacher[0])['rows'] == [{'name': GROUP}], 'teacher_groups_incorrect')
        require(sorted(r['name'] for r in json.loads(teacher[1])['rows']) == members, 'teacher_students_incorrect')
        require(json.loads(teacher[2])['document'] is None, 'cross_class_record_exposed')
        with quiet():
            require(not frappe.has_permission('Sales Invoice', 'read', user=TEACHER)
                    and not frappe.has_permission('Student', 'read', user=FINANCE)
                    and not frappe.has_permission('Student Group', 'read', user=FINANCE),
                    'negative_control_permissions_changed')
        # NativeFrappeClient maps a nonzero helper exit to this fixed failure.
        require('native-bench-frappe: Frappe request failed' in teacher[3], 'teacher_finance_read_not_denied')
        require(len(json.loads(finance[0])['rows']) == before['Sales Invoice'][0] < 100, 'finance_invoices_incorrect')
        require(all('native-bench-frappe: Frappe request failed' in item for item in finance[1:]),
                'finance_student_read_not_denied')
        for index in range(2):
            other = await rpc(index, 'session/page', {'request': {
                'address': {'kind': 'session', 'sessionId': sessions[1 - index]}, 'throughSeq': 100}})
            require(not other['ok'] and other['error']['code'] == 'session/not-found', 'cross_host_session_exposed')
            denied = await rpc(index, 'settings/update', {})
            require(not denied['ok'] and denied['error']['code'] == 'gateway/forbidden', 'settings_write_allowed')
        emit('stage', passed=PHASE, teacher_groups=1, teacher_students=len(members),
             finance_invoices=before['Sales Invoice'][0], cross_role_reads_denied=True,
             cross_host_sessions_denied=True, model_route='loopback scripted provider')
        PHASE = 'active_connection_revocation'
        sockets = []
        for cookie in cookies:
            ws = await client.ws_connect(origin + '/api/remote.mux',
                                         headers={'Cookie': cookie}, origin=public)
            sockets.append(ws)
            stack.push_async_callback(ws.close)

        async def closed(ws):
            async with asyncio.timeout(25):
                while True:
                    message = await ws.receive()
                    if message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED}:
                        return
                    require(message.type != WSMsgType.ERROR, 'websocket_transport_error')

        async with client.post(origin + '/logout', headers={'Cookie': cookies[0], 'Origin': public}) as reply:
            require(reply.status == 204, 'logout_failed')
        await closed(sockets[0])
        require((await raw(0, 'session/list', {'_request': {}}))[0] == 401, 'logged_out_http_allowed')
        require((await rpc(1, 'session/list', {'_request': {}}))['ok'], 'other_employee_disrupted')
        with quiet():
            disable(frappe, FINANCE)
        await closed(sockets[1])
        require((await raw(1, 'session/list', {'_request': {}}))[0] == 401, 'disabled_http_allowed')
        emit('stage', passed=PHASE, logout_closes_existing_ws=True, disable_closes_existing_ws=True)


async def run(frappe, baseline):
    global PHASE
    passwords, cleanup_failures = {}, []
    failure = None
    try:
        PHASE = 'enable_exact_test_accounts'
        with quiet():
            enable(frappe, passwords)
        with tempfile.TemporaryDirectory(prefix='dsh-live-employees-') as root:
            await live(frappe, passwords, baseline, Path(root))
    except (Exception, KeyboardInterrupt) as exc:
        failure = {'phase': PHASE, 'error_type': type(exc).__name__,
                   'check': str(exc) if isinstance(exc, CheckFailure) else None}
    finally:
        for user in TARGETS:
            try:
                with quiet():
                    disable(frappe, user)
            except Exception as exc:
                cleanup_failures.append({'user': user, 'error_type': type(exc).__name__})
        passwords.clear()
    with quiet():
        frappe.db.rollback()
        enabled = [bool(frappe.get_doc('User', user).enabled) for user in TARGETS]
        sessions = frappe.db.count('Sessions', {'user': ['in', list(TARGETS)]})
        unchanged = fingerprints(frappe) == baseline[2]
        permissions_unchanged = digest(permissions(frappe)) == baseline[3]
    emit('result', failure=failure, cleanup_failures=cleanup_failures,
         test_accounts_disabled=not any(enabled), remaining_test_sessions=sessions,
         business_records_unchanged=unchanged, user_permissions_unchanged=permissions_unchanged,
         production_entry_changed=False, doctype_changed=False)
    require(not failure and not cleanup_failures and not any(enabled) and not sessions
            and unchanged and permissions_unchanged, 'live_acceptance_incomplete')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--expected-students', type=int)
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    os.umask(0o077)
    os.chdir(BENCH)
    sys.path.insert(0, str(HELPERS))
    import frappe
    with quiet():
        frappe.init(site=SITE, sites_path=str(BENCH / 'sites'))
        frappe.connect()
        frappe.set_user('Administrator')
    try:
        baseline = preview(frappe)
        if args.run:
            require(args.expected_students == len(baseline[0]), 'preview_count_required')
            asyncio.run(run(frappe, baseline))
        return 0
    except Exception as exc:
        emit('failed', phase=PHASE, error_type=type(exc).__name__,
             check=str(exc) if isinstance(exc, CheckFailure) else None)
        return 1
    finally:
        with quiet():
            frappe.db.rollback()
            frappe.destroy()


def entry():
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        with operational_lock(REPO / '.git/employee-live-acceptance.lock'):
            return main()
    except (Exception, KeyboardInterrupt) as exc:
        emit('failed', phase='operator_startup', error_type=type(exc).__name__,
             check=str(exc) if isinstance(exc, CheckFailure) else None)
        return 1


if __name__ == '__main__':
    sys.exit(entry())
