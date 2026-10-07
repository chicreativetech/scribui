import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Environment for build commands: Android Studio's bundled JDK when JAVA_HOME
 * is unset or older than 17 (current Gradle needs 17+), and the chosen device.
 */
export function buildEnv(serial?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const jbr = [
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    join(homedir(), "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
  ].find((p) => existsSync(p));
  if (jbr && (!env.JAVA_HOME || javaMajor(env.JAVA_HOME) < 17)) env.JAVA_HOME = jbr;
  if (serial) env.ANDROID_SERIAL = serial;
  return env;
}

/** Major Java version from a JDK's release file (0 when unknown). */
function javaMajor(home: string): number {
  let release = "";
  try {
    release = readFileSync(join(home, "release"), "utf8");
  } catch {
    /* no release file */
  }
  const v = /JAVA_VERSION="(\d+)(?:\.(\d+))?/.exec(release);
  if (!v) return 0;
  return v[1] === "1" ? Number(v[2] ?? 0) : Number(v[1]);
}
