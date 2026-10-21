import json
import os
import pathlib
import pwd
import subprocess
import sys

plan = json.loads(pathlib.Path(sys.argv[1]).read_text())
account = pwd.getpwnam(plan['user'])
volume = pathlib.Path(plan['volume'])
runtime = pathlib.Path(plan['runtimeRoot'])
source = pathlib.Path(plan['sourceParent'])
if os.geteuid() != 0 or not os.path.ismount(volume):
    raise RuntimeError('Root and the mounted installation volume are required')
if runtime != volume / 'managed' or source.parent != runtime / 'source-materializations':
    raise RuntimeError('Installation paths changed')

def directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    os.chown(path, account.pw_uid, account.pw_gid)

def quota(path, project, size, inodes):
    directory(path)
    subprocess.run(['chattr', '-p', str(project), '+P', str(path)], check=True)
    subprocess.run(['setquota', '-P', str(project), '0', str(size // 1024), '0', str(inodes), str(volume)], check=True)

quota(runtime, plan['controlProjectId'], plan['controlHardLimitBytes'], plan['controlHardInodes'])
directory(runtime / 'source-materializations')
directory(source)
for slot in plan['slots']:
    quota(source / slot['namespace'], slot['projectId'], slot['hardLimitBytes'], slot['hardInodes'])
for name in ['installer', 'podman', 'ci-empty-oci-hooks']:
    directory(runtime / name)
block = subprocess.check_output(['findmnt', '-n', '-o', 'SOURCE', '--target', str(volume)], text=True).strip()
print(json.dumps({'volume':str(volume),'blockDevice':block,'runtimeRoot':str(runtime),'sourceParent':str(source),'slots':plan['slots']}))
