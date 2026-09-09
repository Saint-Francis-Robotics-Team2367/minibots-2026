/**
 * detectOS() against injected navigator shapes.
 *
 * This fits the harness for the same reason serial.test.mjs does: detectOS takes
 * its navigator as a parameter, so the test hands it a plain object rather than
 * needing a DOM. mountDriverHelp is not covered here — it is DOM construction,
 * and testing it would mean pulling in jsdom, which the no-dependency rule in
 * README.md rules out.
 *
 * The cases that matter are the wrong ones. A student on a Mac must never be
 * shown a Windows driver download first, because installing a vendor kext on a
 * modern Mac conflicts with Apple's own and can break a machine that worked. And
 * an unrecognised platform must not silently fall through to Windows.
 */

const { detectOS } = await import("../js/drivers.js");

let pass = 0;
const fail = [];

/** @param {string} what @param {unknown} nav @param {string} want */
function check(what, nav, want) {
  let got;
  try {
    got = detectOS(nav);
  } catch (err) {
    fail.push(`${what}: threw ${err.message}`);
    return;
  }
  if (got === want) {
    pass++;
  } else {
    fail.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

/* userAgentData is the modern signal and is preferred. Chromium reports these
   exact strings, and Web Serial is Chromium-only, so this is the usual path. */
check("userAgentData Windows", { userAgentData: { platform: "Windows" } }, "windows");
check("userAgentData macOS", { userAgentData: { platform: "macOS" } }, "mac");
check("userAgentData Linux", { userAgentData: { platform: "Linux" } }, "other");
check("userAgentData Chrome OS", { userAgentData: { platform: "Chrome OS" } }, "other");
check("userAgentData Android", { userAgentData: { platform: "Android" } }, "other");

/* navigator.platform is the fallback: deprecated, but still what older and some
   frozen builds report. */
check("platform Win32", { platform: "Win32" }, "windows");
check("platform Win64", { platform: "Win64" }, "windows");
check("platform MacIntel", { platform: "MacIntel" }, "mac");
check("platform MacPPC", { platform: "MacPPC" }, "mac");
check("platform Linux x86_64", { platform: "Linux x86_64" }, "other");
check("platform Linux armv8l", { platform: "Linux armv8l" }, "other");

/* Windows on ARM reports as Windows, which is the right answer rather than a
   near miss: the driver zip ships arm and arm64 builds beside x86 and x64. */
check("Windows on ARM", { userAgentData: { platform: "Windows" }, platform: "Win32" }, "windows");

/* userAgentData wins when the two disagree, since platform is the deprecated one. */
check(
  "userAgentData preferred over platform",
  { userAgentData: { platform: "macOS" }, platform: "Win32" },
  "mac",
);

/* Nothing usable must degrade to "other" rather than guessing Windows, and must
   never throw — a thrown error here would take the whole page's wiring with it. */
check("empty object", {}, "other");
check("null navigator", null, "other");
/* Note: passing an explicit `undefined` is NOT the same case — it triggers the
   default parameter and reads the ambient navigator, which is the behaviour the
   browser call site depends on. Node 21+ supplies its own navigator (platform
   "MacIntel" here), so asserting a fixed answer for it would only assert what OS
   the test happens to run on. `null` is the way to test a genuinely absent one,
   since null does not trigger a default. */
check("empty platform string", { platform: "" }, "other");
check("userAgentData present but empty", { userAgentData: {} }, "other");
check("platform not a string", { platform: 42 }, "other");
check("garbage platform", { platform: "SomeFutureOS" }, "other");

/* Case must not matter: the check lowercases first, and a build reporting
   "WIN32" or "darwin" should still land correctly. */
check("uppercase WIN32", { platform: "WIN32" }, "windows");
check("darwin", { platform: "darwin" }, "mac");

const total = pass + fail.length;
if (fail.length) {
  console.error(`detectOS: ${pass}/${total} passed\n`);
  for (const f of fail) {
    console.error(`  FAIL ${f}`);
  }
  process.exit(1);
}
console.log(`detectOS: ${pass}/${total} passed`);
