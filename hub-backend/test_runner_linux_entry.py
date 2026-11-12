"""Execute generated enrollment commands against fake host boundaries."""
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).parent / 'app/services/runner_enroll.py'
TREE = ast.parse(SOURCE.read_text(encoding='utf-8'))
FUNCTIONS = ast.Module(body=[n for n in TREE.body if isinstance(n, ast.FunctionDef)
                            and n.name in ('install_commands', '_quote_sh', '_quote_ps')],
                       type_ignores=[])
NAMESPACE = {'validate_hub_url': lambda hub: hub}
exec(compile(FUNCTIONS, str(SOURCE), 'exec'), NAMESPACE)


def sed_requires_empty_backup_suffix(executable):
    with tempfile.TemporaryDirectory(prefix='enrollment-sed-probe-') as temp:
        source=Path(temp)/'source'
        for suffix in ([], ['']):
            source.write_text('fixture-before\n')
            result=subprocess.run([executable,'-E','-i',*suffix,
                                   's@fixture-before@fixture-after@',str(source)],
                                  capture_output=True,text=True,timeout=5)
            if result.returncode==0 and source.is_file() and source.read_text()=='fixture-after\n':
                return bool(suffix)
    raise AssertionError('Host sed does not support the enrollment fixture in-place edit')


TOOL = r'''#!PYTHON
import json,os,pathlib,sys
root=pathlib.Path(os.environ['FIXTURE'])
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
with (root/'calls').open('a') as f:f.write(json.dumps([name,args])+'\n')
if name=='id':print(os.environ.get('FIXTURE_UID','0'))
elif name=='sudo':
 if os.environ.get('FAIL_SUDO'):sys.exit(1)
 os.execv(str(root/'bash'),['bash',*args[2:]])
elif name=='bash':
 if args[0]=='-c':os.execv('/bin/bash',['bash',*args])
 (root/'installed').write_text(json.dumps(args[1:]))
elif name=='curl':
 if os.environ.get('FAIL_DOWNLOAD'):sys.exit(22)
 pathlib.Path(args[-1]).write_text('# fixture installer\n')
elif name=='apt-get':
 if args[0]=='install' and not (root/'curl').exists():(root/'curl').symlink_to(root/'tool')
elif name=='sed':
 # BSD sed requires an explicit empty backup suffix for GNU-style bare -i.
 if len(args)!=4 or args[:2]!=['-E','-i']:
  sys.exit('Unsupported sed invocation in the Linux enrollment fixture')
 if os.environ['FIXTURE_SED_EMPTY_SUFFIX']=='1':args.insert(2,'')
 os.execv(os.environ['FIXTURE_SED'],['sed',*args])
'''


@unittest.skipUnless(os.name == 'posix' and Path('/bin/bash').is_file(),
                     'Enrollment shell fixture requires a native POSIX host and /bin/bash')
