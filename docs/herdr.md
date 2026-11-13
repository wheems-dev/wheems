# The Herdr runtime driver

Herdr core runs programs in persistent terminals that people can attach to and take over. Its
command is `hc`. Wheems's runtime driver, `herdr`, is the only part of Wheems that talks to it.

## One module calls hc

[`src/drivers/runtime/herdr/hc.ts`](../src/drivers/runtime/herdr/hc.ts) is the only file that
runs `hc`. An ESLint rule refuses `child_process` imports anywhere else in `src/`. The module:

- always passes `--json` and parses the result against a schema, failing with `bad_output` if
  `hc` prints a shape this version of Wheems does not know;
- passes terminal addresses and text after `--`, so text that looks like an option is sent as
  text;
- starts sessions with `--bg --no-parent --no-notify`, so they belong to no terminal and outlive
  the command that started them;
- turns `hc`'s own errors (`{"error": {"kind", "message", "hint"}}` on stderr) into `HcError`,
  which the driver maps to `DriverError` kinds.

The only text it reads is `hc --version`, which has no JSON form.

[`herdr-runtime.ts`](../src/drivers/runtime/herdr/herdr-runtime.ts) implements the runtime
contract on top of it. Session ids are `hc` addresses such as `t7` or `machine/t7`.

## Version pin

The driver refuses to run against an `hc` older than `HERDR_MINIMUM_VERSION` (0.1.20): the
first call checks `hc --version` and fails with `DriverError` `version`. `install.yaml` can raise
the minimum with `herdr.version`, never lower it. `wheems doctor` also checks that the running
core, not just the installed binary, meets the minimum.

## Doctor

`wheems doctor` checks that `hc` is installed, new enough and answering, then makes a round trip:
it starts a tiny shell session labelled `wheems=doctor`, sends it a line, waits for it to exit,
reads the reply and removes the session. `--quick` skips the round trip.

## Testing without touching your terminals

The tests never use your own Herdr core. Where `hc` is installed, the runtime contract suite runs
against a core of its own: `HC_SESSION` and the `XDG_*` folders point at a temporary folder, and
the suite stops that core afterwards. The folder is kept short because `hc`'s socket path must
fit in 103 bytes on macOS. Set `WHEEMS_TEST_HC=0` to skip these tests.

Where `hc` is not installed (such as CI), the same contract suite runs against
[`test/helpers/fake-hc.mjs`](../test/helpers/fake-hc.mjs), a stand-in that keeps terminals in a
JSON file and simulates an echo program and a long-running one.

## Open questions

- Herdr core's licence is not yet confirmed; the Herdr desktop app is Apache 2.0, as is Wheems.
- How Herdr publishes releases (download links per version, an install script or Homebrew)
  decides how `wheems setup` installs the pinned version, and whether CI can run the real `hc`.
- Herdr is young and will change, which is why every call goes through one module and the
  version is pinned.
