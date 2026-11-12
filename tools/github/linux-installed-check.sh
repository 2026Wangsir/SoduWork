#!/usr/bin/env bash
# Executed only inside a disposable container, with read-only package/check mounts.
set -euo pipefail
test -f /.dockerenv
phase=${1:?prepare or verify}
kind=${2:?deb rpm tgz}
package=${3:?package}
version=${4:?version}
old_package=${5:?pinned old package}
old_version=${6:?old version}
case "$kind" in deb|rpm|tgz) ;; *) exit 64 ;; esac
profile=/home/acceptance/soduwork-acceptance-profile-main
archive_root=${package##*/}
archive_root=${archive_root%.tar.gz}
if [ "$phase" = prepare ]; then
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o Acquire::Retries=2 -o APT::Update::Error-Mode=any update
    if [ "$kind" = deb ]; then apt-get install -y --no-install-recommends "$package"
    else
      apt-get install -y --no-install-recommends libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libuuid1 libsecret-1-0 libgbm1 libasound2
    fi
  else dnf install -y "$package"; fi
  if [ "$kind" = tgz ]; then
    mkdir /opt/acceptance
    tar -xzf "$package" -C /opt/acceptance
    app=/opt/acceptance/$archive_root
  else app=/opt/SoduWork; fi
  test -x "$app/soduwork"
  printf '%s\n' "$app" > /acceptance-app
  ldd "$app/soduwork" > /evidence/electron-ldd.txt
  if grep -q 'not found' /evidence/electron-ldd.txt; then cat /evidence/electron-ldd.txt; exit 1; fi
  if command -v apt-get >/dev/null; then
    apt-get install -y --no-install-recommends xvfb xauth dbus-x11 gnome-keyring fonts-noto-cjk procps util-linux
  else dnf install -y xorg-x11-server-Xvfb xorg-x11-xauth dbus-x11 gnome-keyring google-noto-sans-cjk-ttc-fonts procps-ng util-linux; fi
  useradd -m -o -u "${SODUWORK_ACCEPT_UID:-12001}" acceptance
  mkdir -p "$profile"
  chown -R acceptance:acceptance /home/acceptance /evidence
  exit 0
fi
test "$phase" = verify
app=$(cat /acceptance-app)
if [ "$kind" = deb ]; then dpkg-query -W -f='${Version}\n' soduwork > /evidence/package-version.txt
elif [ "$kind" = rpm ]; then rpm -q --qf '%{VERSION}-%{RELEASE}\n' soduwork > /evidence/package-version.txt; fi
if [ "$kind" != tgz ]; then
  grep -F "$version" /evidence/package-version.txt
  grep -F /opt/SoduWork/soduwork /usr/share/applications/soduwork.desktop
  test "$(find /usr/share/icons/hicolor -type f -name soduwork.png | wc -l)" -ge 8
fi
runuser -u acceptance -- env ELECTRON_RUN_AS_NODE=1 "$app/soduwork" -e 'console.log(process.versions)' > /evidence/node-runtime.txt
runuser -u acceptance -- env SODUWORK_DATA_ROOT="$profile/runner" SODUWORK_BUNDLED_NODE="$app/soduwork" \
  SODUWORK_BUNDLED_PI_CLI="$app/resources/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" SODUWORK_SKILL_ROOTS="$app/resources/skills" \
  timeout 90 "$app/resources/runner/soduwork-runner" --doctor > /evidence/runner-doctor.json 2> /evidence/runner-doctor.log
runuser -u acceptance -- env ELECTRON_RUN_AS_NODE=1 "$app/soduwork" -e \
  'const r=require("/evidence/runner-doctor.json");if(!r.ok||!r.frozen||!r.terminal.ok||!r.skills.length)process.exit(1);'
test -x "$profile/runner/node-shim/node"
runuser -u acceptance -- env PATH="$profile/runner/node-shim:/usr/bin:/bin" node --version > /evidence/node-shim-version.txt
smoke() {
  runuser -u acceptance -- env ELECTRON_RUN_AS_NODE=1 SODUWORK_ACCEPTANCE_CONTAINER=1 \
    dbus-run-session -- bash -euc '
      mkdir -p "$HOME/.local/share/keyrings"
      printf "%s" "soduwork-acceptance-fixture" | gnome-keyring-daemon --unlock --components=secrets
      exec xvfb-run -a "$@"
    ' -- "$app/soduwork" /checks/ci/installed-client-smoke.cjs "$app/soduwork" "$app" "$profile" "/evidence/$1.json" "$2" "$3"
}
smoke fresh "$version" write
smoke restart "$version" read
if [ "$kind" = deb ]; then apt-get remove -y soduwork
elif [ "$kind" = rpm ]; then rpm -e soduwork
else rm -rf -- "$app"; fi
test ! -e "$app/soduwork"
test "$(cat "$profile/acceptance-sentinel.txt")" = preserve-install-acceptance-data
upgraded=false
reinstalled=true
accepted_old_version=
if [ "$old_package" != - ]; then
  upgraded=true
  reinstalled=false
  accepted_old_version=$old_version
  profile=/home/acceptance/soduwork-acceptance-profile-upgrade
  runuser -u acceptance -- mkdir "$profile"
  if [ "$kind" = deb ]; then dpkg -i "$old_package"; app=/opt/SoduWork
  elif [ "$kind" = rpm ]; then rpm -i "$old_package"; app=/opt/SoduWork
  else tar -xzf "$old_package" -C /opt/acceptance; app=/opt/acceptance/SoduWork-$old_version-linux; fi
  smoke old "$old_version" write
  if [ "$kind" = deb ]; then dpkg -i --force-confnew "$package"; app=/opt/SoduWork
  elif [ "$kind" = rpm ]; then rpm -U "$package"; app=/opt/SoduWork
  else tar -xzf "$package" -C /opt/acceptance; rm -rf -- "$app"; app=/opt/acceptance/$archive_root; fi
else
  if [ "$kind" = deb ]; then dpkg -i "$package"; app=/opt/SoduWork
  elif [ "$kind" = rpm ]; then rpm -i "$package"; app=/opt/SoduWork
  else tar -xzf "$package" -C /opt/acceptance; app=/opt/acceptance/$archive_root; fi
fi
smoke restored "$version" read
if [ "$kind" = deb ]; then apt-get remove -y soduwork
elif [ "$kind" = rpm ]; then rpm -e soduwork
else rm -rf -- "$app"; fi
test ! -e "$app/soduwork"
if [ "$kind" != tgz ]; then
  test ! -e /usr/share/applications/soduwork.desktop
  test "$(find /usr/share/icons/hicolor -type f -name soduwork.png | wc -l)" -eq 0
fi
test "$(cat "$profile/acceptance-sentinel.txt")" = preserve-install-acceptance-data
printf '{"ok":true,"version":"%s","oldVersion":"%s","upgraded":%s,"reinstalled":%s,"nodeShimExecutable":true}\n' "$version" "$accepted_old_version" "$upgraded" "$reinstalled" > /evidence/result.json
