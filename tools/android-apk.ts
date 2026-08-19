/**
 * Build the Android APK.
 *
 * Two machine-specific things get in the way of a bare `./gradlew assembleDebug`
 * and are handled here rather than left in a README step: the Android SDK
 * location (Gradle needs `sdk.dir` or `ANDROID_HOME`, and `local.properties` is
 * git-ignored), and the JDK, because a system default of JDK 11 is too old for
 * a modern Android Gradle Plugin and the failure it produces says nothing
 * useful.
 *
 *   npm run android:apk            # debug APK
 *   npm run android:apk -- <task>  # any other Gradle task, e.g. lint, test
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = resolve(ROOT, 'android');

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------- sdk */

function findSdk(): string {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Android/Sdk'),
    join(homedir(), 'Library/Android/sdk'),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'platforms'))) return candidate;
  }
  return fail(
    'No Android SDK found. Set ANDROID_HOME, or install the SDK at ~/Android/Sdk.\n' +
      `Looked in: ${candidates.join(', ')}`,
  );
}

function writeLocalProperties(sdk: string): void {
  const path = join(ANDROID, 'local.properties');
  const line = `sdk.dir=${sdk}`;
  if (existsSync(path) && readFileSync(path, 'utf8').includes(line)) return;
  writeFileSync(
    path,
    `# Machine-specific, git-ignored. Written by tools/android-apk.ts.\n${line}\n`,
  );
  console.log(`wrote android/local.properties -> ${sdk}`);
}

/* ------------------------------------------------------------------- jdk */

function javaMajor(home: string): number {
  const binary = join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!existsSync(binary)) return 0;
  const probe = spawnSync(binary, ['-version'], { encoding: 'utf8' });
  const text = `${probe.stderr ?? ''}${probe.stdout ?? ''}`;
  const match = /version "(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return 0;
  const major = Number(match[1]);
  return major === 1 ? Number(match[2] ?? 0) : major;
}

function findJdk(): string {
  if (process.env.JAVA_HOME && javaMajor(process.env.JAVA_HOME) >= 17) return process.env.JAVA_HOME;

  const roots = [join(homedir(), 'Android/jdk'), '/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
  const seen: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry);
      if (!statSync(candidate).isDirectory()) continue;
      seen.push(candidate);
      // macOS layout nests the real home one level down.
      for (const home of [candidate, join(candidate, 'Contents/Home')]) {
        if (javaMajor(home) >= 17) return home;
      }
    }
  }
  return fail(
    'No JDK 17 or newer found. The Android Gradle Plugin needs one; a system\n' +
      'JDK 11 is too old. Set JAVA_HOME to a JDK 17+.\n' +
      `Looked in: ${roots.join(', ')}${seen.length ? `\nSaw: ${seen.join(', ')}` : ''}`,
  );
}

/* ----------------------------------------------------------------- build */

const tasks = process.argv.slice(2);
const gradleTasks = tasks.length > 0 ? tasks : ['assembleDebug'];

const sdk = findSdk();
writeLocalProperties(sdk);
const jdk = findJdk();
console.log(`SDK ${sdk}\nJDK ${jdk} (Java ${javaMajor(jdk)})\n`);

const gradlew = join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
if (!existsSync(gradlew)) fail(`missing ${gradlew}`);

const result = spawnSync(gradlew, gradleTasks, {
  cwd: ANDROID,
  stdio: 'inherit',
  env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk },
});
if (result.status !== 0) process.exit(result.status ?? 1);

const apk = join(ANDROID, 'app/build/outputs/apk/debug/app-debug.apk');
if (existsSync(apk)) {
  const mb = (statSync(apk).size / 1e6).toFixed(1);
  console.log(`\nAPK ${apk}\n    ${mb} MB\n\nInstall it with:\n    adb install -r ${apk}`);
}