class EnrollmentCommandTests(unittest.TestCase):
    def run_command(self, *, uid='0', missing_curl=False, missing_ca=False, fail_download=False,
                    deny_sudo=False):
        host_tools={name:shutil.which(name) for name in ('mktemp','rm','cp','sed')}
        for name,executable in host_tools.items():
            self.assertIsNotNone(executable, 'Host utility is required: '+name)
            host_tools[name]=str(Path(executable).resolve())
        empty_suffix=sys.platform=='darwin' and sed_requires_empty_backup_suffix(host_tools['sed'])
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            tool=root/'tool'
            tool.write_text(TOOL.replace('PYTHON',sys.executable,1))
            tool.chmod(0o755)
            names=['bash','id','sudo','apt-get','sed'] + ([] if missing_curl else ['curl'])
            for name in names:(root/name).symlink_to(tool)
            for name in ('mktemp','rm','cp'):(root/name).symlink_to(host_tools[name])
            apt=root/'apt'
            (apt/'sources.list.d').mkdir(parents=True)
            (apt/'sources.list').write_text('deb http://archive.ubuntu.com/ubuntu noble main\n')
            release=root/'os-release'
            release.write_text('ID=ubuntu\n')
            # Control the target Linux CA probe without relying on host trust paths.
            ca_bundle=root/'ca-certificates.crt'
            if not missing_ca:ca_bundle.write_text('fixture CA bundle\n')
            injection=root/'must-not-exist'
            work=f"/work/quote' $(touch {injection})"
            key="fixture-key'with-quotes"
            command=NAMESPACE['install_commands']('https://fixture.invalid','fixture',key,
                                                 ['linux','tag with spaces'],work)['linux']
            command=command.replace('/etc/os-release',str(release)).replace('/etc/apt/',str(apt)+'/')
            command=command.replace('/etc/ssl/certs/ca-certificates.crt',str(ca_bundle))
            command=command.replace('/etc/pki/tls/certs/ca-bundle.crt',str(root/'ca-bundle.crt'))
            env=dict(os.environ,PATH=temp,FIXTURE=temp,FIXTURE_UID=uid,TMPDIR=temp,FIXTURE_SED=host_tools['sed'])
            env['FIXTURE_SED_EMPTY_SUFFIX']='1' if empty_suffix else '0'
            if fail_download:env['FAIL_DOWNLOAD']='1'
            if deny_sudo:env['FAIL_SUDO']='1'
            result=subprocess.run(['/bin/bash','-c',command],env=env,capture_output=True,
                                  text=True,timeout=10)
            calls=[json.loads(line) for line in (root/'calls').read_text().splitlines()]
            installed=json.loads((root/'installed').read_text()) if (root/'installed').exists() else None
            self.assertFalse(injection.exists())
            for name,args in calls:
                if name=='curl':self.assertFalse(Path(args[-1]).exists(), 'installer is removed on success or failure')
            if (missing_curl or missing_ca) and result.returncode == 0:
                self.assertIn('mirrors.tuna.tsinghua.edu.cn', (apt/'sources.list').read_text())
                scheme='http' if missing_ca else 'https'
                self.assertEqual((apt/'sources.list').read_text(),
                                 f'deb {scheme}://mirrors.tuna.tsinghua.edu.cn/ubuntu/ noble main\n')
                self.assertEqual((apt/'sources.list.soduwork-backup').read_text(),
                                 'deb http://archive.ubuntu.com/ubuntu noble main\n')
                self.assertTrue(any(name=='sed' and args[:2]==['-E','-i'] for name,args in calls))
            return result,calls,installed,work,key

    def test_root_entry_does_not_require_sudo_and_preserves_quoted_arguments(self):
        result,calls,args,work,key=self.run_command()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse(any(name=='sudo' for name,_ in calls))
        self.assertFalse(any(name=='apt-get' for name,_ in calls))
        self.assertEqual(args[:4],['--hub','https://fixture.invalid','--id','fixture'])
        self.assertEqual(args[args.index('--key')+1],key)
        self.assertEqual(args[args.index('--work-root')+1],work)
        self.assertEqual(args[args.index('--tags')+1],'linux,tag with spaces')

    def test_nonroot_entry_uses_noninteractive_sudo(self):
        result,calls,args,work,key=self.run_command(uid='1000')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse(any(name=='apt-get' for name,_ in calls))
        sudo=next(args for name,args in calls if name=='sudo')
        self.assertEqual(sudo[:2],['-n','bash'])
        self.assertEqual(args[:4],['--hub','https://fixture.invalid','--id','fixture'])
        self.assertEqual(args[args.index('--key')+1],key)
        self.assertEqual(args[args.index('--work-root')+1],work)

    def test_denied_sudo_stops_before_downloading_or_running_an_installer(self):
        result,calls,args,_,_=self.run_command(uid='1000',deny_sudo=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIsNone(args)
        self.assertFalse(any(name in ('curl','apt-get') for name,_ in calls))

    def test_minimal_ubuntu_bootstraps_curl_before_downloading(self):
        result,calls,args,_,_=self.run_command(missing_curl=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIsNotNone(args)
        self.assertIn(['apt-get',['install','-y','curl','ca-certificates']],calls)

    def test_download_failure_never_runs_an_empty_installer(self):
        result,_,args,_,_=self.run_command(fail_download=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIsNone(args)

    def test_missing_certificates_bootstrap_without_replacing_existing_curl(self):
        result,calls,args,_,_=self.run_command(missing_ca=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIsNotNone(args)
        self.assertIn(['apt-get',['install','-y','curl','ca-certificates']],calls)

    def test_host_tools_outside_usr_bin_keep_the_bootstrap_and_quoted_arguments(self):
        with tempfile.TemporaryDirectory(prefix='enrollment-host-tools-') as temp:
            host=Path(temp)/'host tools'
            host.mkdir()
            invoked=host/'invoked'
            for name in ('mktemp','rm','cp','sed'):
                executable=shutil.which(name)
                self.assertIsNotNone(executable, 'Host utility is required: '+name)
                # Record the chosen path, then run the actual utility unchanged.
                wrapper=host/name
                wrapper.write_text(f'#!{sys.executable}\nimport os,sys\n'
                    f'with open({str(invoked)!r},"a") as output:output.write({name!r}+"\\n")\n'
                    f'os.execv({executable!r},[{executable!r},*sys.argv[1:]])\n')
                wrapper.chmod(0o755)
            with patch.dict(os.environ, {'PATH':str(host)}):
                result,calls,args,work,key=self.run_command(missing_curl=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIsNotNone(args)
            self.assertIn(['apt-get',['install','-y','curl','ca-certificates']],calls)
            self.assertEqual(args[args.index('--key')+1],key)
            self.assertEqual(args[args.index('--work-root')+1],work)
            self.assertTrue(invoked.is_file(), 'Utilities must use the resolved host paths')
            self.assertEqual(set(invoked.read_text().splitlines()),{'mktemp','rm','cp','sed'})

    def test_gnu_sed_capability_preserves_the_original_in_place_arguments(self):
        def supported_edit(args, **kwargs):
            self.assertEqual(args[1:4],['-E','-i','s@fixture-before@fixture-after@'])
            Path(args[-1]).write_text('fixture-after\n')
            return subprocess.CompletedProcess(args,0,'','')
        with patch('subprocess.run',side_effect=supported_edit) as run:
            self.assertFalse(sed_requires_empty_backup_suffix('/selected/gnu-sed'))
        run.assert_called_once()

    def test_sed_capability_rejects_success_without_changing_the_probe(self):
        with patch('subprocess.run',return_value=subprocess.CompletedProcess([],0,'','')) as run:
            with self.assertRaisesRegex(AssertionError,'Host sed does not support'):
                sed_requires_empty_backup_suffix('/selected/unsupported-sed')
        self.assertEqual(run.call_count,2)


if __name__=='__main__':unittest.main()
